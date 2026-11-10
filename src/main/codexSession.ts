import { explainError } from "./errors.js";
import { codexCost } from "./codexPrices.js";
import { Codex, type ModelReasoningEffort, type Thread, type ThreadItem, type UserInput } from "@openai/codex-sdk";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Session, clip, promptWithFiles, summarizeArgs, type SessionHost } from "./session.js";

const firstLine = (s: string) => {
  const l = s.split("\n").find((x) => x.trim()) ?? "";
  return l.length > 36 ? `${l.slice(0, 35)}…` : l;
};
import type { SessionMeta, TranscriptItem } from "../shared/types.js";

/**
 * A thread archived in the Codex app can't be resumed ("session … is archived"). Imported threads live on in Happy,
 * so bring them back (best effort) before resuming. Archiving is how you'd stop the Codex app from holding the thread.
 */
function unarchiveIfNeeded(threadId: string) {
  try {
    const db = join(homedir(), ".codex", "state_5.sqlite");
    const archived = execFileSync("sqlite3", ["-readonly", db, `select archived from threads where id = '${threadId.replace(/[^\w-]/g, "")}'`], { encoding: "utf8", timeout: 3000 }).trim();
    if (archived !== "1") return;
    const pkg = createRequire(import.meta.url).resolve("@openai/codex-darwin-arm64/package.json");
    execFileSync(join(dirname(pkg), "vendor", "aarch64-apple-darwin", "bin", "codex"), ["unarchive", threadId], { timeout: 15_000, stdio: "ignore" });
  } catch {}
}

/** Optional MCP endpoint (Happy's browser tools) wired into this session's Codex config. */
export interface CodexMcp {
  url: string;
  token: string;
}

/**
 * Codex runs headless (codex exec): no interactive approvals, so it runs in a
 * workspace-write sandbox with approvals off. Messages sent mid-turn are queued.
 */
export class CodexSession extends Session {
  private thread?: Thread;
  private queue: Array<{ text: string; images?: string[]; files?: string[] }> = [];
  private abort?: AbortController;

  private codex: Codex;

  constructor(meta: SessionMeta, items: TranscriptItem[], host: SessionHost, mcp?: CodexMcp) {
    super(meta, items, host);
    this.codex = new Codex({
      env: { ...(process.env as Record<string, string>), ...(mcp ? { SESSION_HUB_TOKEN: mcp.token } : {}) },
      config: mcp
        ? {
            mcp_servers: {
              // Headless exec can't answer approval prompts, so tools from our own server are pre-approved.
              browser: { url: mcp.url, bearer_token_env_var: "SESSION_HUB_TOKEN", default_tools_approval_mode: "approve" },
            },
          }
        : undefined,
    });
  }

  private abs(p: string) {
    return isAbsolute(p) ? p : resolve(this.meta.cwd, p);
  }

  private threadKey?: string;

