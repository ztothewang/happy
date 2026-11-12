import { randomUUID } from "node:crypto";
import { demo } from "./demo.js";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSdkMcpServer, listSessions, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { BrowserManager } from "./browser.js";
import { claudeBrowserServer, isReadOnlyBrowserTool, type BrowserMcpHttp } from "./browserTools.js";
import { ClaudeSession } from "./claudeSession.js";
import { CodexSession } from "./codexSession.js";
import { CursorSession } from "./cursorSession.js";
import { GitWatch } from "./gitWatch.js";
import { claudeWindow, readCodexLimits, readCodexModels, readCursorTier } from "./limits.js";
import { annotate } from "./briefing.js";
import { Linear, taskPrompt } from "./linear.js";
import { PostHog } from "./analytics.js";
import { Gmail } from "./gmail.js";
import { settings } from "./settings.js";
import { Calendar } from "./calendar.js";
import { ContactBook } from "./contacts.js";
import { draftReply, me, style, triage, who, draftNew } from "./assist.js";
import { boardContext, isReadOnlyGcloud, tenantCloud } from "./cloud.js";
import { gcloudStatus } from "./gcloudAuth.js";
import { projectConfig } from "./projectConfig.js";
import { checkPrompt, isCheckAnswer, parseCheck } from "./nextSteps.js";
import { crossTenantGroups, landedOnMain, lastCommitSubject, projectErrors, tenantProjects } from "./overview.js";
import { listProcesses, within } from "./processes.js";
import { MediaStore } from "./media.js";
import { readClaudeHistory } from "./importClaude.js";
import { listRoutines, routineRuns } from "./routines.js";
import { listCodexThreads, readCodexHistory } from "./importCodex.js";
import { computeStats } from "./stats.js";
import { refreshCodexPrices } from "./codexPrices.js";
import { claudeTitle, codexIndexTitle, generateTitle, simplifyText, titleFromPrompt } from "./titles.js";
import { createWorktree, dirtyPaths, removeWorktree } from "./worktree.js";
import { Session, clip, type SessionHost } from "./session.js";
import { deployedParts, isDeployed, isSystemSession } from "../shared/types.js";
import type {
  RoutineRun,
  ClaudePermissionMode,
  CloudSnapshot,
  EmailThread,
  EmailThreadDetail,
  Inbox,
  TriageRun,
  Engine,
  TaskList,
  LinearIssue,
  TaskScope,
  CodexSandbox,
  CursorMode,
  CreateSessionInput,
  ExternalClaudeSession,
  LinkedWorktree,
  RepoWorktree,
  PermissionDecision,
  PermissionExtra,
  SessionGroup,
  SessionMeta,
  SessionState,
  TranscriptItem,
  UsageTotals,
  EngineLimits,
  Overview,
  OverviewSessionRef,
  OverviewUnfinished,
  SessionProcess,
  CodexThreadInfo,
  CloudSpawnInput,
  SessionTodo,
  HappyStats,
} from "../shared/types.js";

interface Persisted {
  sessions: Array<{
    meta: SessionMeta;
    items: TranscriptItem[];
    costUsd?: number;
    tokens?: number;
    activeMs?: number;
    engineState?: Record<string, number>;
  }>;
  groups?: SessionGroup[];
  /** yyyy-mm-dd → totals (also per engine under "<date>|claude" / "<date>|codex") */
  usage?: Record<string, UsageTotals>;
  limits?: EngineLimits;
}

const today = () => new Date().toLocaleDateString("en-CA");

/** Copy a Codex thread's rollout under a new id so the copy can be resumed on its own; undefined if not found. */
function forkCodexRollout(threadId: string): string | undefined {
  const root = join(homedir(), ".codex", "sessions");
  const find = (dir: string): string | undefined => {
    for (const e of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const hit = find(p);
        if (hit) return hit;
      } else if (e.name.endsWith(`${threadId}.jsonl`)) return p;
    }
    return undefined;
  };
  const src = find(root);
  if (!src) return undefined;
  const id = randomUUID();
  const lines = readFileSync(src, "utf8").split("\n");
  lines[0] = lines[0].split(threadId).join(id);
  writeFileSync(join(dirname(src), basename(src).replace(threadId, id)), lines.join("\n"));
  return id;
}
const order = (label: string) => ["5h", "week", "week opus", "week sonnet"].indexOf(label) + 1 || 9;

const MANAGER_PROMPT = `
# You are the Happy manager

You run inside Happy, a desktop app where the user works with many Claude Code and Codex sessions at once.
Your job is to dispatch and supervise those sessions — not to do the coding yourself.

- Use the mcp__hub__* tools to list, create, message, read, wait on, and interrupt sessions.
- Give each new session a self-contained prompt: goal, repo path (cwd), branch/worktree expectations, done-criteria,
  and "finish with a 3-line summary of what you did and anything you need from me".
- Default engine is "claude". Use "codex" or "cursor" when the user asks, or for an independent second attempt/review.
- Code-changing sessions get their own branch + worktree (create_session worktree: true, the default). Use worktree: false only
  for read-only questions (logs, data lookups, explanations).
- When asked for status: read each active session and reply with a compact table (session · status · one-line state),
  then anything blocked or waiting on a permission prompt, quoted verbatim. Don't paste transcripts.
- The user sees an overview board next to this chat. Its items carry refs: A# active, D# done in the last 24h,
  M# needs merging, E# production errors. When the user mentions a ref (or asks about "the board", errors,
  what's unmerged, what got done), call get_overview first — it's cached and cheap — and resolve refs from it.
- Sessions waiting on a permission prompt need the USER to approve in the UI — tell them which session and what it's asking.
- Don't instruct sessions to push, deploy, merge, delete data, or send external messages unless the user explicitly said to.
`;

/** An environment's display name from the main repo's project config ("eu" → "Europe"). */
const envName = (id: string) => projectConfig(settings().repo).environments?.find((e) => e.id === id)?.name ?? id;

/** True when a candidate title is just one of your messages (or its start). */
function echoesUser(title: string, items: TranscriptItem[]): boolean {
  const t = title.trim().toLowerCase();
  return items.some((i) => i.kind === "user" && i.text.trim().toLowerCase().startsWith(t.replace(/…$/, "")));
}

