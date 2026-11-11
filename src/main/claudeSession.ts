import {
  query,
  type McpServerConfig,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mimeFor } from "./media.js";
import { Session, clip, promptWithFiles, summarizeArgs, summarizeResult, type SessionHost } from "./session.js";
import type { ClaudePermissionMode, SessionMeta, TranscriptItem } from "../shared/types.js";

/** Minimal async queue used as the streaming-input prompt for query(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  /** `later`: wait for any turn in progress (including one the agent starts on its own) instead of interrupting it. */
  push(content: SDKUserMessage["message"]["content"], priority?: SDKUserMessage["priority"]) {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
    } as SDKUserMessage;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: msg, done: false });
    } else this.buf.push(msg);
  }

  close() {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const v = this.buf.shift();
        if (v) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => (this.waiter = res));
      },
    };
  }
}

export interface ClaudeExtras {
  mcpServers?: Record<string, McpServerConfig>;
  appendSystemPrompt?: string;
  /** Tools that never prompt (e.g. the manager's own hub tools). */
  autoAllow?: (tool: string, input: Record<string, unknown>) => boolean;
  /** Tool-name pattern that asks the user in every mode, bypass included (e.g. sending email). */
  alwaysAsk?: string;
  /** Calls that ask the user in every mode, bypass included (e.g. gcloud commands that change prod). */
  mustAsk?: (tool: string, input: Record<string, unknown>) => boolean;
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  switch (name) {
    case "Bash":
      return s("command") ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return s("file_path") ?? s("notebook_path") ?? "";
    case "Grep":
    case "Glob":
      return [s("pattern"), s("path")].filter(Boolean).join("  in ");
    case "WebFetch":
      return s("url") ?? "";
    case "WebSearch":
      return s("query") ?? "";
    case "Agent":
    case "Task":
      return s("description") ?? "";
    default:
      return summarizeArgs(input);
  }
}