  /**
   * The repo's shared .git dir. In a worktree it lives in the main checkout — outside the sandboxed workspace —
   * so Codex needs it as an extra writable directory to commit, branch, or merge.
   */
  private gitCommonDir(): string | undefined {
    try {
      return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: this.meta.cwd, encoding: "utf8", timeout: 5000 }).trim();
    } catch {
      return undefined;
    }
  }

  private getThread(): Thread {
    // Re-open (resume) the thread when the model changed since it was created.
    const key = `${this.meta.model}|${this.meta.effort}|${this.meta.codexSandbox}`;
    if (this.thread && this.threadKey === key) return this.thread;
    this.threadKey = key;
    const opts = {
      workingDirectory: this.meta.cwd,
      skipGitRepoCheck: true,
      sandboxMode: (this.meta.codexSandbox ?? "workspace-write") as "read-only" | "workspace-write" | "danger-full-access",
      approvalPolicy: "never" as const,
      model: this.meta.model,
      modelReasoningEffort: this.meta.effort as ModelReasoningEffort | undefined,
      additionalDirectories: [this.gitCommonDir()].filter((d): d is string => !!d),
    };
    if (this.meta.engineSessionId) unarchiveIfNeeded(this.meta.engineSessionId);
    this.thread = this.meta.engineSessionId
      ? this.codex.resumeThread(this.meta.engineSessionId, opts)
      : this.codex.startThread(opts);
    return this.thread;
  }

  private itemStart = new Map<string, number>();
  /** Codex numbers items item_0, item_1… afresh every turn; prefix with a per-turn key so turns don't overwrite each other. */
  private turnKey = "";

  private applyItem(raw: ThreadItem, final: boolean) {
    const item = { ...raw, id: `${this.turnKey}:${raw.id}` } as ThreadItem;
    if (!this.itemStart.has(item.id)) this.itemStart.set(item.id, Date.now());
    const durationMs = final ? Date.now() - this.itemStart.get(item.id)! : undefined;
    switch (item.type) {
      case "agent_message":
        if (item.text.trim()) this.upsertItem(item.id, { kind: "assistant", text: item.text });
        return;
      case "reasoning":
        if (item.text.trim()) this.upsertItem(item.id, { kind: "thinking", text: item.text });
        return;
      case "command_execution":
        this.upsertItem(item.id, {
          kind: "tool",
          tool: "shell",
          text: item.command,
          detail: clip(item.aggregated_output || ""),
          durationMs,
          result: item.exit_code != null ? `exit ${item.exit_code}` : undefined,
          status: item.status === "in_progress" ? "running" : item.status === "failed" ? "failed" : "done",
        });
        return;
      case "file_change":
        this.upsertItem(item.id, {
          kind: "tool",
          tool: "patch",
          text: item.changes.map((c) => `${c.kind} ${c.path}`).join(", "),
          status: item.status === "failed" ? "failed" : "done",
          path: item.changes[0] ? this.abs(item.changes[0].path) : undefined,
          durationMs,
        });
        return;
      case "mcp_tool_call": {
        const existing = this.items.find((i) => i.id === item.id);
        const images =
          final && !existing?.images && item.result
            ? (item.result.content as any[])
                .filter((c) => c?.type === "image" && c.data)
                .map((c) => this.host.media.save(c.data, c.mimeType))
            : existing?.images;
        this.upsertItem(item.id, {
          images: images?.length ? images : undefined,
          kind: "tool",
          tool: `${item.server}.${item.tool}`,
          text: summarizeArgs(item.arguments),
          detail: item.error
            ? item.error.message
            : item.result
              ? clip(
                  (item.result.content as any[])
                    .map((c) => (c?.type === "text" ? c.text : `[${c?.type}]`))
                    .join("\n"),
                )
              : undefined,
          status: item.status === "in_progress" ? "running" : item.status === "failed" ? "failed" : "done",
          durationMs,
          result: item.error
            ? "error"
            : item.result
              ? (item.result.content as any[]).some((c) => c?.type === "image")
                ? "image"
                : firstLine(((item.result.content as any[]).find((c) => c?.type === "text")?.text as string) ?? "")
                    .replace(/^Now at: .*? — https?:\/\//, "")
              : undefined,
        });
        return;
      }
      case "web_search":
        this.upsertItem(item.id, { kind: "tool", tool: "web_search", text: item.query, status: final ? "done" : "running" });
        return;
      case "todo_list":
        // Codex's plan shows in the chat's reminders/follow-ups card.
        this.update({ agentTodos: item.items.map((t) => ({ text: t.text, status: t.completed ? "completed" : "pending" })) });
        return;
      case "error":
        {
          const e = explainError(item.message, "codex");
          this.upsertItem(item.id, { kind: "error", text: e.hint ? `${e.title}\n${e.hint}` : e.title, detail: item.message });
        }
        return;
    }
  }

  /** Bumped on every interrupt so a stale loop (e.g. a Codex process that ignores the abort) can't touch state. */
  private runId = 0;
  private running = false;

  private async runLoop() {
    const myRun = ++this.runId;
    this.running = true;
    this.setStatus("running");
    const live = () => this.runId === myRun;
    while (live() && this.queue.length) {
      const { images, files } = this.queue[0];
      const text = promptWithFiles(this.queue.shift()!.text, files);
      const input: string | UserInput[] = images?.length
        ? [...(text ? [{ type: "text" as const, text }] : []), ...images.map((path) => ({ type: "local_image" as const, path }))]
        : text;
      const abort = (this.abort = new AbortController());
      this.turnKey = `t${Date.now().toString(36)}`;
      // Watchdog: surface a silent Codex instead of looking stuck forever.
      let lastEvent = Date.now();
      let warned = false;
      const watchdog = setInterval(() => {
        if (live() && !warned && Date.now() - lastEvent > 120_000) {
          warned = true;
          this.addItem({ kind: "error", text: "Codex hasn't produced any output for 2 minutes.\nPress Stop to cancel this turn, or keep waiting." });
        }
      }, 10_000);
      try {
        const { events } = await this.getThread().runStreamed(input, { signal: abort.signal });
        for await (const ev of events) {
          if (!live()) break;
          lastEvent = Date.now();
          switch (ev.type) {
            case "thread.started":
              this.meta.engineSessionId = ev.thread_id;
              this.touch();
              break;
            case "item.started":
            case "item.updated":
              this.applyItem(ev.item, false);
              break;
            case "item.completed":
              this.applyItem(ev.item, true);
              break;
            case "turn.completed": {
              const u = ev.usage;
              const d = u ? u.input_tokens - (u.cached_input_tokens ?? 0) + u.output_tokens : 0;
              this.tokens = (this.tokens ?? 0) + d;
              // Codex reports tokens, not cost: estimate the API-equivalent from the price table.
              const cost = u ? codexCost(this.meta.model, u) : 0;
              this.costUsd = (this.costUsd ?? 0) + cost;
              this.host.recordUsage(d, cost, "codex");
              this.host.codexTurnDone();
              break;
            }
            case "turn.failed":
              this.engineError(ev.error.message);
              break;
            case "error":
              this.engineError(ev.message);
              break;
          }
        }
      } catch (err) {
        if (!live() || abort.signal.aborted) break;
        clearInterval(watchdog);
        this.running = false;
        this.fail((err as Error).message);
        return;
      } finally {
        clearInterval(watchdog);
      }
    }
    if (!live()) return; // interrupt() already reset state
    this.running = false;
    for (const it of this.items) if (it.status === "running") it.status = "failed";
    this.setStatus("idle");
  }

  async send(text: string, images?: string[], files?: string[], echo = true) {
    if (echo) this.userItem(text, images, files);
    this.lastError = undefined;
    this.queue.push({ text, images, files });
    if (!this.running) void this.runLoop();
  }

  protected onCwdChanged() {
    this.thread = undefined;
  }

  /** Applies from the next turn: the thread is re-opened (resumed) with the new model. */
  async setModel(model: string | undefined) {
    this.meta.model = model;
    this.touch();
  }

  /** Stop now: abort the process, drop anything queued before the stop, and free the session immediately. */
  async interrupt() {
    if (!this.running) return;
    this.runId++;
    this.running = false;
    this.queue = [];
    this.abort?.abort();
    this.thread = undefined; // next turn re-opens the thread cleanly
    for (const it of this.items) if (it.status === "running") it.status = "failed";
    this.addItem({ kind: "system", text: "Interrupted" });
    this.setStatus("idle");
  }

  dispose() {
    this.runId++;
    this.running = false;
    this.queue = [];
    this.abort?.abort();
  }
}