/** "duplicate-calendar-event-constraint-viol" → "Duplicate calendar event constraint viol". */
const titleFromBranch = (b: string) => {
  const w = b.replace(/^[\w-]+\//, "").replace(/[-_]+/g, " ").trim();
  return w ? w[0].toUpperCase() + w.slice(1) : "";
};

/** The Mail chat's standing instructions (built per session so they pick up your profile and writing style). */
function emailPrompt() {
  return `
You are the Mail assistant inside Happy, ${who()}'s desktop app. You work on their Gmail through the mcp__mail__* tools:
list_inbox / read_thread to read; archive, star, mark_read, report_spam, always_archive_sender and draft_reply to act
(these run immediately, so do what's asked without asking again); send_draft sends, and the user approves every send.
Never send unless they clearly asked for that specific email to go out.

Each message may include <open-email thread_id=…>: the thread they have open. "this", "reply", "archive it" mean that one.

Zero inbox: list the inbox, then for each thread decide archive / keep / reply:
- archive: nothing for ${me()} to do now (FYIs, notifications, newsletters, receipts, finished threads, threads where
  ${me()} replied last and is waiting).
- reply: someone is waiting on ${me()}.
- keep: needs to stay visible (deadline, event, something to read or do soon). Starred threads are keep unless finished.
Archive the archive group in one call, then show what's left: reply (with who's waiting and why) and keep, one line each.

When drafting, follow these rules:
${style()}

Be brief: lead with the answer. Refer to emails by sender and subject, not ids. Times in the user's local time.
`;
}

const CLOUD_PROMPT = `
You are the Cloud assistant inside Happy, the user's desktop app for running coding agents. You sit next to the Cloud
dashboard, which shows live Google Cloud state for each environment of the project: Cloud Run services and jobs, Cloud Scheduler
crons, Cloud Tasks queues, Cloud SQL (with Query Insights' slowest queries), Firebase auth health, and error logs.

Every user message starts with a <board>…</board> block: the board the user is looking at right now, as text. Items in
"Needs attention" have refs like C1, C2; the user may refer to them that way. Answer from the board first.

When the board isn't enough, investigate with read-only gcloud commands (list, describe, logging read, etc.) using the
project ids on the board. You may read the repo in your working directory to connect an error to code.

Changing cloud resources (deploys, updates, deletes, job runs, cron pauses/resumes, SQL writes, IAM, secrets) is fine when
the user asks for it: first say exactly what will change, in which project and service, and the command(s); then run them
one at a time. Prefer the smallest reversible change, and after a change, verify it with a read-only command.

Be brief: lead with the answer, then the evidence (counts, times, the exact error or query). Times in the user's local time.
`;

const BROWSER_PROMPT = `
# Happy browser
You have a real browser shown live to the user in Happy's side pane, via the mcp__browser__* tools
(navigate, read_page, screenshot, click, type, press_key, scroll, evaluate, console_logs, back).
Use it whenever a task involves a web page the user would want to see: testing a local dev server, checking a deployed app,
reading docs, or reproducing a UI bug. Prefer read_page (text + element refs) for navigating and screenshot for visual checks.
When you change a file or produce an image the user should look at, mention its absolute path — the user can click it to preview.
`;

export class Hub implements SessionHost {
  readonly media: MediaStore;
  private sessions = new Map<string, Session>();
  private groupList: SessionGroup[] = [];
  private usage: Record<string, UsageTotals> = {};
  private limitState: EngineLimits = {};
  private overviewCache?: Overview;
  private overviewBusy?: Promise<Overview>;
  private overviewTimer?: NodeJS.Timeout;
  private cloudCache?: CloudSnapshot;
  private cloudBusy?: Promise<CloudSnapshot>;
  private cloudTimer?: NodeJS.Timeout;
  readonly linear: Linear;
  readonly posthog: PostHog;
  readonly gmail: Gmail;
  readonly calendar: Calendar;
  readonly contacts: ContactBook;
  private inboxCache?: Inbox;
  private inboxBusy?: Promise<Inbox>;
  private inboxTimer?: NodeJS.Timeout;
  triageRun?: TriageRun;
  private triageFile: string;
  private taskCache = new Map<TaskScope, TaskList>();
  private taskBusy = new Map<TaskScope, Promise<TaskList>>();
  private taskTimer?: NodeJS.Timeout;
  /** Claude's one-liners keyed by stable id (session id / worktree path / error key) + the content they describe. */
  private summaries = new Map<string, { text: string; basis: string }>();
  private headline?: string;
  private annotatedAt = 0;
  private annotating = false;
  private procTimer?: NodeJS.Timeout;
  private routineTimer?: NodeJS.Timeout;
  private limitTimer?: NodeJS.Timeout;
  private gitChecked = new Map<string, number>();
  private gitWatch = new GitWatch();
  private gitTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private file: string;

  constructor(
    dataDir: string,
    private emit: {
      update(s: SessionState): void;
      removed(id: string): void;
      groups(g: SessionGroup[]): void;
      usage(u: UsageTotals): void;
      limits(l: EngineLimits): void;
      overview(o: Overview): void;
      cloud(c: CloudSnapshot): void;
      tasks(t: TaskList): void;
      inbox(i: Inbox): void;
      triage(r: TriageRun | null): void;
      reminder(s: SessionState, t: SessionTodo): void;
    },
    private browsers: BrowserManager,
    private browserHttp: BrowserMcpHttp,
    openAuthWindow: (url: string, title: string) => { close(): void } = () => ({ close() {} }),
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.media = new MediaStore(dataDir);
    this.linear = new Linear(dataDir);
    this.posthog = new PostHog(dataDir);
    this.gmail = new Gmail(dataDir, openAuthWindow);
    this.calendar = new Calendar(this.gmail);
    this.contacts = new ContactBook(dataDir, this.gmail);
    this.triageFile = join(dataDir, "zero-inbox.json");
    try {
      if (existsSync(this.triageFile)) this.triageRun = JSON.parse(readFileSync(this.triageFile, "utf8"));
      // A run interrupted by quitting can't resume; mark it so you can start over.
      if (this.triageRun?.status === "running") this.triageRun = { ...this.triageRun, status: "error", error: "Happy quit before Claude finished; start over." };
    } catch {}
    this.file = join(dataDir, "hub-state.json");
    this.load();
    if (![...this.sessions.values()].some((s) => s.meta.isManager)) {
      this.createSession({ engine: "claude", cwd: homedir(), title: "Manager" }, true);
    }
    this.startGitSweep();
    if (demo) {
      // Demo: each chat's state (next steps, a running turn) comes from the file.
      for (const s of this.sessions.values()) {
        const t = s.meta.title;
        if (demo.nextSteps?.[t]) (s.nextSteps = demo.nextSteps[t]), (s.nextStepsFor = s.items.at(-1)?.id);
        if (demo.status?.[t]) (s as unknown as { status: string }).status = demo.status[t];
      }
    } else {
      void this.refreshCodexLimits();
      void this.refreshCursorTier();
    }
    this.limitTimer = setInterval(() => void this.refreshCodexLimits(), 120_000);
    setTimeout(() => void this.overview(true), 8000);
    this.procTimer = setInterval(() => (void this.sweepProcesses(), this.sweepReminders()), 15_000);
    // Codex prices: refresh at most once a day (checked hourly, and shortly after launch).
    const prices = () => !demo && void readCodexModels().then((i) => refreshCodexPrices(i.models.map((m) => m.slug).filter((s) => s.startsWith("gpt-")))).catch(() => {});
    setTimeout(prices, 60_000);
    setInterval(prices, 3600_000);
    setTimeout(() => void this.sweepProcesses(), 3000);
    this.overviewTimer = setInterval(() => void this.overview(true), 5 * 60_000);
    setTimeout(() => void this.cloud(true), 20_000);
    this.cloudTimer = setInterval(() => void this.cloud(true), 10 * 60_000);
    this.inboxTimer = setInterval(() => this.gmail.status().connected && void this.inbox(true), 2 * 60_000);
    this.taskTimer = setInterval(() => {
      for (const scope of this.taskCache.keys()) void this.tasks(scope, true);
    }, 5 * 60_000);
    // Routines run in the Claude and Codex apps; each gets a chat here showing its latest run.
    if (!demo) {
      setTimeout(() => void this.syncRoutines(), 12_000);
      this.routineTimer = setInterval(() => void this.syncRoutines(), 5 * 60_000);
    }
  }

  // ── SessionHost ────────────────────────────────────────────────
  changed(session: Session) {
    this.emit.update(session.snapshot());
    this.scheduleSave();
    if (session.status !== "running") this.refreshGit(session);
    if (session.status === "idle") {
      void this.refreshTitle(session);
      void this.suggestNext(session);
    }
  }

  private suggesting = new Set<string>();
  private lastCheck = new Map<string, number>();
  /**
   * Once per finished reply, one hidden turn in the session: next steps to offer as buttons, and a check of the auto
   * tags (added or removed tags show as a small line in the chat). See Settings → Chats.
   */
  private async suggestNext(s: Session, settled = false) {
    if (demo) return;
    // The reply to check: the latest item, skipping notes Happy adds after it (worktree detected, tag changes…).
    const last = [...s.items].reverse().find((i) => i.kind !== "system" && i.kind !== "tags");
    const st = settings();
    const prompt = checkPrompt({ nextSteps: st.nextSteps, tags: st.autoTags ? st.tags : [], current: s.meta.tags ?? [] });
    if (!prompt || isSystemSession(s.meta) || s.meta.archived || s.pending || s.queued.length) return;
    // A chat waiting on background work isn't done: Claude Code wakes the agent when that work ends, and a hidden
    // message arriving then aborts its turn ("stopped partway"). Its next real idle gets checked instead.
    if (s.hasLiveTasks || !s.turnSettled) return;
    if (!last || last.kind !== "assistant" || isCheckAnswer(last.text) || s.nextStepsFor === last.id || this.suggesting.has(s.id)) return;
    // Fresh replies only: not every old chat when Happy starts.
    if (Date.now() - (last.ts ?? 0) > 10 * 60_000) return;
    // At most one check a minute per chat; a reply inside that window is checked when it ends.
    const wait = 60_000 - (Date.now() - (this.lastCheck.get(s.id) ?? 0));
    if (wait > 0) {
      if (!this.checkLater.has(s.id)) {
        this.checkLater.add(s.id);
        setTimeout(() => (this.checkLater.delete(s.id), this.sessions.has(s.id) && s.status === "idle" && void this.suggestNext(s)), wait + 500);
      }
      return;
    }
    // Idle has to hold for a few seconds (the agent can start a new turn right after one ends), and still hold when we send.
    if (!settled) {
      if (this.settling.has(s.id)) return;
      this.settling.add(s.id);
      const at = last.id;
      setTimeout(() => {
        this.settling.delete(s.id);
        if (this.sessions.has(s.id) && s.status === "idle" && !s.hasLiveTasks && s.turnSettled && !s.queued.length && [...s.items].reverse().find((i) => i.kind !== "system" && i.kind !== "tags")?.id === at)
          void this.suggestNext(s, true);
      }, 4000);
      return;
    }
    this.lastCheck.set(s.id, Date.now());
    s.nextStepsFor = last.id;
    this.suggesting.add(s.id);
    const started = Date.now();
    try {
      const before = s.meta.tags ?? [];
      const answer = await s.askHidden(prompt);
      const r = parseCheck(answer, st.autoTags ? st.tags : [], before);
      this.logCheck(s, !answer ? "no answer (busy, timed out or failed)" : !r ? `unreadable answer: ${answer.slice(0, 200).replace(/\s+/g, " ")}` : `${r.options?.length ?? 0} steps, +${r.add.join(",") || "-"} -${r.remove.join(",") || "-"}`, started);
      if (!r) return;
      if (r.add.length || r.remove.length) {
        this.setTags(s.id, [...before.filter((t) => !r.remove.includes(t)), ...r.add]);
        s.noteTags(r.add, r.remove);
      }
      // Buttons only if nothing happened meanwhile (you didn't send, the agent didn't reply again); Happy's own notes don't count.
      const after = s.items.slice(s.items.findIndex((i) => i.id === last.id) + 1);
      if (st.nextSteps && r.options && s.status === "idle" && !after.some((i) => i.kind !== "tags" && i.kind !== "system")) {
        s.nextSteps = r.options;
        this.emit.update(s.snapshot());
      }
    } finally {
      this.suggesting.delete(s.id);
    }
  }

  private checkLater = new Set<string>();
  private settling = new Set<string>();
  /** One line per next-steps check, in next-steps.log next to Happy's state (for "why didn't I get buttons?"). */
  learnClaudeModels(list: Array<{ value: string; displayName: string; resolvedModel?: string }>) {
    // Full ids (not aliases like "opus"), so chats that saved one match their row; one row per model.
    const seen = new Set<string>();
    const models = list
      .filter((m) => m.value && m.value !== "default")
      .map((m) => ({ id: m.resolvedModel || m.value, label: m.displayName || m.value }))
      .filter((m) => !seen.has(m.id) && (seen.add(m.id), true));
    if (!models.length) return;
    try {
      writeFileSync(join(dirname(this.file), "claude-models.json"), JSON.stringify(models, null, 2));
    } catch {}
  }

  /** Claude Code's model list as last reported (empty until a Claude chat has run once). */
  claudeModels(): Array<{ id: string; label: string }> {
    try {
      return JSON.parse(readFileSync(join(dirname(this.file), "claude-models.json"), "utf8"));
    } catch {
      return [];
    }
  }

  logPermission(s: Session, tool: string, input: Record<string, unknown>, reason?: string) {
    try {
      const arg = typeof input.command === "string" ? input.command : typeof input.file_path === "string" ? input.file_path : JSON.stringify(input);
      appendFileSync(
        join(dirname(this.file), "permissions.log"),
        `${new Date().toISOString()} ${s.meta.engine} mode=${s.meta.permissionMode ?? s.meta.codexSandbox ?? s.meta.cursorMode ?? "default"} "${s.meta.title.slice(0, 60)}" ${tool} ${arg.slice(0, 200).replace(/\s+/g, " ")}${reason ? ` | ${reason.replace(/\s+/g, " ").slice(0, 300)}` : ""}\n`,
      );
    } catch {}
  }

  private logCheck(s: Session, what: string, started: number) {
    try {
      const f = join(dirname(this.file), "next-steps.log");
      appendFileSync(f, `${new Date().toISOString()} ${s.meta.engine} "${s.meta.title.slice(0, 60)}" ${Math.round((Date.now() - started) / 1000)}s: ${what}\n`);
    } catch {}
  }

  private titling = new Set<string>();
  /** Assistant-message count at the last title check, so we check once per finished turn. */
  private titledAt = new Map<string, number>();

  /**
   * Adopt the agent's own title once a turn finishes: Claude's session summary, or the name Codex recorded for
   * the thread, else one tiny Haiku call for Codex. Titles renamed by hand ("user") are never touched.
   */
  private async refreshTitle(s: Session) {
    if (demo) return;
    const m = s.meta;
    // Haiku names every new chat (title + branch) and that name sticks; this only fills in for chats it never named
    // (imported ones, or when the Haiku call failed).
    if (isSystemSession(m) || m.titleSource !== "auto" || !m.engineSessionId || this.titling.has(s.id)) return;
    const replies = s.items.filter((i) => i.kind === "assistant").length;
    if (!replies || this.titledAt.get(s.id) === replies) return;
    this.titledAt.set(s.id, replies);
    this.titling.add(s.id);
    try {
      let title: string | undefined;
      if (m.engine === "claude") title = await claudeTitle(m.engineSessionId, m.cwd);
      else if (m.engine === "codex") title = await codexIndexTitle(m.engineSessionId);
      // Claude Code's "summary" falls back to your latest message when it hasn't written one; never adopt your own words.
      if (title && echoesUser(title, s.items)) title = undefined;
      title ??= await generateTitle(s.items);
      if (title && title !== m.title && this.sessions.has(s.id) && s.meta.titleSource === "auto") s.update({ title, titleSource: "agent" });
    } finally {
      this.titling.delete(s.id);
    }
  }

  recordUsage(tokens: number, costUsd: number, engine: "claude" | "codex" | "cursor") {
    if (!tokens && !costUsd) return;
    const d = today();
    for (const key of [d, `${d}|${engine}`]) {
      const u = (this.usage[key] ??= { tokens: 0, costUsd: 0 });
      u.tokens += tokens;
      u.costUsd += costUsd;
    }
    this.emit.usage(this.usage[d]);
    this.emit.limits(this.limits());
    this.scheduleSave();
  }

  fallbackCwd(): string {
    return existsSync(settings().repo) ? settings().repo : homedir();
  }

  private tagsFreshenedAt = new Map<string, number>();
  /** You sent a message: re-read deploy tags (at most every 30s per repo) and re-check this chat's branch, so a deploy done elsewhere shows up now. */
  freshenGit(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    void (async () => {
      const cwd = s.meta.cwd;
      if (Date.now() - (this.tagsFreshenedAt.get(cwd) ?? 0) > 30_000) {
        this.tagsFreshenedAt.set(cwd, Date.now());
        await this.gitWatch.refreshFor(cwd).catch(() => {});
      }
      this.refreshGit(s, true);
    })();
  }

  /** After a deploy: pick up the new tags and rebuild the board's deploy strip. */
  async refreshDeploys() {
    const root = settings().repo && (await this.gitWatch.worktrees(settings().repo))?.root;
    if (root) await this.gitWatch.refresh(root).catch(() => {});
    await this.overview(true).catch(() => {});
  }

  // ── stats (logo page) ─────────────────────────────────────────
  private statsCache = new Map<string, { at: number; data: HappyStats }>();
  async stats(refresh = false, range: HappyStats["range"] = "3m"): Promise<HappyStats> {
    const hit = this.statsCache.get(range);
    if (!refresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
    const messages = new Map<string, number>();
    for (const s of this.sessions.values())
      for (const it of s.items) if (it.kind === "user") messages.set(new Date(it.ts).toLocaleDateString("en-CA"), (messages.get(new Date(it.ts).toLocaleDateString("en-CA")) ?? 0) + 1);
    const usage = Object.fromEntries(Object.entries(this.usage).filter(([k]) => !k.includes("|")));
    const data = await computeStats(settings().repo, messages, usage, range, join(dirname(this.file), "stats-commits.json"));
    this.statsCache.set(range, { at: Date.now(), data });
    return data;
  }

  // ── reminders & follow-ups ────────────────────────────────────
  addTodo(id: string, t: { kind: SessionTodo["kind"]; text: string; due?: number }) {
    const s = this.get(id);
    const todo: SessionTodo = { id: randomUUID(), kind: t.kind, text: t.text.trim(), due: t.kind === "reminder" ? t.due : undefined, createdAt: Date.now() };
    if (!todo.text) throw new Error("Write something first");
    s.update({ todos: [...(s.meta.todos ?? []), todo] });
  }

  updateTodo(id: string, todoId: string, patch: Partial<Pick<SessionTodo, "text" | "due" | "done">>) {
    const s = this.get(id);
    s.update({
      todos: (s.meta.todos ?? []).map((t) =>
        t.id !== todoId ? t : { ...t, ...patch, doneAt: patch.done ? Date.now() : patch.done === false ? undefined : t.doneAt, notified: patch.due !== undefined ? false : t.notified },
      ),
    });
  }

  removeTodo(id: string, todoId: string) {
    const s = this.get(id);
    s.update({ todos: (s.meta.todos ?? []).filter((t) => t.id !== todoId) });
  }

  /**
   * Save a file you edited in a chat's side panel. Only inside that chat's own folders (its working directory and
   * worktrees), so the editor can't write anywhere else.
   */
  writeSessionFile(id: string, path: string, text: string) {
    const s = this.get(id);
    const roots = [s.meta.cwd, s.meta.worktree?.path, ...(s.meta.linkedWorktrees ?? []).filter((w) => !w.removed).map((w) => w.path)].filter((r): r is string => !!r);
    const abs = resolve(path);
    if (!roots.some((r) => within(abs, r))) throw new Error("That file isn't in this chat's folders");
    const tmp = `${abs}.happy-save-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, abs);
  }

  /** For the dev smoke test. */
  gitWatchFor() {
    return this.gitWatch;
  }

  /** Fire due reminders once (desktop notification + phone push). */
  private sweepReminders() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      const due = (s.meta.todos ?? []).filter((t) => t.kind === "reminder" && !t.done && !t.notified && t.due && t.due <= now);
      if (!due.length) continue;
      s.update({ todos: (s.meta.todos ?? []).map((t) => (due.some((d) => d.id === t.id) ? { ...t, notified: true } : t)) });
      for (const t of due) this.emit.reminder(s.snapshot(), t);
    }
  }

  // ── processes ─────────────────────────────────────────────────
  /** Attribute running OS processes to sessions by working directory (session folder + its worktrees). */
  private async sweepProcesses() {
    if (demo) {
      for (const s of this.sessions.values()) s.osProcesses = demo.processes?.[s.meta.title] ?? [];
      return;
    }
    const live = [...this.sessions.values()].filter((s) => !isSystemSession(s.meta) && !s.meta.archived && !s.meta.preparing);
    if (!live.length) return;
    const procs = await listProcesses();
    // Most specific folder wins (a worktree under ~/Code shouldn't be claimed by a session rooted at ~/Code).
    // Own worktree: anything running in it is the session's (detached jobs included). Shared checkout (no worktree of
    // its own): only processes Happy started, credited to the most recently active session there.
    const roots: Array<{ s: Session; root: string; shared: boolean }> = [];
    for (const s of live) {
      const own = !!s.meta.worktree && !s.meta.worktree.removed;
      if (!s.meta.worktree?.removed) roots.push({ s, root: s.meta.cwd, shared: !own });
      for (const w of s.meta.linkedWorktrees ?? []) if (!w.removed) roots.push({ s, root: w.path, shared: false });
    }
    roots.sort((a, b) => b.root.length - a.root.length || b.s.meta.updatedAt - a.s.meta.updatedAt);
    const bySession = new Map<string, SessionProcess[]>();
    for (const p of procs) {
      const hit = roots.find((r) => within(p.cwd, r.root) && (!r.shared || p.fromHappy));
      if (!hit) continue;
      const list = bySession.get(hit.s.id) ?? [];
      list.push({ source: "os", id: String(p.pid), pid: p.pid, label: p.command.slice(0, 300), kind: p.name, status: "running", startedAt: p.startedAt, cwd: p.cwd });
      bySession.set(hit.s.id, list);
    }
    for (const s of live) {
      const next = bySession.get(s.id) ?? [];
      if (JSON.stringify(next) !== JSON.stringify(s.osProcesses)) {
        s.osProcesses = next;
        this.emit.update(s.snapshot());
      }
    }
  }

  async stopProcess(id: string, proc: { source: "task" | "os"; id: string }) {
    const s = this.get(id);
    if (proc.source === "task") return s.stopTask(proc.id);
    const pid = Number(proc.id);
    // Only processes we attributed to this session can be stopped from here.
    if (!s.osProcesses.some((p) => p.pid === pid)) throw new Error("That process isn't attributed to this session");
    process.kill(pid, "SIGTERM");
    setTimeout(() => void this.sweepProcesses(), 1500);
  }

  // ── overview (manager board) ─────────────────────────────────
  /**
   * The Manager's board, computed without AI: what's active, what was worked on in the last 24h, unmerged work
   * (sessions and orphan worktrees), commits that landed on main, and GCP errors per tenant. Cached; GCP every 10 min.
   */
  async overview(refresh = false, refreshAll = false): Promise<Overview> {
    if (!refresh && this.overviewCache) return this.overviewCache;
    this.overviewBusy ??= this.computeOverview(refreshAll).finally(() => (this.overviewBusy = undefined));
    return this.overviewBusy;
  }

  /** Main checkouts of every repo a session works in. */
  private async repoRoots(): Promise<Set<string>> {
    const roots = new Set<string>();
    // The configured main repo first (a fresh install has no sessions yet), then any repo a session works in.
    const main = settings().repo && (await this.gitWatch.worktrees(settings().repo));
    if (main) roots.add(main.root);
    else if (settings().repo && existsSync(settings().repo)) roots.add(settings().repo);
    for (const s of this.sessions.values()) {
      if (isSystemSession(s.meta)) continue;
      const w = await this.gitWatch.worktrees(s.meta.worktree?.repo ?? s.meta.cwd);
      if (w) roots.add(w.root);
    }
    return roots;
  }

  // ── cloud dashboard ──────────────────────────────────────────
  /**
   * Live GCP state per tenant (Cloud Run, jobs, crons, queues, SQL, Firebase auth, error logs). Cached; refreshed
   * every 10 minutes in the background. If gcloud isn't logged in, returns authOk=false with the last good data.
   */
  async cloud(refresh = false): Promise<CloudSnapshot | null> {
    if (demo?.cloud) return (this.cloudCache = { ...demo.cloud, fetchedAt: Date.now() - 90_000 });
    if (!refresh && this.cloudCache) return this.cloudCache;
    this.cloudBusy ??= this.computeCloud().finally(() => (this.cloudBusy = undefined));
    if (refresh && this.cloudCache) this.emit.cloud({ ...this.cloudCache, refreshing: true });
    return this.cloudBusy;
  }

  // ── email (Gmail) ──────────────────────────────────────────────
  private static PAGE = 50;
  /** Page tokens for the current query: tokens[i] fetches page i. */
  private pageTokens: Array<string | undefined> = [undefined];

  private publishInbox(patch: Partial<Inbox>): Inbox {
    const base: Inbox = this.inboxCache ?? { fetchedAt: 0, query: "", page: 0, pageSize: Hub.PAGE, threads: [], starred: [], hasNext: false, total: 0, importantUnread: 0 };
    const inbox: Inbox = { ...base, ...patch };
    this.inboxCache = inbox;
    this.emit.inbox(inbox);
    return inbox;
  }

  /** Fetch a page of the inbox or a search; refreshes starred and counts alongside. */
  private async loadPage(query: string, page: number): Promise<Inbox> {
    if (query !== (this.inboxCache?.query ?? "")) this.pageTokens = [undefined];
    if (page >= this.pageTokens.length) page = this.pageTokens.length - 1;
    this.publishInbox({ query, page, loading: true });
    try {
      const [res, starred, counts] = await Promise.all([
        this.gmail.page(query || "in:inbox", this.pageTokens[page], Hub.PAGE),
        query ? Promise.resolve([] as EmailThread[]) : this.gmail.starredThreads(),
        this.gmail.inboxCounts(),
      ]);
      this.pageTokens[page + 1] = res.nextPageToken;
      this.pageTokens.length = page + 2;
      return this.publishInbox({
        fetchedAt: Date.now(),
        query,
        page,
        threads: query ? res.threads : res.threads.filter((t) => !t.starred),
        starred,
        hasNext: !!res.nextPageToken,
        total: query ? res.estimate : counts.total,
        importantUnread: counts.importantUnread,
        loading: false,
        error: undefined,
      });
    } catch (e) {
      return this.publishInbox({ loading: false, error: (e as Error).message });
    }
  }

  /** Current page (inbox page 1 by default); refreshed every 2 minutes while Gmail is connected. */
  async inbox(refresh = false): Promise<Inbox> {
    if (!refresh && this.inboxCache?.fetchedAt) return this.inboxCache;
    this.inboxBusy ??= this.loadPage(this.inboxCache?.query ?? "", this.inboxCache?.page ?? 0).finally(() => (this.inboxBusy = undefined));
    return this.inboxBusy;
  }

  inboxPage(query: string, page: number): Promise<Inbox> {
    return this.loadPage(query.trim(), Math.max(0, page));
  }

  private patchThread(id: string, patch: Partial<EmailThread> | null) {
    if (!this.inboxCache) return;
    const apply = (xs: EmailThread[]) => (patch === null ? xs.filter((t) => t.id !== id) : xs.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    let starred = apply(this.inboxCache.starred);
    let threads = apply(this.inboxCache.threads);
    // Starring moves a thread into / out of the pinned list.
    if (patch?.starred === true && !this.inboxCache.query) {
      const t = threads.find((x) => x.id === id);
      if (t) (starred = [t, ...starred]), (threads = threads.filter((x) => x.id !== id));
    } else if (patch?.starred === false && !this.inboxCache.query) {
      const t = starred.find((x) => x.id === id);
      starred = starred.filter((x) => x.id !== id);
      if (t?.inInbox) threads = [t, ...threads].sort((a, b) => b.date - a.date);
    }
    this.publishInbox({ starred, threads });
  }

  /** Open a thread; marks it read like Gmail does. */
  async emailThread(id: string): Promise<EmailThreadDetail> {
    const t = await this.gmail.thread(id);
    if (t.unread) {
      void this.gmail.markRead(id).catch(() => {});
      this.patchThread(id, { unread: false });
      t.unread = false;
    }
    return t;
  }

  async emailStar(id: string, on: boolean) {
    this.patchThread(id, { starred: on });
    try {
      await this.gmail.star(id, on);
    } catch (e) {
      this.patchThread(id, { starred: !on });
      throw e;
    }
  }

  async emailArchive(ids: string[]) {
    await this.gmail.archive(ids);
    this.dropFromPage(ids);
  }

  /** Threads that left the inbox: out of the saved zero-inbox run and the current page (starred ones stay pinned). */
  private dropFromPage(ids: string[]) {
    const gone = new Set(ids);
    if (this.triageRun) this.publishTriage({ ...this.triageRun, verdicts: this.triageRun.verdicts.filter((v) => !gone.has(v.id)), picked: this.triageRun.picked.filter((p) => !gone.has(p)) });
    if (this.inboxCache)
      this.publishInbox({
        threads: this.inboxCache.query ? this.inboxCache.threads.map((t) => (gone.has(t.id) ? { ...t, inInbox: false } : t)) : this.inboxCache.threads.filter((t) => !gone.has(t.id)),
        starred: this.inboxCache.starred.map((t) => (gone.has(t.id) ? { ...t, inInbox: false } : t)),
        total: Math.max(0, this.inboxCache.total - (this.inboxCache.query ? 0 : ids.length)),
      });
  }

  /** Report as spam; the threads leave the current page like an archive. */
  async emailSpam(ids: string[]) {
    await this.gmail.spam(ids);
    this.dropFromPage(ids);
  }

  /** Gmail filter that archives mail from a sender or domain, plus (optionally) what's in the inbox from them now. */
  async emailAutoArchive(from: string, archiveExisting: boolean): Promise<number> {
    await this.gmail.createArchiveFilter(from);
    const n = archiveExisting ? await this.gmail.archiveQuery(`from:${from}`) : 0;
    if (n) await this.inbox(true);
    return n;
  }

  /** Archive the whole inbox (optionally keeping starred threads); clears the saved zero-inbox run. */
  async emailArchiveAll(keepStarred: boolean): Promise<number> {
    const n = await this.gmail.archiveAll(keepStarred);
    if (this.triageRun) this.publishTriage(undefined);
    await this.inbox(true);
    return n;
  }

  /** Claude writes a reply on the thread, or (no thread) a new email: "Subject: …" then the body. */
  async emailDraft(threadId: string, instruction?: string, to: string[] = []): Promise<string> {
    if (!threadId) return draftNew(instruction ?? "", to);
    return draftReply(await this.gmail.threadText(threadId), instruction);
  }

  private publishTriage(run: TriageRun | undefined) {
    this.triageRun = run;
    try {
      if (run) writeFileSync(this.triageFile, JSON.stringify(run), { mode: 0o600 });
      else if (existsSync(this.triageFile)) writeFileSync(this.triageFile, "null");
    } catch {}
    this.emit.triage(run ?? null);
  }

  /**
   * Zero inbox: Claude's verdict for every thread in the inbox (batches of 40). Runs in the background and is saved,
   * so leaving the Email tab or restarting Happy keeps the result.
   */
  async emailTriage(): Promise<TriageRun> {
    if (this.triageRun?.status === "running") return this.triageRun;
    const list = await this.gmail.inboxIds();
    const ids = list.map((t) => t.id);
    const run: TriageRun = { status: "running", startedAt: Date.now(), total: ids.length, verdicts: [], picked: [] };
    this.publishTriage(run);
    void (async () => {
      try {
        // Digests come from thread summaries (subject, people, last sender, latest-message preview), fetched through the
        // rate limiter and cached, so a big inbox just takes a little longer.
        for (let i = 0; i < ids.length; i += 40) {
          const chunk = await this.gmail.summariesFor(list.slice(i, i + 40));
          const byId = new Map(chunk.map((t) => [t.id, t]));
          const digests = ids.slice(i, i + 40).flatMap((id) => {
            const t = byId.get(id);
            if (!t) return [];
            const day = new Date(t.date).toISOString().slice(0, 10);
            return [{ id, text: `Subject: ${t.subject} (${t.count} message${t.count > 1 ? "s" : ""}, last ${day}${t.starred ? ", STARRED" : ""}${t.unread ? ", UNREAD" : ""})\nPeople: ${t.from}\nLast from ${t.lastFromMe ? "ME" : t.lastFrom}: ${t.snippet}` }];
          });
          const batch = (await triage(digests)).map((v) => ({ ...v, subject: byId.get(v.id)?.subject, from: byId.get(v.id)?.from }));
          const cur = this.triageRun!;
          this.publishTriage({ ...cur, verdicts: [...cur.verdicts, ...batch], picked: [...cur.picked, ...batch.filter((v) => v.verdict === "archive").map((v) => v.id)] });
        }
        this.publishTriage({ ...this.triageRun!, status: "done", finishedAt: Date.now() });
      } catch (e) {
        this.publishTriage({ ...this.triageRun!, status: "error", error: (e as Error).message });
      }
    })();
    return run;
  }

  triagePick(picked: string[]) {
    if (this.triageRun) this.publishTriage({ ...this.triageRun, picked });
  }

  triageClear() {
    this.publishTriage(undefined);
  }

  /** Apply changed settings to the app-owned chats (Manager, Cloud) right away. */
  applySettings() {
    const st = settings();
    for (const s of this.sessions.values()) {
      if (!isSystemSession(s.meta) || s.meta.engine !== "claude") continue;
      const max = s.meta.isManager ? st.bypass.manager : s.meta.isEmail ? st.bypass.email : st.bypass.cloud;
      const mode: ClaudePermissionMode = max ? "bypassPermissions" : "default";
      if (s.meta.permissionMode !== mode) void this.setPermissionMode(s.id, mode);
      const model = st.models.claude ?? null;
      if ((s.meta.model ?? null) !== model) this.setModel(s.id, model);
    }
  }

  // ── tasks (Linear) ─────────────────────────────────────────────
  /** Open Linear issues; cached per scope, refreshed every 5 minutes once viewed. */
  async tasks(scope: TaskScope, refresh = false): Promise<TaskList> {
    const cached = this.taskCache.get(scope);
    if (!refresh && cached) return cached;
    let busy = this.taskBusy.get(scope);
    if (!busy) {
      busy = (async (): Promise<TaskList> => {
        try {
          const list: TaskList = { scope, fetchedAt: Date.now(), issues: await this.linear.openIssues(scope) };
          this.taskCache.set(scope, list);
          return list;
        } catch (e) {
          const list: TaskList = { ...(cached ?? { scope, fetchedAt: 0, issues: [] }), error: (e as Error).message };
          this.taskCache.set(scope, list);
          return list;
        }
      })().finally(() => this.taskBusy.delete(scope));
      this.taskBusy.set(scope, busy);
    }
    const list = await busy;
    this.emit.tasks(list);
    return list;
  }

  /** One issue changed (an edit from the board): swap that row in the cached lists and push them, no refetch. */
  patchTask(issue: LinearIssue) {
    for (const [scope, list] of this.taskCache) {
      if (!list.issues.some((i) => i.id === issue.id)) continue;
      const next = { ...list, issues: list.issues.map((i) => (i.id === issue.id ? issue : i)) };
      this.taskCache.set(scope, next);
      this.emit.tasks(next);
    }
  }

  /** Hand an issue to an agent: its own worktree named after the issue, with the full issue as the first message. */
  async startTask(issueId: string, engine: Engine): Promise<Session> {
    const issue = [...this.taskCache.values()].flatMap((l) => l.issues).find((i) => i.id === issueId || i.identifier === issueId);
    if (!issue) throw new Error("Issue not loaded; refresh Tasks and try again");
    const detail = await this.linear.issueDetail(issue.id);
    const repo = [...this.sessions.values()].find((s) => !isSystemSession(s.meta))?.meta.worktree?.repo ?? settings().repo;
    return this.createSessionAsync({
      engine,
      cwd: repo,
      worktree: true,
      worktreeName: `${issue.identifier} ${issue.title}`,
      title: `${issue.identifier} ${issue.title}`,
      prompt: taskPrompt(issue, detail),
      linearIssue: issue.identifier,
      group: "Tasks",
    });
  }

  /** Start the Manager or Cloud chat over: fresh transcript and a new engine conversation, same settings. */
  newSystemChat(id: string): Session {
    const old = this.get(id);
    if (!isSystemSession(old.meta)) throw new Error("Only the Manager and Cloud chats can be reset");
    old.dispose();
    const meta: SessionMeta = { ...old.meta, engineSessionId: undefined, updatedAt: Date.now() };
    const s = this.instantiate(meta, []);
    this.changed(s);
    return s;
  }

  /** The Cloud chat: one Claude session, created on first use, working in the main repo. */
  cloudChat(): Session {
    const existing = [...this.sessions.values()].find((s) => s.meta.isCloud);
    if (existing) return existing;
    const repo = [...this.sessions.values()].find((s) => !isSystemSession(s.meta))?.meta.worktree?.repo ?? settings().repo;
    return this.createSession({ engine: "claude", cwd: existsSync(repo) ? repo : homedir(), title: "Cloud" }, false, {
      isCloud: true,
      titleSource: "user",
    });
  }

  /** The Mail chat: one Claude session with the mail tools, created on first use. */
  emailChat(): Session {
    const existing = [...this.sessions.values()].find((s) => s.meta.isEmail);
    if (existing) return existing;
    return this.createSession({ engine: "claude", cwd: homedir(), title: "Mail" }, false, { isEmail: true, titleSource: "user" });
  }

  async emailAsk(text: string, threadId?: string) {
    const s = this.emailChat();
    let ctx = `<now>${new Date().toString()}</now>`;
    if (threadId) {
      const t = this.inboxCache?.threads.find((x) => x.id === threadId);
      ctx += `\n<open-email thread_id="${threadId}">${t ? `${t.subject} — from ${t.lastFrom}, ${new Date(t.date).toLocaleString()}` : "(open in Mail)"}</open-email>`;
    }
    await s.sendWithContext(text, ctx);
  }

  /** Mail tools for the Mail chat. Everything runs without asking except sending, which always asks. */
  private mailToolServer() {
    const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
    const brief = (t: EmailThread) => ({ id: t.id, subject: t.subject, from: t.lastFrom, date: new Date(t.date).toLocaleString(), unread: t.unread, starred: t.starred, important: t.important, lastFromMe: t.lastFromMe, messages: t.count, snippet: t.snippet.slice(0, 160) });
    return createSdkMcpServer({
      name: "mail",
      version: "0.1.0",
      tools: [
        tool("list_inbox", "Threads in the inbox (or any Gmail search), newest first.", { query: z.string().optional().describe('Gmail search, default "in:inbox"'), limit: z.number().optional() }, async (a) => {
          const r = await this.gmail.page(a.query?.trim() || "in:inbox", undefined, Math.min(Math.max(a.limit ?? 50, 1), 100));
          return text({ estimate: r.estimate, threads: r.threads.map(brief) });
        }),
        tool("read_thread", "Full text of one thread (all messages).", { thread_id: z.string() }, async (a) => text(await this.gmail.threadText(a.thread_id))),
        tool("archive", "Archive threads (remove from inbox).", { thread_ids: z.array(z.string()) }, async (a) => (await this.emailArchive(a.thread_ids), text(`archived ${a.thread_ids.length}`))),
        tool("star", "Star or unstar a thread.", { thread_id: z.string(), on: z.boolean() }, async (a) => (await this.emailStar(a.thread_id, a.on), text(a.on ? "starred" : "unstarred"))),
        tool("mark_read", "Mark a thread read.", { thread_id: z.string() }, async (a) => (await this.gmail.markRead(a.thread_id), text("marked read"))),
        tool("report_spam", "Report threads as spam.", { thread_ids: z.array(z.string()) }, async (a) => (await this.emailSpam(a.thread_ids), text(`reported ${a.thread_ids.length}`))),
        tool(
          "always_archive_sender",
          "Create a Gmail filter that skips the inbox for a sender; optionally archive what's already there.",
          { from: z.string().describe("email address or domain"), archive_existing: z.boolean().optional() },
          async (a) => text(`filter created${(await this.emailAutoArchive(a.from, !!a.archive_existing)) ? "; archived existing" : ""}`),
        ),
        tool(
          "draft_reply",
          "Save a reply draft in the thread (to/cc follow reply-all defaults). Doesn't send.",
          { thread_id: z.string(), body: z.string().describe("Plain-text body, written in the user's style") },
          async (a) => {
            const rcpt = await this.gmail.replyDefaults(a.thread_id);
            const id = await this.gmail.saveDraft(a.thread_id, a.body, rcpt, undefined, this.contacts.nameFor, undefined, rcpt.from);
            return text({ draft_id: id, to: rcpt.to, cc: rcpt.cc });
          },
        ),
        tool("send_draft", "Send a saved draft. Always asks the user first.", { draft_id: z.string() }, async (a) => (await this.gmail.sendDraft(a.draft_id), text("sent"))),
      ],
    });
  }

  /** Ask/Fix on a specific Cloud item: its own session, filed under "<Tenant> cloud" (the global chat stays for free-form questions). */
  async cloudSpawn(input: CloudSpawnInput): Promise<Session> {
    const repo = [...this.sessions.values()].find((s) => !isSystemSession(s.meta))?.meta.worktree?.repo ?? settings().repo;
    const cwd = existsSync(repo) ? repo : homedir();
    const group = input.board === "all" ? "Cloud" : `${envName(input.board)} cloud`;
    const title = input.title.replace(/\s+/g, " ").slice(0, 80);
    // Both get their own branch + worktree, named by Haiku from the prompt (like any new chat).
    if (input.mode === "fix") return this.createSessionAsync({ engine: settings().defaultEngine, cwd, worktree: true, title, prompt: input.prompt, group });
    return this.createSessionAsync(
      { engine: "claude", cwd, worktree: true, title, prompt: input.prompt, context: boardContext(this.cloudCache, input.board), group },
      { cloudBoard: input.board },
    );
  }

  async cloudAsk(text: string, board: string) {
    const s = this.cloudChat();
    await s.sendWithContext(text, boardContext(this.cloudCache, board));
  }

  private async computeCloud(): Promise<CloudSnapshot> {
    const st = await gcloudStatus();
    const prev = this.cloudCache;
    if (!st.installed || !st.userOk) {
      const snap: CloudSnapshot = { fetchedAt: prev?.fetchedAt ?? 0, authOk: false, installed: st.installed, tenants: prev?.tenants ?? [] };
      this.cloudCache = snap;
      this.emit.cloud(snap);
      return snap;
    }
    const list: ReturnType<typeof tenantProjects> = [];
    for (const root of await this.repoRoots()) for (const t of tenantProjects(root)) if (!list.some((x) => x.project === t.project)) list.push(t);
    const errors = (await this.overview()).gcp?.tenants ?? [];
    const tenants = await Promise.all(list.map((t) => tenantCloud(t, errors.find((e) => e.project === t.project))));
    // Board refs (C1…) in the order the All tab lists them, so the Cloud chat can point at items.
    tenants
      .flatMap((t) => t.issues)
      .sort((a, b) => Number(a.severity === "warn") - Number(b.severity === "warn"))
      .forEach((i, n) => (i.ref = `C${n + 1}`));
    const snap: CloudSnapshot = { fetchedAt: Date.now(), authOk: true, installed: true, tenants };
    this.cloudCache = snap;
    this.emit.cloud(snap);
    return snap;
  }

  private async computeOverview(refreshAll = false): Promise<Overview> {
    const now = Date.now();
    const sessions = [...this.sessions.values()].filter((s) => !isSystemSession(s.meta));
    const ref = (s: Session): OverviewSessionRef => {
      const last = [...s.items].reverse().find((i) => i.kind === "assistant");
      return {
        id: s.id,
        title: s.meta.title,
        engine: s.meta.engine,
        status: s.status,
        updatedAt: s.meta.updatedAt,
        branch: s.meta.worktree?.branch ?? s.meta.git?.branch,
        git: s.meta.git,
        lastReply: last?.text.split("\n").find((l) => l.trim())?.slice(0, 220),
      };
    };
    const live = sessions.filter((s) => !s.meta.archived);
    const active = live.filter((s) => s.status === "running" || s.status === "needs_permission" || s.status === "error").map(ref);
    const recent = sessions.filter((s) => now - s.meta.updatedAt < 24 * 3600_000).sort((a, b) => b.meta.updatedAt - a.meta.updatedAt).map(ref);

    // Unfinished: checkouts with the session's own work that isn't merged.
    const unfinished: OverviewUnfinished[] = [];
    const used = new Set<string>();
    for (const s of live) {
      const outs = [
        ...(!s.meta.worktree?.removed ? [{ path: s.meta.cwd, git: s.meta.git }] : []),
        ...(s.meta.linkedWorktrees ?? []).filter((w) => !w.removed).map((w) => ({ path: w.path, git: w.git })),
      ];
      for (const o of outs) {
        // Each checkout once: several chats can share one (e.g. the main checkout).
        if (used.has(o.path)) continue;
        used.add(o.path);
        const g = o.git;
        if (!g || g.merged || (!g.ahead && !g.dirty)) continue;
        // The main checkout (on main) has nothing to merge: unpushed commits there need a push, not a merge.
        if (g.onMain) continue;
        unfinished.push({ sessionId: s.id, title: s.meta.title, path: o.path, branch: g.branch, dirty: g.dirty, ahead: g.ahead, headTime: g.headTime, lastSubject: await lastCommitSubject(o.path) });
      }
    }
    // Orphan worktrees (no session) with uncommitted or unmerged work, per repo.
    const roots = await this.repoRoots();
    let landed: Overview["landed"] = [];
    const gcpTenants: Array<{ tenant: string; project: string }> = [];
    for (const root of roots) {
      const wts = await this.gitWatch.worktrees(root);
      for (const w of wts?.list ?? []) {
        if (w.path === root || used.has(w.path)) continue;
        const g = await this.gitWatch.check(w.path);
        if (!g || (!g.ahead && !g.dirty) || g.merged) continue;
        unfinished.push({ title: w.path.split("/").pop()!, path: w.path, branch: g.branch, dirty: g.dirty, ahead: g.ahead, headTime: g.headTime, lastSubject: await lastCommitSubject(w.path) });
      }
      landed = landed.concat(await landedOnMain(root, await this.gitWatch.mainRefFor(root)));
      for (const t of tenantProjects(root)) if (!gcpTenants.some((x) => x.project === t.project)) gcpTenants.push(t);
    }
    unfinished.sort((a, b) => (b.headTime ?? 0) - (a.headTime ?? 0));
    landed.sort((a, b) => b.time - a.time);

    // GCP errors: refresh at most every 10 minutes.
    let gcp = this.overviewCache?.gcp;
    if (gcpTenants.length && (!gcp || now - gcp.generatedAt > 10 * 60_000 || refreshAll)) {
      const tenants = await Promise.all(gcpTenants.map((t) => projectErrors(t.tenant, t.project)));
      gcp = { generatedAt: now, tenants, groups: crossTenantGroups(tenants) };
    }

    // Refs shared by the board and the Manager chat.
    active.forEach((r, i) => (r.ref = `A${i + 1}`));
    recent.forEach((r, i) => (r.ref = `D${i + 1}`));
    unfinished.forEach((u, i) => (u.ref = `M${i + 1}`));
    gcp?.groups.forEach((g, i) => (g.ref = `E${i + 1}`));

    const mainRepo = settings().repo && (await this.gitWatch.worktrees(settings().repo))?.root;
    const deploys = mainRepo ? await this.gitWatch.deployBoard(mainRepo).catch(() => undefined) : undefined;
    if (demo?.gcp) gcp = { generatedAt: now - 3 * 60_000, ...demo.gcp };
    gcp?.groups.forEach((g, i) => (g.ref = `E${i + 1}`));
    const o: Overview = { generatedAt: now, active, recent, landed, unfinished, gcp, deploys };
    this.applySummaries(o);
    this.overviewCache = o;
    this.emit.overview(o);
    void this.maybeAnnotate(o, refreshAll);
    return o;
  }

  /** Stable id + the content a summary describes, per board item. */
  private overviewItems(o: Overview): Array<{ ref: string; key: string; basis: string; set(text: string): void }> {
    const out: Array<{ ref: string; key: string; basis: string; set(text: string): void }> = [];
    for (const r of [...o.active, ...o.recent])
      out.push({ ref: r.ref!, key: `s:${r.id}`, basis: `${r.title}|${r.status}|${r.lastReply}|${r.git?.merged}|${r.git?.ahead}`, set: (t) => (r.summary = t) });
    for (const u of o.unfinished) out.push({ ref: u.ref!, key: `w:${u.path}`, basis: `${u.branch}|${u.ahead}|${u.dirty}|${u.lastSubject}`, set: (t) => (u.summary = t) });
    for (const g of o.gcp?.groups ?? []) out.push({ ref: g.ref!, key: `e:${g.key}`, basis: g.key, set: (t) => (g.summary = t) });
    return out;
  }

  private applySummaries(o: Overview) {
    for (const it of this.overviewItems(o)) {
      const sum = this.summaries.get(it.key);
      if (sum) it.set(sum.text);
    }
    o.headline = this.headline;
    o.annotatedAt = this.annotatedAt || undefined;
  }

  /** Ask Claude for one-liners when items are new or changed (at most every 15 min unless forced). */
  private async maybeAnnotate(o: Overview, force: boolean) {
    if (demo) {
      // Demo: the one-liners come from the demo file, never from Claude.
      const by = demo.summaries ?? {};
      for (const r of [...o.active, ...o.recent]) r.summary = by[r.title] ?? r.summary;
      for (const u of o.unfinished) u.summary = by[u.branch ?? ""] ?? u.summary;
      for (const g of o.gcp?.groups ?? []) g.summary = by[g.signature] ?? g.summary;
      o.headline = demo.headline;
      o.annotatedAt = Date.now() - 4 * 60_000;
      this.emit.overview({ ...o });
      return;
    }
    if (this.annotating) return;
    const items = this.overviewItems(o);
    const stale = items.filter((it) => this.summaries.get(it.key)?.basis !== it.basis);
    if (!stale.length || (!force && Date.now() - this.annotatedAt < 15 * 60_000 && this.annotatedAt)) return;
    this.annotating = true;
    try {
      const ann = await annotate(o);
      if (!ann) return;
      for (const it of items) if (ann.items[it.ref]) this.summaries.set(it.key, { text: ann.items[it.ref], basis: it.basis });
      this.headline = ann.headline ?? this.headline;
      this.annotatedAt = Date.now();
      if (this.overviewCache) {
        this.applySummaries(this.overviewCache);
        this.emit.overview({ ...this.overviewCache });
      }
    } finally {
      this.annotating = false;
    }
  }

  // ── plan limits ───────────────────────────────────────────────
  limits(): EngineLimits {
    if (demo?.limits) return demo.limits;
    const d = today();
    const by = (e: string) => this.usage[`${d}|${e}`]?.tokens ?? 0;
    return { ...this.limitState, today: { claude: by("claude"), codex: by("codex"), cursor: by("cursor") } };
  }

  private async refreshCursorTier() {
    const tier = await readCursorTier().catch(() => undefined);
    if (tier === undefined && this.limitState.cursor) return;
    this.limitState = { ...this.limitState, cursor: { tier, at: Date.now() } };
    this.emit.limits(this.limits());
  }

  recordClaudeLimit(info: { rateLimitType?: string; utilization?: number; resetsAt?: number; status?: string }) {
    const w = claudeWindow(info);
    if (!w) return;
    const prev = this.limitState.claude?.windows ?? [];
    const known = prev.find((x) => x.label === w.label);
    if (w.usedPct == null && known?.usedPct != null) w.usedPct = known.usedPct;
    const windows = [...prev.filter((x) => x.label !== w.label), w].sort((a, b) => order(a.label) - order(b.label));
    this.limitState = { ...this.limitState, claude: { windows, at: Date.now() } };
    this.emit.limits(this.limits());
    this.scheduleSave();
  }

  recordClaudeUsage(windows: Array<{ key: string; utilization: number | null; resetsAt?: number }>) {
    const ws = windows
      .map((w) => claudeWindow({ rateLimitType: w.key, utilization: w.utilization ?? undefined, resetsAt: w.resetsAt }))
      .filter((w): w is NonNullable<typeof w> => !!w)
      .map((w) => ({ ...w, usedPct: w.usedPct == null ? null : w.usedPct }));
    // utilization from this API is already 0–100; claudeWindow treats ≤1 as a fraction, so restore tiny percentages.
    windows.forEach((raw, i) => {
      if (ws[i] && raw.utilization != null) ws[i].usedPct = raw.utilization;
    });
    if (!ws.length) return;
    this.limitState = { ...this.limitState, claude: { windows: ws.sort((a, b) => order(a.label) - order(b.label)), at: Date.now() } };
    this.emit.limits(this.limits());
    this.scheduleSave();
  }

  codexTurnDone() {
    setTimeout(() => void this.refreshCodexLimits(), 1500);
  }

  private async refreshCodexLimits() {
    const c = await readCodexLimits().catch(() => null);
    if (!c) return;
    if (JSON.stringify(c) === JSON.stringify(this.limitState.codex)) return;
    this.limitState = { ...this.limitState, codex: c };
    this.emit.limits(this.limits());
    this.scheduleSave();
  }

  usageToday(): UsageTotals {
    return this.usage[today()] ?? { tokens: 0, costUsd: 0 };
  }

  /** Refresh branch / merge / deploy state for a session and every worktree linked to it (throttled per session). */
  private refreshGit(s: Session, force = false) {
    const last = this.gitChecked.get(s.id) ?? 0;
    if (isSystemSession(s.meta) || s.meta.archived || s.meta.preparing || (!force && Date.now() - last < 15_000)) return;
    this.gitChecked.set(s.id, Date.now());
    void (async () => {
      if (!s.meta.worktree?.removed) {
        const info = await this.gitWatch.check(s.meta.cwd, s.meta.git, s.meta.baselineDirty, s.meta.worktree?.baseSha);
        if (!this.sessions.has(s.id)) return;
        const same = JSON.stringify({ ...info, checkedAt: 0 }) === JSON.stringify({ ...s.meta.git, checkedAt: 0 });
        if (!same) s.update({ git: info, gitBranch: info?.branch });
      }
      await this.detectWorktrees(s);
      await this.refreshLinked(s);
    })();
  }

  private detecting = new Set<string>();

  /**
   * Link worktrees this session's agent CREATED: a shell command of the form `new-worktree.sh <branch> [path]` or
   * `git worktree add … <path>`, matched against the repo's worktree list. Worktrees that existed before the
   * session started are never attributed to it, and paths that merely appear in output don't count.
   */
  private async detectWorktrees(s: Session) {
    if (this.detecting.has(s.id)) return;
    this.detecting.add(s.id);
    try {
      const created = worktreeCreations(s.items);
      if (!created.length) return;
      const wts = await this.gitWatch.worktrees(s.meta.worktree?.repo ?? s.meta.cwd);
      if (!wts) return;
      const before = new Set(s.meta.worktreesAtStart ?? []);
      const linked = new Set((s.meta.linkedWorktrees ?? []).map((w) => w.path));
      const additions: LinkedWorktree[] = [];
      for (const w of wts.list) {
        if (w.path === wts.root || w.path === s.meta.cwd || linked.has(w.path) || before.has(w.path)) continue;
        const hit = created.some((c) => (c.path && samePath(c.path, w.path, s.meta.cwd)) || (c.branch && c.branch === w.branch));
        if (!hit) continue;
        linked.add(w.path);
        additions.push({ path: w.path, branch: w.branch, repo: wts.root, baseSha: await this.baseFor(w.path), source: "detected" });
      }
      if (!additions.length || !this.sessions.has(s.id)) return;
      s.update({ linkedWorktrees: [...(s.meta.linkedWorktrees ?? []), ...additions] });
      for (const a of additions) s.note(`detected worktree ${a.path}${a.branch ? ` · branch ${a.branch}` : ""}`);
    } finally {
      this.detecting.delete(s.id);
    }
  }

  private async refreshLinked(s: Session) {
    const list = s.meta.linkedWorktrees;
    if (!list?.length) return;
    let changed = false;
    const next = await Promise.all(
      list.map(async (w) => {
        if (w.removed) return w;
        if (!existsSync(w.path)) {
          changed = true;
          return { ...w, removed: true, git: undefined };
        }
        const git = await this.gitWatch.check(w.path, w.git, undefined, w.baseSha);
        if (JSON.stringify({ ...git, checkedAt: 0 }) !== JSON.stringify({ ...w.git, checkedAt: 0 })) changed = true;
        return { ...w, branch: git?.branch ?? w.branch, git };
      }),
    );
    if (changed && this.sessions.has(s.id)) s.update({ linkedWorktrees: next });
  }

  /**
   * Base commit for a worktree we didn't create. A branch with commits of its own → where it forked from main.
   * No commits of its own and main already past it → unknown history (may be merged), so leave it undefined.
   */
  private async baseFor(path: string): Promise<string | undefined> {
    const g = await this.gitWatch.check(path);
    if (g && g.ahead === 0 && g.behind > 0) return undefined;
    return this.gitWatch.forkPoint(path);
  }

  async listWorktrees(id: string): Promise<RepoWorktree[]> {
    const s = this.get(id);
    const wts = await this.gitWatch.worktrees(s.meta.worktree?.repo ?? s.meta.cwd);
    if (!wts) return [];
    const linked = new Set((s.meta.linkedWorktrees ?? []).filter((w) => !w.removed).map((w) => w.path));
    return wts.list
      .filter((w) => w.path !== wts.root)
      .map((w) => ({ path: w.path, branch: w.branch, linked: linked.has(w.path), primary: w.path === s.meta.cwd }));
  }

  async linkWorktree(id: string, path: string) {
    const s = this.get(id);
    const wts = await this.gitWatch.worktrees(s.meta.worktree?.repo ?? s.meta.cwd);
    const w = wts?.list.find((x) => x.path === path);
    if (!wts || !w) throw new Error("Not a worktree of this session's repo");
    const rest = (s.meta.linkedWorktrees ?? []).filter((x) => x.path !== path);
    s.update({ linkedWorktrees: [...rest, { path, branch: w.branch, repo: wts.root, baseSha: await this.baseFor(path), source: "linked" }] });
    this.refreshGit(s, true);
  }

  unlinkWorktree(id: string, path: string) {
    const s = this.get(id);
    s.update({ linkedWorktrees: (s.meta.linkedWorktrees ?? []).filter((x) => x.path !== path) });
  }

  /** Background sweep: every 60s re-check all live sessions (also picks up merges/deploys done elsewhere). */
  private startGitSweep() {
    const sweep = () => {
      for (const s of this.sessions.values()) this.refreshGit(s, true);
    };
    setTimeout(sweep, 1500);
    this.gitTimer = setInterval(sweep, 60_000);
  }

  // ── persistence ────────────────────────────────────────────────
  private load() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
      this.groupList = data.groups ?? [];
      this.usage = data.usage ?? {};
      this.limitState = data.limits ?? {};
      for (const { meta, items, costUsd, tokens, activeMs, engineState } of data.sessions) {
        // Repair titles adopted from Claude's summary fallback (your latest message) before that was filtered out.
        if (meta.titleSource === "agent" && echoesUser(meta.title, items.filter((i, n) => i.kind === "user" && n > items.findIndex((x) => x.kind === "user")))) {
          const b = meta.worktree?.branch ?? meta.gitBranch;
          const first = items.find((i) => i.kind === "user")?.text.split("\n").find((l) => l.trim())?.trim() ?? "";
          const t = b && !/^(main|master)$/.test(b) ? titleFromBranch(b) : first.length > 60 ? `${first.slice(0, 57)}…` : first;
          if (t) meta.title = t;
          meta.titleSource = "auto";
        }
        // Older builds saved deploy entries with flat flags ({ backend: true, frontend: false }) instead of parts.
        for (const d of meta.git?.deploys ?? []) {
          if (d.parts) continue;
          const { tenant, full, touched, ...flags } = d as any;
          d.parts = Object.fromEntries(Object.entries(flags).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean>;
          for (const k of Object.keys(d.parts)) delete (d as any)[k];
        }
        const s = this.instantiate(meta, items);
        s.costUsd = costUsd;
        s.tokens = tokens;
        s.activeMs = activeMs ?? 0;
        s.engineState = engineState ?? {};
        // Earlier builds linked any worktree mentioned in output. Drop those once; the creation rule re-detects real
        // ones. (Only once: re-dropping on every start loses worktrees whose creation scrolled out of the transcript.)
        if (!meta.linksCleaned) {
          if (meta.linkedWorktrees?.some((w) => w.source === "detected")) meta.linkedWorktrees = meta.linkedWorktrees.filter((w) => w.source !== "detected");
          meta.linksCleaned = true;
        }
        // Sessions from before baselines existed: treat what's dirty now as pre-existing.
        if (!meta.worktree && !isSystemSession(meta) && meta.baselineDirty === undefined)
          void dirtyPaths(meta.cwd).then((paths) => s.update({ baselineDirty: paths }));
      }
    } catch (err) {
      console.error("Failed to load hub state", err);
    }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const data: Persisted = {
      sessions: [...this.sessions.values()].map((s) => ({
        meta: s.meta,
        items: s.items,
        costUsd: s.costUsd,
        tokens: s.tokens,
        activeMs: s.activeMs,
        engineState: s.engineState,
      })),
      groups: this.groupList,
      usage: this.usage,
      limits: this.limitState,
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.file);
  }

  // ── session lifecycle ──────────────────────────────────────────
  private instantiate(meta: SessionMeta, items: TranscriptItem[]): Session {
    // Cloud chats can change prod only with your approval per command, so never bypass permissions there.
    let s: Session;
    if (meta.engine === "codex") {
      s = new CodexSession(meta, items, this, { url: this.browserHttp.urlFor(meta.id), token: this.browserHttp.token });
    } else if (meta.engine === "cursor") {
      s = new CursorSession(meta, items, this);
    } else {
      const browser = claudeBrowserServer(this.browsers, meta.id);
      s = new ClaudeSession(meta, items, this, {
        mcpServers: meta.isManager ? { hub: this.managerToolServer(), browser } : meta.isEmail ? { mail: this.mailToolServer() } : { browser },
        alwaysAsk: meta.isEmail ? "mcp__mail__send_draft" : undefined,
        appendSystemPrompt: meta.isManager ? MANAGER_PROMPT + BROWSER_PROMPT : meta.isEmail ? emailPrompt() : meta.isCloud || meta.cloudBoard ? CLOUD_PROMPT : BROWSER_PROMPT,
        autoAllow: (t, input) =>
          (meta.isManager && t.startsWith("mcp__hub__")) ||
          // Mail chat: reading and acting on mail runs freely (sending asks through alwaysAsk below, in every mode).
          (!!meta.isEmail && t.startsWith("mcp__mail__")) ||
          isReadOnlyBrowserTool(t) ||
          // The Cloud chat runs read-only gcloud and reads the repo without asking; anything else asks.
          (!!(meta.isCloud || meta.cloudBoard) &&
            (["Read", "Grep", "Glob"].includes(t) || (t === "Bash" && isReadOnlyGcloud(String(input.command ?? ""))))),
      });
    }
    this.sessions.set(meta.id, s);
    return s;
  }

  /**
   * Create a session, first making its own branch + worktree when asked. Sessions that share a checkout
   * record the files already dirty there so they aren't counted as the session's changes.
   */
  async createSessionAsync(input: CreateSessionInput, extra: Partial<SessionMeta> = {}): Promise<Session> {
    const atStart = (await this.gitWatch.worktrees(input.cwd))?.list.map((w) => w.path) ?? [];
    const s = input.worktree ? this.createWithWorktree(input, atStart, extra) : this.createSession(input, false, { baselineDirty: await dirtyPaths(input.cwd), worktreesAtStart: atStart, ...extra });
    if (input.group) s.update({ groupId: this.ensureGroup(input.group).id });
    return s;
  }

  /**
   * Show the session right away; in the background, name it (quick Haiku title), create its branch + worktree
   * from that name, then start the agent there. Messages typed meanwhile are shown and delivered in order.
   */
  private createWithWorktree(input: CreateSessionInput, atStart: string[], extra: Partial<SessionMeta> = {}): Session {
    const { prompt, images, files, worktreeName: _w, context, ...rest } = input;
    const s = this.createSession({ ...rest, prompt: undefined }, false, { worktreesAtStart: atStart, preparing: true, ...extra });
    s.hold();
    if (context && prompt?.trim()) void s.sendWithContext(prompt.trim(), context);
    else if (prompt?.trim() || images?.length || files?.length) void s.post(prompt?.trim() ?? "", images, files);
    void (async () => {
      try {
        // Haiku gets the details too (the given title, e.g. a Cloud issue, and a slice of any board context).
        const details = [input.title, context?.slice(0, 1200)].filter(Boolean).join("\n");
        const named = input.worktreeName ? undefined : prompt?.trim() ? await titleFromPrompt(prompt, details || undefined) : undefined;
        if (named && s.meta.titleSource !== "user") s.update({ title: named, titleSource: "agent" });
        const wt = await createWorktree(input.cwd, input.worktreeName || named || input.title || prompt || "session");
        if (!this.sessions.has(s.id)) return;
        s.update({ cwd: wt.path, worktree: wt, preparing: undefined });
        s.note(`worktree ${wt.path} · branch ${wt.branch}`);
        await s.release();
      } catch (e) {
        s.update({ preparing: undefined });
        s.note(`couldn't create the worktree: ${String((e as any).stderr || (e as Error).message).trim().split("\n")[0]}`);
        s.addError("Worktree setup failed, so the agent didn't start. Start a new chat with “own branch + worktree” off to run in the main checkout.");
      }
    })();
    return s;
  }

  createSession(input: CreateSessionInput, isManager = false, extra: Partial<SessionMeta> = {}): Session {
    const now = Date.now();
    const b = settings().bypass;
    // Cloud chats (the board chat and Ask sessions) always ask before anything that isn't read-only.
    const max = isManager ? b.manager : extra.isEmail ? b.email : extra.isCloud ? b.cloud : input.linearIssue ? b.tasks : b.sessions;
    const meta: SessionMeta = {
      id: randomUUID(),
      engine: input.engine,
      title: input.title?.trim() || `${basename(input.cwd)} · ${input.engine}`,
      // Task sessions keep their "DEB-123 title" name.
      titleSource: isManager || input.linearIssue ? "user" : "auto",
      cwd: input.cwd,
      model: input.model || settings().models[input.engine] || undefined,
      effort: input.effort || undefined,
      codexSandbox: input.engine === "codex" ? (input.codexSandbox ?? (max ? "danger-full-access" : "workspace-write")) : undefined,
      cursorMode: input.engine === "cursor" ? (input.cursorMode ?? (max ? "full" : "default")) : undefined,
      isManager,
      linearIssue: input.linearIssue,
      engineSessionId: input.resumeId,
      // Max permissions (Claude bypass / Codex full access / Cursor full) follow Settings for each area.
      permissionMode: input.engine === "claude" ? (input.permissionMode ?? (max ? "bypassPermissions" : "default")) : undefined,
      createdAt: now,
      updatedAt: now,
      ...extra,
    };
    const s = this.instantiate(meta, []);
    if (input.resumeId) s.note(`Resuming ${input.engine} session ${input.resumeId}`);
    this.changed(s);
    // Same naming as worktree chats: one Haiku call for the title (no branch needed here).
    if (!isManager && !extra.isCloud && meta.titleSource === "auto" && input.prompt?.trim() && !input.resumeId)
      // Nothing waits on this one, so give Haiku as long as it needs (a minute).
      void titleFromPrompt(input.prompt, [input.title, input.context?.slice(0, 1200)].filter(Boolean).join("\n") || undefined, 60_000).then((t) => t && this.sessions.has(s.id) && s.meta.titleSource === "auto" && s.update({ title: t, titleSource: "agent" }));
    if (input.context && input.prompt?.trim()) void s.sendWithContext(input.prompt.trim(), input.context);
    else if (input.prompt?.trim() || input.images?.length || input.files?.length)
      void s.post(input.prompt?.trim() ?? "", input.images, input.files);
    return s;
  }

  // ── import from Codex ──────────────────────────────────────────
  async codexThreads(): Promise<CodexThreadInfo[]> {
    const have = new Map([...this.sessions.values()].filter((s) => s.meta.engine === "codex" && s.meta.engineSessionId).map((s) => [s.meta.engineSessionId!, s.meta.id]));
    return (await listCodexThreads()).map(({ rolloutPath: _r, effort: _e, ...t }) => ({ ...t, imported: have.get(t.id) }));
  }

  /** Bring Codex threads into Happy: same thread (resumed on the next message), title, folder and model, recent history shown. */
  async importCodex(ids: string[]): Promise<string[]> {
    const threads = new Map((await listCodexThreads()).map((t) => [t.id, t]));
    const out: string[] = [];
    for (const id of ids) {
      const existing = [...this.sessions.values()].find((s) => s.meta.engine === "codex" && s.meta.engineSessionId === id);
      if (existing) {
        out.push(existing.meta.id);
        continue;
      }
      const t = threads.get(id);
      if (!t) throw new Error(`Codex thread ${id} not found (archived?)`);
      const { items, dropped } = await readCodexHistory(t.rolloutPath);
      const now = Date.now();
      const head: TranscriptItem = {
        id: `imp:${id}:note`,
        kind: "system",
        text: `Imported from Codex${dropped ? ` · ${dropped} earlier items not shown` : ""}. Messages here continue the same thread; don't keep using it in the Codex app too.`,
        ts: items[0]?.ts ?? now,
      };
      const meta: SessionMeta = {
        id: randomUUID(),
        engine: "codex",
        title: t.title,
        titleSource: "user",
        cwd: existsSync(t.cwd) ? t.cwd : homedir(),
        model: t.model,
        effort: t.effort,
        codexSandbox: settings().bypass.sessions ? "danger-full-access" : "workspace-write",
        engineSessionId: id,
        createdAt: items[0]?.ts ?? now,
        updatedAt: t.updatedAt || now,
      };
      const s = this.instantiate(meta, [head, ...items]);
      this.changed(s);
      out.push(meta.id);
    }
    this.saveNow();
    return out;
  }

  // ── routines ───────────────────────────────────────────────────
  private syncingRoutines = false;

  /** One chat per routine that has run: created on its first run, and moved to each new run while it follows the latest. */
  async syncRoutines() {
    if (this.syncingRoutines) return;
    this.syncingRoutines = true;
    try {
      for (const r of listRoutines()) {
        const runs = await routineRuns(r).catch(() => []);
        const latest = runs[0];
        if (!latest) continue;
        const chat = [...this.sessions.values()].find((s) => s.meta.routineId === r.id);
        if (!chat) await this.loadRoutineRun(undefined, r.id, r.name, r.engine, latest);
        else if (!chat.meta.routineRunId && chat.meta.engineSessionId !== latest.id && chat.status === "idle")
          await this.loadRoutineRun(chat, r.id, r.name, r.engine, latest);
      }
    } finally {
      this.syncingRoutines = false;
    }
  }

  /** Show one run in a routine's chat: its transcript, and replies continue that run's session. */
  private async loadRoutineRun(old: Session | undefined, routineId: string, name: string, engine: "claude" | "codex", run: RoutineRun, pinned = false) {
    const { items, dropped } = engine === "codex" && run.rolloutPath ? await readCodexHistory(run.rolloutPath) : await readClaudeHistory(run.id);
    const when = new Date(run.startedAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const head: TranscriptItem = {
      id: `routine:${run.id}:note`,
      kind: "system",
      text: `${name} · run of ${when}${dropped ? ` · ${dropped} earlier items not shown` : ""}. Replies continue this run.`,
      ts: items[0]?.ts ?? run.startedAt,
    };
    old?.dispose();
    const b = settings().bypass.sessions;
    const meta: SessionMeta = {
      ...(old?.meta ?? {
        id: randomUUID(),
        engine,
        title: name,
        titleSource: "user" as const,
        createdAt: run.startedAt,
        permissionMode: engine === "claude" ? (b ? ("bypassPermissions" as const) : ("default" as const)) : undefined,
        codexSandbox: engine === "codex" ? (b ? ("danger-full-access" as const) : ("workspace-write" as const)) : undefined,
      }),
      routineId,
      routineRunId: pinned ? run.id : undefined,
      cwd: existsSync(run.cwd) ? run.cwd : homedir(),
      engineSessionId: run.id,
      forkOf: undefined,
      // Looking at an older run doesn't move the chat in the sidebar.
      updatedAt: pinned && old ? old.meta.updatedAt : Math.max(run.startedAt, items.at(-1)?.ts ?? 0),
    };
    const s = this.instantiate(meta, [head, ...items]);
    this.changed(s);
    this.saveNow();
    return s;
  }

  async routineRuns(id: string): Promise<RoutineRun[]> {
    const s = this.get(id);
    const r = listRoutines().find((x) => x.id === s.meta.routineId);
    return r ? routineRuns(r) : [];
  }

  /** Switch a routine's chat to one of its runs (null = back to following the latest). */
  async showRoutineRun(id: string, runId: string | null) {
    const s = this.get(id);
    const r = listRoutines().find((x) => x.id === s.meta.routineId);
    if (!r) throw new Error("That routine is gone");
    if (s.status !== "idle") throw new Error("Wait for the reply to finish first");
    const runs = await routineRuns(r);
    const run = runId ? runs.find((x) => x.id === runId) : runs[0];
    if (!run) throw new Error("That run is gone");
    await this.loadRoutineRun(s, r.id, r.name, r.engine, run, !!runId && run.id !== runs[0]?.id);
  }

  list(): SessionState[] {
    return [...this.sessions.values()]
      .map((s) => s.snapshot())
      .sort((a, b) => Number(!!b.isManager) - Number(!!a.isManager) || b.updatedAt - a.updatedAt);
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`No session ${id}`);
    return s;
  }

  remove(id: string) {
    const s = this.get(id);
    if (isSystemSession(s.meta)) throw new Error("The Manager and Cloud chats can't be removed");
    s.dispose();
    this.browsers.dispose(id);
    this.sessions.delete(id);
    this.emit.removed(id);
    this.scheduleSave();
  }

  rename(id: string, title: string) {
    const s = this.get(id);
    const t = title.trim();
    if (!t || t === s.meta.title) return;
    s.update({ title: t, titleSource: "user" });
  }

  setModel(id: string, model: string | null) {
    return this.get(id).setModel(model || undefined);
  }

  /** Folders to resolve a session's relative paths against: cwd, linked worktrees, repo root. */
  /** Absolute paths ending in `name` that the session's transcript mentions (oldest first). */
  pathHints(id: string, name: string): string[] {
    const re = new RegExp(`(?:~|/)[^\\s"'\`<>()\\[\\]]*/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
    const home = homedir();
    const out: string[] = [];
    for (const it of this.get(id).items) for (const m of `${it.text}\n${it.detail ?? ""}\n${it.path ?? ""}`.matchAll(re)) out.push(m[0].replace(/^~(?=\/)/, home));
    return out;
  }

  async linkRoots(id: string): Promise<string[]> {
    const s = this.get(id);
    const roots = [s.meta.cwd, ...(s.meta.linkedWorktrees ?? []).filter((w) => !w.removed).map((w) => w.path)];
    const repo = s.meta.worktree?.repo ?? (await this.gitWatch.worktrees(s.meta.cwd))?.root;
    if (repo) roots.push(repo);
    return [...new Set(roots)];
  }

  /** Display-only plain-language rewrite of one reply; the agent's context is untouched. */
  async simplify(sessionId: string, itemId: string) {
    const s = this.get(sessionId);
    const it = s.items.find((i) => i.id === itemId);
    if (!it || it.kind !== "assistant") return;
    if (it.simplified) return;
    const text = await simplifyText(it.text);
    if (!text) throw new Error("Couldn't simplify that reply. Try again.");
    s.setItemField(itemId, { simplified: text });
  }

  setCursorMode(id: string, mode: CursorMode) {
    const s = this.get(id);
    if (s.meta.engine === "cursor") s.update({ cursorMode: mode });
  }

  setCodexSandbox(id: string, mode: CodexSandbox) {
    const s = this.get(id);
    if (s.meta.engine === "codex") s.update({ codexSandbox: mode });
  }

  setEffort(id: string, effort: string | null) {
    return this.get(id).setEffort(effort || undefined);
  }

  setTags(id: string, tags: string[]) {
    const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    this.get(id).update({ tags: clean.length ? clean : undefined });
  }

  setArchived(id: string, archived: boolean) {
    const s = this.get(id);
    if (isSystemSession(s.meta)) return;
    s.update({ archived: archived || undefined });
  }

  /**
   * Fork a chat: a new chat with the same history that continues on its own (same folder). Claude forks its
   * conversation on the first message; Codex gets a copy of the thread's rollout under a new id.
   */
  forkSession(id: string): Session {
    const src = this.get(id);
    if (isSystemSession(src.meta)) throw new Error("The Manager, Cloud and Mail chats can't be forked");
    if (src.meta.engine === "cursor") throw new Error("Cursor chats can't be forked yet");
    const now = Date.now();
    const meta: SessionMeta = {
      ...structuredClone(src.meta),
      id: randomUUID(),
      title: `${src.meta.title} (fork)`,
      titleSource: "user",
      archived: undefined,
      createdAt: now,
      updatedAt: now,
    };
    if (src.meta.engineSessionId) {
      if (src.meta.engine === "claude") {
        meta.forkOf = src.meta.engineSessionId;
        meta.engineSessionId = undefined;
      } else meta.engineSessionId = forkCodexRollout(src.meta.engineSessionId);
    }
    const s = this.instantiate(meta, structuredClone(src.items));
    s.note(`Forked from "${src.meta.title}"`);
    this.changed(s);
    return s;
  }

  async removeWorktree(id: string) {
    const s = this.get(id);
    const wt = s.meta.worktree;
    if (!wt || wt.removed) throw new Error("This session has no worktree to remove");
    if (s.status === "running" || s.status === "needs_permission") throw new Error("Stop the session first");
    s.dispose();
    const r = await removeWorktree(wt).catch((e) => {
      throw new Error(String(e.stderr || e.message).trim().split("\n")[0]);
    });
    s.update({ worktree: { ...wt, removed: true } });
    s.note(`worktree removed${r.branchDeleted ? ` · branch ${wt.branch} deleted` : ` · branch ${wt.branch} kept (not merged)`}`);
    return r;
  }

  moveToGroup(id: string, groupId: string | null) {
    if (groupId && !this.groupList.some((g) => g.id === groupId)) throw new Error("Unknown group");
    this.get(id).update({ groupId: groupId ?? undefined });
  }

  // ── groups ─────────────────────────────────────────────────────
  groups(): SessionGroup[] {
    return this.groupList;
  }

  private groupsChanged() {
    this.emit.groups(this.groupList);
    this.scheduleSave();
  }

  /** The group with this name (any case), created if missing. */
  ensureGroup(name: string): SessionGroup {
    return this.groupList.find((g) => g.name.toLowerCase() === name.trim().toLowerCase()) ?? this.createGroup(name);
  }

  createGroup(name: string): SessionGroup {
    const g: SessionGroup = { id: randomUUID(), name: name.trim() || "Group" };
    this.groupList = [...this.groupList, g];
    this.groupsChanged();
    return g;
  }

  renameGroup(groupId: string, name: string) {
    this.groupList = this.groupList.map((g) => (g.id === groupId ? { ...g, name: name.trim() || g.name } : g));
    this.groupsChanged();
  }

  setGroupCollapsed(groupId: string, collapsed: boolean) {
    this.groupList = this.groupList.map((g) => (g.id === groupId ? { ...g, collapsed } : g));
    this.groupsChanged();
  }

  /** Deleting a group moves its sessions back to ungrouped. */
  deleteGroup(groupId: string) {
    this.groupList = this.groupList.filter((g) => g.id !== groupId);
    for (const s of this.sessions.values()) if (s.meta.groupId === groupId) s.update({ groupId: undefined });
    this.groupsChanged();
  }

  async setPermissionMode(id: string, mode: ClaudePermissionMode) {
    const s = this.get(id);
    if (s instanceof ClaudeSession) await s.setPermissionMode(mode);
  }

  respondPermission(requestId: string, decision: PermissionDecision, extra?: PermissionExtra) {
    for (const s of this.sessions.values()) if (s.respondPermission(requestId, decision, extra)) return;
  }

  async listClaudeSessions(): Promise<ExternalClaudeSession[]> {
    const known = new Set([...this.sessions.values()].map((s) => s.meta.engineSessionId));
    const all = await listSessions({ limit: 50 });
    return all
      .filter((s) => !known.has(s.sessionId))
      .map((s) => ({
        sessionId: s.sessionId,
        summary: s.customTitle || s.summary,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        lastModified: s.lastModified,
      }));
  }

  dispose() {
    clearInterval(this.gitTimer);
    clearInterval(this.limitTimer);
    clearInterval(this.overviewTimer);
    clearInterval(this.cloudTimer);
    clearInterval(this.taskTimer);
    clearInterval(this.inboxTimer);
    clearInterval(this.procTimer);
    clearInterval(this.routineTimer);
    this.saveNow();
    for (const s of this.sessions.values()) s.dispose();
  }

  // ── manager tools ──────────────────────────────────────────────
  private describe(s: Session) {
    const lastReply = [...s.items].reverse().find((i) => i.kind === "assistant");
    return {
      session_id: s.id,
      engine: s.meta.engine,
      title: s.meta.title,
      cwd: s.meta.cwd,
      status: s.status,
      waiting_on_permission: s.pending ? { tool: s.pending.tool, input: clip(JSON.stringify(s.pending.input), 300) } : undefined,
      last_reply: lastReply ? clip(lastReply.text, 400) : undefined,
      git: s.meta.git
        ? {
            branch: s.meta.git.branch,
            uncommitted_files: s.meta.git.dirty,
            commits_ahead_of_main: s.meta.git.ahead,
            merged: s.meta.git.merged,
            deployed_to: s.meta.git.deploys?.filter(isDeployed).map((d) => `${d.tenant}(${d.full ? "full" : deployedParts(d).join("+")})`),
          }
        : undefined,
      other_worktrees: s.meta.linkedWorktrees
        ?.filter((w) => !w.removed)
        .map((w) => ({
          path: w.path,
          branch: w.branch,
          uncommitted_files: w.git?.dirty,
          commits_ahead_of_main: w.git?.ahead,
          merged: w.git?.merged,
          deployed_to: w.git?.deploys?.filter(isDeployed).map((d) => d.tenant),
        })),
      tags: s.meta.tags,
      updated_at: new Date(s.meta.updatedAt).toISOString(),
    };
  }

  private managerToolServer() {
    const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
    const workers = () => [...this.sessions.values()].filter((s) => !isSystemSession(s.meta) && !s.meta.archived);

    return createSdkMcpServer({
      name: "hub",
      version: "0.1.0",
      tools: [
        tool(
          "get_overview",
          "The board: sessions active now, work from the last 24h, unmerged work (incl. worktrees with no session), commits landed on main in 24h, and GCP errors per tenant (24h, grouped).",
          { refresh: z.boolean().optional().describe("Recompute now instead of using the cached board") },
          async (a) => text(await this.overview(!!a.refresh, !!a.refresh)),
        ),
        tool("list_sessions", "List all worker sessions with status and their latest reply.", {}, async () =>
          text(workers().map((s) => this.describe(s))),
        ),
        tool(
          "create_session",
          "Start a new Claude Code or Codex session in a directory and send it an initial prompt.",
          {
            engine: z.enum(["claude", "codex", "cursor"]).describe("claude (default), codex, or cursor"),
            cwd: z.string().describe("Absolute path of the working directory / repo"),
            title: z.string().describe("Short title, e.g. 'api: fix login 500'"),
            prompt: z.string().describe("Self-contained task prompt"),
            model: z.string().optional(),
          },
          async (a) => {
            if (!existsSync(a.cwd)) return text(`Directory does not exist: ${a.cwd}`);
            const s = await this.createSessionAsync({
              engine: a.engine,
              cwd: a.cwd,
              title: a.title,
              prompt: a.prompt,
              model: a.model,
              // Every spawned session gets its own branch + worktree, named by Haiku from the prompt.
              worktree: true,
            });
            return text({ created: s.id, title: s.meta.title, cwd: s.meta.cwd, branch: s.meta.worktree?.branch });
          },
        ),
        tool(
          "send_message",
          "Send a follow-up message to a worker session (queued if it is mid-turn).",
          { session_id: z.string(), text: z.string() },
          async (a) => {
            await this.get(a.session_id).post(a.text);
            return text("sent");
          },
        ),
        tool(
          "read_session",
          "Read the most recent transcript items of a session.",
          { session_id: z.string(), last_n: z.number().int().min(1).max(100).optional() },
          async (a) => {
            const s = this.get(a.session_id);
            const items = s.items.slice(-(a.last_n ?? 15)).map((i) => {
              const head = i.kind === "tool" ? `[tool ${i.tool}${i.status ? ` ${i.status}` : ""}] ${i.text}` : `[${i.kind}] ${i.text}`;
              return clip(head, 1500);
            });
            return text({ ...this.describe(s), recent: items });
          },
        ),
        tool(
          "wait_for_sessions",
          "Block until the given sessions are no longer running (idle, error, or waiting on a permission), or until timeout.",
          { session_ids: z.array(z.string()), timeout_sec: z.number().int().min(5).max(900).optional() },
          async (a) => {
            const timeout = (a.timeout_sec ?? 300) * 1000;
            await Promise.race([
              Promise.all(a.session_ids.map((id) => this.get(id).waitUntilSettled())),
              new Promise((r) => setTimeout(r, timeout)),
            ]);
            return text(a.session_ids.map((id) => this.describe(this.get(id))));
          },
        ),
        tool("interrupt_session", "Stop a session's current turn.", { session_id: z.string() }, async (a) => {
          await this.get(a.session_id).interrupt();
          return text("interrupted");
        }),
      ],
    });
  }
}

/** Worktree-creating shell commands in a transcript → requested branch and/or path. */
export function worktreeCreations(items: TranscriptItem[]): Array<{ branch?: string; path?: string }> {
  const out: Array<{ branch?: string; path?: string }> = [];
  for (const i of items) {
    if (i.kind !== "tool" || !/^(Bash|shell)$/.test(i.tool ?? "")) continue;
    const cmd = i.text;
    for (const m of cmd.matchAll(/new-worktree\.sh\s+([^\s;&|]+)(?:\s+([^\s;&|]+))?/g)) out.push({ branch: unquote(m[1]), path: m[2] ? unquote(m[2]) : undefined });
    for (const m of cmd.matchAll(/git\s+(?:-C\s+\S+\s+)?worktree\s+add\s+((?:-{1,2}[\w-]+(?:\s+[^-\s]\S*)?\s+)*)([^\s;&|]+)/g)) {
      const flags = m[1] ?? "";
      const b = flags.match(/-[bB]\s+(\S+)/)?.[1];
      out.push({ path: unquote(m[2]), branch: b ? unquote(b) : undefined });
    }
  }
  return out;
}

const unquote = (s: string) => s.replace(/^['"]|['"]$/g, "");

/** Compare a path from a command (maybe relative / ~) with an absolute worktree path, case-insensitively (macOS). */
function samePath(fromCmd: string, abs: string, cwd: string): boolean {
  const home = homedir();
  let p = fromCmd.startsWith("~/") ? join(home, fromCmd.slice(2)) : fromCmd;
  if (!p.startsWith("/")) p = join(cwd, p);
  const norm = (x: string) => x.replace(/\/+$/, "").toLowerCase();
  return norm(p) === norm(abs);
}
