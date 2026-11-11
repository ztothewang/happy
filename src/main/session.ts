import { existsSync } from "node:fs";
import { isCheckAnswer } from "./nextSteps.js";
import { randomUUID } from "node:crypto";
import { explainError } from "./errors.js";
import type { MediaStore } from "./media.js";
import type {
  PermissionDecision,
  PermissionExtra,
  PermissionRequest,
  SessionMeta,
  SessionState,
  QueuedMessage,
  SessionStatus,
  TranscriptItem,
} from "../shared/types.js";

const MAX_ITEMS = 1000;
const MAX_DETAIL = 8000;

export function clip(s: string, n = MAX_DETAIL): string {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s;
}

/** Append attached file paths so the agent reads them itself (works the same for Claude and Codex). */
export function promptWithFiles(text: string, files?: string[]): string {
  if (!files?.length) return text;
  const list = files.map((f) => `- ${f}`).join("\n");
  return `${text}${text ? "\n\n" : ""}Attached files (read them as needed):\n${list}`;
}

/** One-line summary of tool arguments: the field a human cares about, else compact JSON. */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["url", "command", "query", "file_path", "path", "pattern", "description", "expression", "text", "key"]) {
    if (typeof a[k] === "string" && a[k]) return a[k] as string;
  }
  if (typeof a.ref === "number") return `element [${a.ref}]`;
  if (typeof a.x === "number" && typeof a.y === "number") return `at ${a.x}, ${a.y}`;
  if (typeof a.dy === "number") return `${a.dy > 0 ? "down" : "up"} ${Math.abs(a.dy)}px`;
  const json = JSON.stringify(a);
  return json === "{}" ? "" : clip(json, 200);
}