/** Internal plumbing tools that add noise to the transcript. */
const HIDDEN_TOOLS = new Set(["ToolSearch", "AskUserQuestion", "ExitPlanMode", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((c: any) => c?.type !== "image")
      .map((c: any) => (c?.type === "text" ? c.text : `[${c?.type}]`))
      .join("\n");
  return JSON.stringify(content);
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

let modelsAsked = false;

export class ClaudeSession extends Session {
  protected steers = true;

  private q?: Query;
  private input?: InputQueue;
  private abort?: AbortController;
  private hiddenToolIds = new Set<string>();
  /** Running totals last reported by query() (persisted: a resumed session continues from them). */
  private get lastCumTokens() {
    return this.engineState.cumTokens ?? 0;
  }
  private set lastCumTokens(v: number) {
    this.engineState.cumTokens = v;
  }
  private get lastCumCost() {
    return this.engineState.cumCost ?? 0;
  }
  private set lastCumCost(v: number) {
    this.engineState.cumCost = v;
  }

  constructor(meta: SessionMeta, items: TranscriptItem[], host: SessionHost, private extras: ClaudeExtras = {}) {
    super(meta, items, host);
  }

  private start() {
    // A fresh session starts its running totals at 0; a resumed one continues from the saved transcript's.
    if (!this.meta.engineSessionId) {
      this.lastCumTokens = 0;
      this.lastCumCost = 0;
    }
    this.input = new InputQueue();
    this.abort = new AbortController();
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.meta.cwd,
        model: this.meta.model,
        resume: this.meta.forkOf ?? this.meta.engineSessionId,
        // A fork starts from the original conversation and gets its own id (the original is untouched).
        forkSession: this.meta.forkOf ? true : undefined,
        abortController: this.abort,
        // Load ~/.claude + project CLAUDE.md/settings exactly like the CLI does.
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code", append: this.extras.appendSystemPrompt },
        permissionMode: this.meta.permissionMode ?? "default",
        allowDangerouslySkipPermissions: true,
        mcpServers: this.extras.mcpServers,
        // Questions and plan approvals go to the user in every permission mode (canUseTool is skipped under bypass).
        hooks: {
          PreToolUse: [
            {
              matcher: "AskUserQuestion|ExitPlanMode",
              hooks: [
                async (hookInput: any, _id: string | undefined, { signal }: { signal: AbortSignal }) => {
                  const tool = hookInput.tool_name as string;
                  const input = (hookInput.tool_input ?? {}) as Record<string, unknown>;
                  const { decision, extra } = await this.askPermission(tool, input, undefined, signal);
                  const out = (permissionDecision: "allow" | "deny", reason?: string, updatedInput?: Record<string, unknown>) => ({
                    hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision, permissionDecisionReason: reason, updatedInput },
                  });
                  if (tool === "AskUserQuestion") {
                    if (decision === "deny" || !extra?.answers) return out("deny", "The user dismissed the question without answering.");
                    return out("allow", undefined, { ...input, answers: extra.answers });
                  }
                  // ExitPlanMode
                  if (decision === "deny") return out("deny", extra?.feedback ? `The user wants changes to the plan: ${extra.feedback}` : "The user rejected the plan. Keep planning.");
                  return out("allow");
                },
              ],
            },
            ...(this.extras.mustAsk
              ? [
                  {
                    hooks: [
                      async (hookInput: any, _id: string | undefined, { signal }: { signal: AbortSignal }) => {
                        const tool = hookInput.tool_name as string;
                        const input = (hookInput.tool_input ?? {}) as Record<string, unknown>;
                        if (!this.extras.mustAsk!(tool, input)) return {};
                        const { decision } = await this.askPermission(tool, input, "Changes production: always asks", signal);
                        return {
                          hookSpecificOutput: {
                            hookEventName: "PreToolUse" as const,
                            permissionDecision: decision === "deny" ? ("deny" as const) : ("allow" as const),
                            permissionDecisionReason: decision === "deny" ? "The user declined this change." : undefined,
                          },
                        };
                      },
                    ],
                  },
                ]
              : []),
            ...(this.extras.alwaysAsk
              ? [
                  {
                    matcher: this.extras.alwaysAsk,
                    hooks: [
                      async (hookInput: any, _id: string | undefined, { signal }: { signal: AbortSignal }) => {
                        const { decision } = await this.askPermission(hookInput.tool_name as string, (hookInput.tool_input ?? {}) as Record<string, unknown>, "This always asks first", signal);
                        return {
                          hookSpecificOutput: {
                            hookEventName: "PreToolUse" as const,
                            permissionDecision: decision === "deny" ? ("deny" as const) : ("allow" as const),
                            permissionDecisionReason: decision === "deny" ? "The user declined." : undefined,
                          },
                        };
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
        canUseTool: async (tool, input, opts): Promise<PermissionResult> => {
          if (this.extras.autoAllow?.(tool, input)) return { behavior: "allow", updatedInput: input };
          const { decision } = await this.askPermission(tool, input, opts.decisionReason as string | undefined, opts.signal);
          if (decision === "deny") return { behavior: "deny", message: "User denied this action." };
          return {
            behavior: "allow",
            updatedInput: input,
            updatedPermissions: decision === "allow_always" ? opts.suggestions : undefined,
          };
        },
      },
    });
    void this.pump(this.q);
    // The models your account can use, for the pickers (once per launch is plenty).
    if (!modelsAsked) {
      modelsAsked = true;
      const q = this.q;
      void q
        .supportedModels()
        .then((list) => this.host.learnClaudeModels?.(list))
        .catch(() => (modelsAsked = false));
    }
  }

  private async pump(q: Query) {
    try {
      for await (const msg of q) this.handle(msg);
      // Stream ended (input closed or process exited). Next send restarts with resume.
      if (this.q === q) this.q = undefined;
      if (this.status === "running") this.setStatus("idle");
    } catch (err) {
      if (this.q === q) this.q = undefined;
      if (this.abort?.signal.aborted) this.setStatus("idle");
      else this.fail(`Claude session crashed: ${(err as Error).message}`);
    }
  }

  private handle(msg: SDKMessage) {
    // Anything the agent does counts as activity; only the result message ends a turn (see turnSettled).
    if (msg.type === "result") this.turnEndedAt = Date.now();
    else if (msg.type === "assistant" || msg.type === "user" || msg.type === "stream_event" || msg.type === "tool_progress") this.activityAt = Date.now();
    // Subagent traffic is summarized by the parent's Agent tool item; skip the inner chatter.
    if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) return;

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          if (this.meta.engineSessionId !== msg.session_id || this.meta.forkOf) {
            this.meta.engineSessionId = msg.session_id;
            this.meta.forkOf = undefined;
            this.touch();
          }
          if (!this.meta.model) this.meta.model = msg.model;
        } else if (msg.subtype === "session_state_changed") {
          if (msg.state === "running") (this.activityAt = Date.now()), this.setStatus("running");
          else if (msg.state === "idle" && this.status !== "needs_permission") this.setStatus("idle");
        } else if (msg.subtype === "background_tasks_changed") {
          // Authoritative list of live background tasks (shells, subagents, monitors); skip ambient watchers.
          const live = new Map<string, { id: string; label: string; kind?: string; status?: string; startedAt: number }>();
          for (const t of (msg as any).tasks ?? []) {
            if (t.ambient) continue;
            const prev = this.tasks.get(t.task_id);
            live.set(t.task_id, { id: t.task_id, label: t.description, kind: t.task_type, status: prev?.status ?? "running", startedAt: prev?.startedAt ?? Date.now() });
          }
          // A background task that just ended wakes the agent for a turn of its own: that counts as activity.
          if ([...this.tasks.keys()].some((id) => !live.has(id))) this.activityAt = Date.now();
          this.tasks = live;
          this.touch();
        } else if (msg.subtype === "task_started") {
          const m = msg as any;
          if (m.is_backgrounded !== false) {
            this.tasks.set(m.task_id, { id: m.task_id, label: m.description, kind: m.task_type, status: "running", startedAt: Date.now() });
            this.touch();
          }
        } else if (msg.subtype === "task_updated") {
          const m = msg as any;
          const t = this.tasks.get(m.task_id);
          if (t && m.patch?.status) {
            if (!["running", "pending", "paused"].includes(m.patch.status)) this.activityAt = Date.now();
            t.status = m.patch.status;
            this.touch();
          }
        } else if (msg.subtype === "task_notification") {
          const m = msg as any;
          this.activityAt = Date.now();
          if (this.tasks.delete(m.task_id)) this.touch();
        } else if (msg.subtype === "compact_boundary") {
          this.addItem({ kind: "system", text: "Conversation compacted" });
        }
        return;

      case "assistant": {
        if (msg.error === "authentication_failed")
          this.addItem({
            kind: "error",
            text: "Claude Code isn't logged in (or the login expired). Open a terminal, run `claude`, then `/login` — Happy uses that same login.",
          });
        else if (msg.error) this.engineError(`API error: ${msg.error}`);
        for (const block of msg.message.content as any[]) {
          if (block.type === "text" && block.text.trim()) {
            this.addItem({ kind: "assistant", text: block.text });
          } else if (block.type === "thinking" && block.thinking?.trim()) {
            this.addItem({ kind: "thinking", text: block.thinking });
          } else if (block.type === "tool_use" && HIDDEN_TOOLS.has(block.name)) {
            if (this.hiddenToolIds.has(block.id)) continue; // seen already (a message can arrive more than once)
            this.hiddenToolIds.add(block.id);
            // Claude's task list shows in the chat's reminders/follow-ups card instead.
            const todos = (block.input as { todos?: Array<{ content?: string; status?: string }> })?.todos;
            if (block.name === "TodoWrite" && Array.isArray(todos))
              this.update({
                agentTodos: todos.map((t) => ({ text: String(t.content ?? ""), status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending" })),
              });
            // Newer Claude Code: TaskCreate adds one task (ids count up from 1 per session), TaskUpdate changes one.
            const inp = (block.input ?? {}) as { subject?: string; taskId?: string | number; status?: string };
            const status = (v?: string) => (v === "completed" ? "completed" : v === "in_progress" ? "in_progress" : "pending") as "completed" | "in_progress" | "pending";
            if (block.name === "TaskCreate" && inp.subject) {
              const list = this.meta.agentTodos ?? [];
              this.update({ agentTodos: [...list, { id: String(list.length + 1), text: String(inp.subject), status: "pending" }] });
            }
            if (block.name === "TaskUpdate" && inp.taskId != null) {
              const id = String(inp.taskId);
              const list = this.meta.agentTodos ?? [];
              this.update({
                agentTodos:
                  inp.status === "deleted"
                    ? list.filter((t) => t.id !== id)
                    : list.map((t) => (t.id === id ? { ...t, status: inp.status ? status(inp.status) : t.status, text: inp.subject ? String(inp.subject) : t.text } : t)),
              });
            }
          } else if (block.type === "tool_use") {
            const input = (block.input ?? {}) as Record<string, unknown>;
            const rawPath = (input.file_path ?? input.notebook_path) as string | undefined;
            const path =
              FILE_TOOLS.has(block.name) && rawPath ? (isAbsolute(rawPath) ? rawPath : resolve(this.meta.cwd, rawPath)) : undefined;
            const diff =
              block.name === "Edit" && typeof input.old_string === "string"
                ? { before: input.old_string, after: String(input.new_string ?? "") }
                : block.name === "Write" && typeof input.content === "string"
                  ? { before: "", after: input.content }
                  : undefined;
            this.addItem({
              id: block.id,
              kind: "tool",
              tool: block.name,
              text: summarizeToolInput(block.name, input),
              detail: diff ? undefined : clip(JSON.stringify(input, null, 2)),
              status: "running",
              path,
              diff: diff && { before: clip(diff.before, 200_000), after: clip(diff.after, 200_000) },
            });
          }
        }
        return;
      }

      case "user": {
        const content = (msg.message as any).content;
        if (!Array.isArray(content)) return; // our own prompt echo
        for (const block of content) {
          if (block.type !== "tool_result" || this.hiddenToolIds.has(block.tool_use_id)) continue;
          const out = clip(toolResultText(block.content));
          const item = this.items.find((i) => i.id === block.tool_use_id);
          const images = Array.isArray(block.content)
            ? block.content
                .filter((c: any) => c?.type === "image" && c.source?.type === "base64")
                .map((c: any) => this.host.media.save(c.source.data, c.source.media_type))
            : [];
          const raw = toolResultText(block.content);
          this.patchItem(block.tool_use_id, {
            durationMs: item ? Date.now() - item.ts : undefined,
            result: item?.tool ? summarizeResult(item.tool, raw, !!block.is_error) || undefined : undefined,
            status: block.is_error ? "failed" : "done",
            detail: item?.detail ? `${item.detail}\n\n── result ──\n${out}` : out,
            images: images.length ? images : undefined,
          });
        }
        return;
      }

      case "rate_limit_event":
        this.host.recordClaudeLimit(msg.rate_limit_info);
        return;

      case "result": {
        const cumTokens = Object.values(msg.modelUsage ?? {}).reduce(
          (n, u) => n + u.inputTokens + u.cacheCreationInputTokens + u.outputTokens,
          0,
        );
        const cumCost = msg.total_cost_usd ?? 0;
        const dTok = cumTokens >= this.lastCumTokens ? cumTokens - this.lastCumTokens : cumTokens;
        const dCost = cumCost >= this.lastCumCost ? cumCost - this.lastCumCost : cumCost;
        this.lastCumTokens = cumTokens;
        this.lastCumCost = cumCost;
        this.tokens = (this.tokens ?? 0) + dTok;
        this.costUsd = (this.costUsd ?? 0) + dCost;
        this.host.recordUsage(dTok, dCost, "claude");
        if (msg.subtype !== "success") {
          const errs = "errors" in msg && msg.errors?.length ? msg.errors.join("; ") : msg.subtype;
          this.engineError(`Turn ended: ${errs}`);
        }
        // Any tool still "running" at end of turn was interrupted.
        for (const it of this.items) if (it.status === "running") it.status = "failed";
        this.setStatus("idle");
        void this.fetchPlanUsage();
        return;
      }
    }
  }

  /** Exact plan utilization via the SDK's (experimental) usage call; silently skipped if unavailable. */
  async fetchPlanUsage() {
    const q = this.q as any;
    const fn = q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== "function") return;
    try {
      const r = await fn.call(q, { skipBehaviors: true });
      const rl = r?.rate_limits;
      if (!r?.rate_limits_available || !rl) return;
      const windows = (["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const)
        .filter((k) => rl[k])
        .map((k) => ({ key: k, utilization: rl[k].utilization ?? null, resetsAt: rl[k].resets_at ? Date.parse(rl[k].resets_at) : undefined }));
      if (windows.length) this.host.recordClaudeUsage(windows);
    } catch {
      /* experimental API changed or unavailable */
    }
  }

  async send(text: string, images?: string[], files?: string[], echo = true) {
    if (echo) this.userItem(text, images, files);
    text = promptWithFiles(text, files);
    this.lastError = undefined;
    if (!this.q) this.start();
    this.setStatus("running");
    if (!images?.length) return this.input!.push(text);
    this.input!.push([
      ...images.map((p) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: mimeFor(p) as "image/png", data: readFileSync(p).toString("base64") },
      })),
      ...(text ? [{ type: "text" as const, text }] : []),
    ]);
  }

  /** Hidden checks queue behind whatever the agent is doing, so they can never cut a turn off. */
  protected async sendHidden(prompt: string) {
    this.lastError = undefined;
    if (!this.q) this.start();
    this.setStatus("running");
    this.input!.push(prompt, "later");
  }

  async interrupt() {
    if (!this.q) return;
    try {
      await this.q.interrupt();
    } catch {
      this.abort?.abort();
    }
    this.addItem({ kind: "system", text: "Interrupted" });
    this.setStatus("idle");
  }

  async setModel(model: string | undefined) {
    this.meta.model = model;
    this.touch();
    if (this.q) await this.q.setModel(model).catch(() => {});
  }

  async stopTask(taskId: string) {
    await this.q?.stopTask(taskId).catch(() => {});
  }

  async setPermissionMode(mode: ClaudePermissionMode) {
    this.meta.permissionMode = mode;
    this.touch();
    if (this.q) await this.q.setPermissionMode(mode).catch(() => {});
  }

  dispose() {
    this.input?.close();
    this.abort?.abort();
    this.q = undefined;
  }

  /**
   * Moved to a new folder (its worktree was deleted): Claude Code keeps a session's history under a per-folder
   * project directory, so copy it across and restart the query so the next message resumes there.
   */
  protected onCwdChanged() {
    const id = this.meta.engineSessionId;
    if (id) {
      const dir = (cwd: string) => join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      try {
        const from = readdirSync(join(homedir(), ".claude", "projects"))
          .map((d) => join(homedir(), ".claude", "projects", d, `${id}.jsonl`))
          .find((f) => existsSync(f));
        if (from) {
          mkdirSync(dir(this.meta.cwd), { recursive: true });
          const to = join(dir(this.meta.cwd), `${id}.jsonl`);
          if (!existsSync(to)) copyFileSync(from, to);
        }
      } catch {}
    }
    this.input?.close();
    this.q = undefined;
  }
}