/** One-line result for a finished tool call, shown in the tool table. */
export function summarizeResult(tool: string, output: string, isError: boolean): string {
  if (isError) return "error";
  const lines = output.split("\n").filter((l) => l.trim());
  const name = tool.replace(/^mcp__browser__/, "browser.");
  if (/^(Read)$/.test(name)) return `${lines.length} lines`;
  if (/^(Grep|Glob)$/.test(name)) return lines.length ? `${lines.length} hits` : "no hits";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "";
  if (name === "browser.screenshot") return "image";
  if (name.startsWith("browser.")) {
    const m = output.match(/Now at: .*? — (\S+)/);
    if (m) return m[1].replace(/^https?:\/\//, "").slice(0, 40);
  }
  const last = lines[lines.length - 1] ?? "";
  return last.length > 36 ? `${last.slice(0, 35)}…` : last;
}

export interface SessionHost {
  /** Called whenever observable state changes. */
  changed(session: Session): void;
  /** Add to today's usage totals (per engine). */
  recordUsage(tokens: number, costUsd: number, engine: "claude" | "codex" | "cursor"): void;
  /** Plan-limit updates reported by an engine. */
  recordClaudeLimit(info: { rateLimitType?: string; utilization?: number; resetsAt?: number; status?: string }): void;
  /** Exact plan windows from the SDK's usage call (0–100 utilization). */
  recordClaudeUsage(windows: Array<{ key: string; utilization: number | null; resetsAt?: number }>): void;
  codexTurnDone(): void;
  media: MediaStore;
  /** Where a session continues when its own folder is gone (the main repo). */
  fallbackCwd(): string;
  /** Claude Code's model list for your account, from a live session (cached for the pickers). */
  learnClaudeModels?(list: Array<{ value: string; displayName: string; resolvedModel?: string }>): void;
  /** Every permission prompt, for "why does it keep asking?". */
  logPermission?(session: Session, tool: string, input: Record<string, unknown>, reason?: string): void;
}

/** Engine-agnostic session: owns transcript + status; engines fill it in. */
export abstract class Session {
  meta: SessionMeta;
  status: SessionStatus = "idle";
  items: TranscriptItem[];
  pending?: PermissionRequest;
  costUsd?: number;
  tokens?: number;
  activeMs = 0;
  turnStartedAt?: number;
  /** Live background tasks (Claude) — merged with OS processes by the hub. */
  tasks = new Map<string, { id: string; label: string; kind?: string; status?: string; startedAt: number }>();
  osProcesses: import("../shared/types.js").SessionProcess[] = [];
  /** Small engine-specific counters persisted with the session. */
  engineState: Record<string, number> = {};
  lastError?: string;

  private permissionWaiters = new Map<string, (d: PermissionDecision, extra?: PermissionExtra) => void>();
  private idleWaiters: Array<() => void> = [];

  constructor(meta: SessionMeta, items: TranscriptItem[], protected host: SessionHost) {
    this.meta = meta;
    // Errors saved before plain-language cards existed: keep the raw text as details.
    for (const it of items)
      if (it.kind === "error" && !it.detail && /^(Turn ended|API error|Codex error|Claude session crashed|Cursor error)/.test(it.text)) {
        const e = explainError(it.text, meta.engine);
        it.detail = it.text;
        it.text = e.hint ? `${e.title}\n${e.hint}` : e.title;
      }
    this.items = items;
  }

  /** Send a user message, optionally with image / file attachments (absolute paths). */
  abstract send(text: string, images?: string[], files?: string[], echo?: boolean): Promise<void>;

  /** While a worktree is being set up, messages are shown immediately but delivered once the agent can start. */
  private held: Array<{ text: string; images?: string[]; files?: string[] }> | null = null;

  hold() {
    this.held = [];
  }

  get holding() {
    return this.held !== null;
  }

  /** Show the message now; deliver it now, or later if the session is still being prepared. */
  /**
   * A worktree can be deleted out from under a session (merged and cleaned up). Then the engine can't start in it
   * ("No such file or directory"), so continue in the main repo, keeping the conversation.
   */
  protected ensureCwd() {
    if (existsSync(this.meta.cwd)) return;
    const gone = this.meta.cwd;
    const next = this.host.fallbackCwd();
    this.meta.cwd = next;
    if (this.meta.worktree && this.meta.worktree.path === gone) this.meta.worktree = { ...this.meta.worktree, removed: true };
    this.note(`worktree folder ${gone.replace(/^\/Users\/[^/]+/, "~")} is gone; continuing in ${next.replace(/^\/Users\/[^/]+/, "~")}`);
    this.onCwdChanged();
    this.touch();
  }

  /** Engines that cache the working directory (e.g. an open Codex thread) reset it here. */
  protected onCwdChanged() {}

  /** Suggested next messages for the latest reply, and which reply they're for. */
  nextSteps?: import("../shared/types.js").NextStep[];
  nextStepsFor?: string;

  /** A tag check changed this session's tags: show it as a small line in the transcript. */
  noteTags(added: string[], removed: string[]) {
    this.addItem({ kind: "tags", text: [added.length && `added ${added.map((t) => `#${t}`).join(" ")}`, removed.length && `removed ${removed.map((t) => `#${t}`).join(" ")}`].filter(Boolean).join(" · "), tagsAdded: added, tagsRemoved: removed });
  }

  /**
   * A hidden turn: the message goes to the agent like any other (so it has the whole session as context, and the
   * exchange stays in its history), but neither it nor the reply is added to the transcript, and the session keeps
   * showing as idle. Messages you send meanwhile queue and go right after.
   */
  private hiddenTurn?: { texts: Map<string, string>; failed?: boolean; done(text: string | undefined): void };
  /** Background work the agent started (shells, subagents) is still running: the agent may wake up on its own when it ends. */
  get hasLiveTasks() {
    return [...this.tasks.values()].some((t) => !t.status || t.status === "running" || t.status === "pending" || t.status === "paused");
  }

  askHidden(prompt: string, timeoutMs = 90_000): Promise<string | undefined> {
    if (this.status !== "idle" || this.hiddenTurn || this.held || this.hasLiveTasks) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const finish = (text: string | undefined) => {
        clearTimeout(timer);
        if (this.hiddenTurn?.done === finish) this.hiddenTurn = undefined;
        resolve(text);
      };
      const timer = setTimeout(() => {
        finish(undefined);
        if (this.status === "idle" && this.queued.length && !this.holdFlush) this.flushQueued();
        this.touch();
      }, timeoutMs);
      this.hiddenTurn = { texts: new Map(), done: finish };
      this.send(prompt, undefined, undefined, false).catch(() => finish(undefined));
    });
  }

  private clearNextSteps() {
    if (this.nextSteps) this.nextSteps = undefined;
  }

  async post(text: string, images?: string[], files?: string[]) {
    this.clearNextSteps();
    this.ensureCwd();
    if (this.held) {
      this.userItem(text, images, files);
      this.held.push({ text, images, files });
      return;
    }
    // While a turn runs, messages wait in a queue you can edit, take back, or push through ("send now").
    if (this.status === "running" || this.status === "needs_permission" || this.hiddenTurn) {
      this.queued.push({ id: randomUUID(), text, images: images?.length ? images : undefined, files: files?.length ? files : undefined, at: Date.now() });
      this.touch();
      return;
    }
    await this.send(text, images, files);
  }

  /** Show `text` as your message, but deliver it with `context` prepended (e.g. the board you're looking at). */
  async sendWithContext(text: string, context: string) {
    this.clearNextSteps();
    this.ensureCwd();
    this.userItem(text);
    if (this.held) return void this.held.push({ text: `${context}\n\n${text}` });
    await this.send(`${context}\n\n${text}`, undefined, undefined, false);
  }

  queued: QueuedMessage[] = [];
  /** Engines that accept a message mid-turn (Claude's streaming input) steer instead of stopping for "send now". */
  protected steers = false;
  private holdFlush = false;

  editQueued(id: string, text: string) {
    const m = this.queued.find((q) => q.id === id);
    if (!m) throw new Error("Already sent");
    m.text = text;
    this.touch();
  }

  removeQueued(id: string) {
    this.queued = this.queued.filter((q) => q.id !== id);
    this.touch();
  }

  async sendQueuedNow(id: string) {
    const i = this.queued.findIndex((q) => q.id === id);
    if (i < 0) throw new Error("Already sent");
    const [m] = this.queued.splice(i, 1);
    this.touch();
    if (this.status === "running" && !this.steers) {
      this.holdFlush = true;
      try {
        await this.interrupt();
      } finally {
        this.holdFlush = false;
      }
    }
    await this.send(m.text, m.images, m.files);
  }

  /** Stop pressed: end the turn but keep queued messages waiting (they go after your next message's turn, or via send now). */
  async stopTurn() {
    this.holdFlush = true;
    try {
      await this.interrupt();
    } finally {
      this.holdFlush = false;
    }
  }

  /** Next queued message once the turn ends. */
  private flushQueued() {
    if (this.holdFlush || !this.queued.length || this.status !== "idle" || this.hiddenTurn) return;
    const m = this.queued.shift()!;
    this.touch();
    this.ensureCwd();
    void this.send(m.text, m.images, m.files);
  }

  /** Deliver everything held while preparing (already shown in the transcript). */
  async release() {
    const msgs = this.held ?? [];
    this.held = null;
    for (const m of msgs) await this.send(m.text, m.images, m.files, false);
  }
  abstract setModel(model: string | undefined): Promise<void>;
  /** Reasoning effort; engines that don't support it just record it. */
  async setEffort(effort: string | undefined) {
    this.update({ effort });
  }
  abstract interrupt(): Promise<void>;
  abstract dispose(): void;

  get id() {
    return this.meta.id;
  }

  snapshot(): SessionState {
    return {
      ...this.meta,
      status: this.hiddenTurn ? "idle" : this.status,
      items: this.items.some((i) => i.kind === "assistant" && isCheckAnswer(i.text)) ? (this.items = this.items.filter((i) => !(i.kind === "assistant" && isCheckAnswer(i.text)))) : this.items,
      pending: this.pending,
      costUsd: this.costUsd,
      tokens: this.tokens,
      activeMs: this.activeMs,
      turnStartedAt: this.turnStartedAt,
      lastError: this.lastError,
      queued: this.queued.length ? this.queued : undefined,
      nextSteps: this.status === "idle" && !this.hiddenTurn ? this.nextSteps : undefined,
      processes: [
        ...[...this.tasks.values()]
          .filter((t) => !t.status || t.status === "running" || t.status === "pending" || t.status === "paused")
          .map((t) => ({ source: "task" as const, id: t.id, label: t.label, kind: t.kind, status: t.status ?? "running", startedAt: t.startedAt })),
        ...this.osProcesses,
      ],
    };
  }

  protected touch() {
    this.meta.updatedAt = Date.now();
    this.host.changed(this);
  }

  protected setStatus(status: SessionStatus) {
    if (this.hiddenTurn) {
      // Out of sight: no status change, no active time; when it ends, hand back what the agent said.
      this.status = status;
      if (status === "running") return;
      const h = this.hiddenTurn;
      // Engines can report "idle" for the turn that just ended after the hidden one has started; only the hidden
      // turn's own end (it answered, or failed) counts.
      if (!h.texts.size && !h.failed) return;
      h.done([...h.texts.values()].join("\n").trim() || undefined);
      if (status === "idle" && this.queued.length && !this.holdFlush) setTimeout(() => this.flushQueued(), 0);
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
      this.touch();
      return;
    }
    if (this.status === status) return;
    this.status = status;
    // Active time: a turn runs from first "running" until idle/error (permission waits included).
    if (status === "running") this.turnStartedAt ??= Date.now();
    else if ((status === "idle" || status === "error") && this.turnStartedAt) {
      this.activeMs += Date.now() - this.turnStartedAt;
      this.turnStartedAt = undefined;
    }
    if (status === "idle" && this.queued.length && !this.holdFlush) setTimeout(() => this.flushQueued(), 0);
    if (status !== "running") {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
    this.touch();
  }

  /** Resolves once the session is no longer running (idle, error, or waiting on a permission). */
  waitUntilSettled(): Promise<void> {
    if (this.status !== "running") return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  protected addItem(item: Omit<TranscriptItem, "id" | "ts"> & { id?: string }) {
    const full: TranscriptItem = { id: item.id ?? randomUUID(), ts: Date.now(), ...item };
    if (this.hiddenTurn) {
      if (full.kind === "assistant") this.hiddenTurn.texts.set(full.id, full.text);
      // It should only answer; if it starts using tools, stop the turn rather than let it act out of sight.
      if (full.kind === "tool") {
        this.hiddenTurn.failed = true;
        void this.stopTurn().catch(() => {});
      }
      if (full.kind === "error") this.hiddenTurn.failed = true;
      return full;
    }
    // Never show a next-steps answer as a reply (e.g. one that arrived after its hidden turn timed out).
    if (full.kind === "assistant" && isCheckAnswer(full.text)) return full;
    this.items.push(full);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    this.touch();
    return full;
  }

  protected upsertItem(id: string, patch: Omit<TranscriptItem, "id" | "ts">) {
    if (this.hiddenTurn) {
      if (patch.kind === "assistant") this.hiddenTurn.texts.set(id, patch.text);
      return;
    }
    if (patch.kind === "assistant" && isCheckAnswer(patch.text)) return;
    const existing = this.items.find((i) => i.id === id);
    if (existing) {
      Object.assign(existing, patch);
      this.touch();
    } else {
      this.addItem({ id, ...patch });
    }
  }

  protected patchItem(id: string, patch: Partial<TranscriptItem>) {
    const existing = this.items.find((i) => i.id === id);
    if (!existing) return;
    Object.assign(existing, patch);
    this.touch();
  }

  /** An engine error as a plain-language card; the raw text is kept in `detail`. */
  protected engineError(raw: string) {
    const e = explainError(raw, this.meta.engine);
    return this.addItem({ kind: "error", text: e.hint ? `${e.title}\n${e.hint}` : e.title, detail: raw });
  }

  protected fail(message: string) {
    const e = explainError(message, this.meta.engine);
    this.lastError = e.title;
    this.addItem({ kind: "error", text: e.hint ? `${e.title}\n${e.hint}` : e.title, detail: message });
    this.setStatus("error");
  }

  /** Surface a permission prompt to the UI and wait for the user's answer. */
  protected askPermission(tool: string, input: Record<string, unknown>, reason: string | undefined, signal: AbortSignal) {
    const requestId = randomUUID();
    this.pending = { requestId, sessionId: this.id, tool, input, reason };
    this.host.logPermission?.(this, tool, input, reason);
    this.setStatus("needs_permission");
    return new Promise<{ decision: PermissionDecision; extra?: PermissionExtra }>((resolve) => {
      const done = (d: PermissionDecision, extra?: PermissionExtra) => {
        this.permissionWaiters.delete(requestId);
        if (this.pending?.requestId === requestId) this.pending = undefined;
        this.setStatus("running");
        resolve({ decision: d, extra });
      };
      this.permissionWaiters.set(requestId, done);
      signal.addEventListener("abort", () => done("deny"), { once: true });
    });
  }

  respondPermission(requestId: string, decision: PermissionDecision, extra?: PermissionExtra): boolean {
    const w = this.permissionWaiters.get(requestId);
    if (!w) return false;
    const req = this.pending?.requestId === requestId ? this.pending : undefined;
    if (req) this.recordAnswer(req, decision, extra);
    w(decision, extra);
    return true;
  }

  /** Answers to questions and plan reviews go into the transcript as your messages. */
  private recordAnswer(req: PermissionRequest, decision: PermissionDecision, extra?: PermissionExtra) {
    if (req.tool === "AskUserQuestion") {
      if (decision === "deny" || !extra?.answers) return this.addItem({ kind: "user", text: "(skipped the question)" });
      const lines = Object.entries(extra.answers).map(([q, a]) => `${q}\n→ ${a}`);
      this.addItem({ kind: "user", text: lines.join("\n\n") });
    } else if (req.tool === "ExitPlanMode") {
      this.addItem({
        kind: "user",
        text: decision === "deny" ? (extra?.feedback ? `Requested plan changes: ${extra.feedback}` : "Keep planning") : "Approved the plan",
      });
    }
  }

  /** Set a field on one transcript item (e.g. a simplified rewrite). */
  setItemField(itemId: string, patch: Partial<TranscriptItem>) {
    this.patchItem(itemId, patch);
  }

  /** Add an error line to the transcript (always visible). */
  addError(text: string) {
    this.addItem({ kind: "error", text });
  }

  /** Add a system note to the transcript. */
  note(text: string) {
    this.addItem({ kind: "system", text });
  }

  protected userItem(text: string, images?: string[], files?: string[]) {
    this.addItem({ kind: "user", text, images: images?.length ? images : undefined, files: files?.length ? files : undefined });
  }

  /** Stop a background task (engines that support it override). */
  async stopTask(_taskId: string): Promise<void> {}

  /** Let the host mutate meta fields (tags, group…) and notify observers. */
  update(patch: Partial<SessionMeta>) {
    Object.assign(this.meta, patch);
    this.touch();
  }
}
