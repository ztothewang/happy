// Shared between the Electron main process and the renderer.

export type Engine = "claude" | "codex" | "cursor";
/** Cursor run modes: full = --force (runs commands), default = asks/denies risky commands, plan / ask = read-only. */
export type CursorMode = "full" | "default" | "plan" | "ask";
export type SessionStatus = "idle" | "running" | "needs_permission" | "error";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface SessionMeta {
  id: string; // hub id (stable across restarts)
  engine: Engine;
  title: string;
  /** "user" = renamed by hand (never overwritten); "auto" = first line of the prompt; "agent" = from Claude/Codex. */
  titleSource?: "user" | "auto" | "agent";
  cwd: string;
  model?: string;
  isManager?: boolean;
  /** The Cloud dashboard's chat (hidden from the session list, like the Manager). */
  isCloud?: boolean;
  /** The Mail page's chat (hidden from the session list): reads mail and acts on it with the mail tools. */
  isEmail?: boolean;
  /** A visible session spun off a Cloud item ("ask"): Cloud's prompt and read-only gcloud, for this board. */
  cloudBoard?: string;
  /** Linear issue this session was started for (identifier, e.g. DEB-647). */
  linearIssue?: string;
  /** Claude session_id or Codex thread_id, used to resume after restart. */
  engineSessionId?: string;
  permissionMode?: ClaudePermissionMode; // claude only
  /** Reasoning effort (codex). */
  effort?: string;
  /** Codex sandbox: workspace-write (default; .git stays read-only), danger-full-access (can commit/merge), read-only. */
  codexSandbox?: CodexSandbox;
  cursorMode?: CursorMode;
  /** Sidebar group (undefined = ungrouped). */
  groupId?: string;
  /** A routine's chat (Claude or Codex app routine id, e.g. "claude:sync-prod-prompts"): shows one run at a time. */
  routineId?: string;
  /** The run shown (its engine session id); undefined = follow the latest run. */
  routineRunId?: string;
  /** Your reminders and follow-ups for this chat (added in the app). */
  todos?: SessionTodo[];
  /** The agent's own task list (Claude TodoWrite / Codex todo_list), latest version. */
  agentTodos?: AgentTodo[];
  /** Free-form labels, e.g. "backfill". */
  tags?: string[];
  archived?: boolean;
  /** Current git branch of cwd, refreshed after turns. */
  gitBranch?: string;
  git?: GitInfo;
  /** The session's own branch + worktree, created by Happy. */
  worktree?: { path: string; branch: string; repo: string; baseSha?: string; removed?: boolean };
  /** True while the session's worktree is being created (the agent hasn't started yet). */
  preparing?: boolean;
  /** Worktree paths that already existed when the session started (never attributed to it). */
  worktreesAtStart?: string[];
  /** The one-time cleanup of worktrees old builds linked from output has run for this session. */
  linksCleaned?: boolean;
  /** A fork that hasn't started yet: the engine conversation it continues from (forked on its first message). */
  forkOf?: string;
  /** Other worktrees this session works in: created by the agent (detected) or attached by hand (linked). */
  linkedWorktrees?: LinkedWorktree[];
  /** For sessions sharing a checkout: files already uncommitted when the session started (not counted as its changes). */
  baselineDirty?: string[];
  createdAt: number;
  updatedAt: number;
}

/** A reminder (optionally due at a time; notifies when due) or a follow-up (a loose to-do) on a chat. */
export interface SessionTodo {
  id: string;
  kind: "reminder" | "followup";
  text: string;
  due?: number;
  done?: boolean;
  doneAt?: number;
  createdAt: number;
  /** Set once the due notification went out. */
  notified?: boolean;
}

export interface AgentTodo {
  /** Claude's task id (TaskCreate/TaskUpdate), when it has one. */
  id?: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** One component's latest deploy for a tenant, and what's on main since. */
/** One place you deploy to (a tenant, a region, staging/prod…), from `.happy/config.json`. */
export interface ProjectEnvironment {
  /** Short id shown on chips and the board (e.g. "prod", "eu", "deb"). */
  id: string;
  /** Display name (titles, prompts, Cloud page). */
  name?: string;
  color?: string;
  /** The environment segment in deploy tags (`deployed-<tag>-<component>-…`); "" = tags without one. Default: id. */
  tag?: string;
  /** Other tag segments that mean this environment. */
  aliases?: string[];
  /** Env file in the repo; `{envFile}` in deploy commands, and where PROJECT_ID / REGION are read for the Cloud page. */
  envFile?: string;
  /** Cloud project (else PROJECT_ID from envFile), region (else REGION), Firebase project (else FIREBASE_PROJECT_ID). */
  cloudProject?: string;
  region?: string;
  firebaseProject?: string;
  /** Per-environment overrides of deploy.commands. */
  commands?: Record<string, string>;
}

export interface DeployComponentDef {
  id: string;
  /** Short label on chips ("be"). Default: id. */
  short?: string;
  label?: string;
  /** Paths (git pathspecs) whose changes this component deploys. */
  paths: string[];
}

/** `.happy/config.json` in a repo. */
export interface ProjectConfig {
  /** One line about the project, for Happy's helper prompts (e.g. "a multi-tenant SaaS on Cloud Run"). */
  description?: string;
  environments?: ProjectEnvironment[];
  deploy?: {
    /** Tags look like `<tagPrefix>-[<env tag>-]<component|full>-<YYYYMMDD-HHMMSS>-<sha>`. Default "deployed". */
    tagPrefix?: string;
    components?: DeployComponentDef[];
    /** Pathspecs that a "full" deploy ignores when counting what's behind (default: docs and Markdown). */
    fullIgnore?: string[];
    /**
     * Shell commands, run in the repo from the Manager board's deploy menu: one per component id, plus "core"
     * (every component) and "full". Placeholders: {env} {envFile} {tag}.
     */
    commands?: Record<string, string>;
  };
  /** npm packages published from folders in the repo (version on main vs npm, unbumped changes). */
  packages?: Array<{ dir: string }>;
  /** Abbreviations to expand in chat titles ("acme" → "Acme Corp"); environment names are included automatically. */
  glossary?: Record<string, string>;
  /** Cloud page provider. Only "gcp" for now (Cloud Run, Cloud SQL, Scheduler, Logging via gcloud). */
  cloud?: { provider: "gcp" };
  /** Analytics page: product events from PostHog, read with a personal API key (HogQL, read-only). */
  analytics?: {
    provider: "posthog";
    /** Default https://us.posthog.com. */
    host?: string;
    projectId: string;
    /** Where the personal API key is: a local file (~ allowed), else a Secret Manager secret read with gcloud. */
    keyFile?: string;
    keySecret?: { project: string; name: string };
    /** Site host ($host) → environment id. Events from other hosts are left out. */
    hosts?: Record<string, string>;
    /** Email suffixes of your own team, hidden with "hide team". */
    internal?: string[];
  };
}

export interface AnalyticsQuery {
  range: "1h" | "24h" | "7d" | "30d";
  /** Environment id, or all. */
  env?: string;
  person?: string;
  signedIn?: boolean;
  hideInternal?: boolean;
}

export interface AnalyticsEvent {
  ts: number;
  event: string;
  email?: string;
  env?: string;
  path?: string;
  /** Autocapture: "click Save". */
  action?: string;
}

export interface AnalyticsSnapshot {
  configured: boolean;
  error?: string;
  fetchedAt: number;
  /** The PostHog project, for "open in PostHog". */
  link?: string;
  envs: Array<{ id: string; name: string; color?: string; users: number; events: number }>;
  people: Array<{ email: string; env?: string; events: number; lastSeen: number }>;
  top: Array<{ event: string; count: number; users: number }>;
  feed: AnalyticsEvent[];
}

export interface DeployComponent {
  sha: string;
  at: number;
  /** Commits on main touching this component that aren't in the deploy. */
  behind: number;
  /** Their subjects, newest first (up to 8). */
  pending: string[];
}

export interface TenantDeploy {
  /** Environment id. */
  tenant: string;
  /** Latest deploy per component id. */
  parts: Record<string, DeployComponent>;
  /** Latest full deploy (everything, not just core); behind = any commits on main since. */
  full?: DeployComponent;
}

/** A deploy started from the Manager board, tracked through its terminal until the script exits. */
export interface DeployJob {
  id: string;
  tenant: string;
  /** A component id, "core" or "full". */
  kind: string;
  command: string;
  termId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "success" | "failed";
  exitCode?: number;
}

/** An npm-published MCP package in the repo: version on main vs on npm. */
export interface McpPackage {
  name: string;
  dir: string;
  main: string;
  npm?: string;
  /** main's version isn't on npm yet. */
  unpublished: boolean;
  /** Commits on main changing the MCP since its last version bump (changes that a publish wouldn't include). */
  unbumped: number;
}

/** A scheduled routine in the Claude desktop app or the Codex app. */
export interface Routine {
  id: string;
  engine: "claude" | "codex";
  name: string;
  description?: string;
  /** Plain words: "daily 9:17 AM", "Mon 9:00 AM". */
  schedule: string;
  enabled: boolean;
  nextRun?: number;
  lastRun?: number;
  /** Codex: notes from the latest run. */
  lastResult?: string;
  cwd?: string;
  /** The routine's prompt/definition file. */
  file: string;
}

/** One run of a routine: its own Claude session or Codex thread. */
export interface RoutineRun {
  /** Claude session id or Codex thread id. */
  id: string;
  startedAt: number;
  cwd: string;
  /** Codex: the run's rollout file. */
  rolloutPath?: string;
}

/** An address Gmail lets you send as. */
export interface EmailSendAs {
  email: string;
  name?: string;
  isDefault: boolean;
}

/** A link's preview card (Open Graph). */
export interface LinkPreview {
  url: string;
  title: string;
  description?: string;
  image?: string;
  site?: string;
  icon?: string;
}

export interface DeployBoard {
  mainRef: string;
  /** Configured components, in order (columns). */
  components: Array<{ id: string; short: string; label: string }>;
  /** Deploy commands per environment id and kind (component id / core / full), already filled in. */
  commands: Record<string, Record<string, string>>;
  colors: Record<string, string>;
  tenants: TenantDeploy[];
  mcp?: McpPackage[];
  /** Local main commits not pushed to origin (they can't be deployed from origin yet). */
  unpushed: number;
}

export interface GitDeploy {
  tenant: string;
  parts: Record<string, boolean>;
  full?: boolean;
  touched?: string[];
}

/** Components of this deploy entry that HEAD is in (a full deploy counts for all). */
export const deployedParts = (d: GitDeploy) => Object.keys(d.parts).filter((k) => d.parts[k]);
/** HEAD is live in this environment (any component, or a full deploy). */
export const isDeployed = (d: GitDeploy) => !!d.full || deployedParts(d).length > 0;

export interface GitInfo {
  branch?: string;
  head?: string;
  /** Last commit time (ms) — used to pick the most recently active worktree. */
  headTime?: number;
  /** Uncommitted files. */
  dirty: number;
  /** Commits ahead of / behind the main branch. */
  ahead: number;
  behind: number;
  onMain: boolean;
  merged: boolean;
  hadWork?: boolean;
  /** Per tenant: is HEAD contained in the latest deployed backend / frontend tag? */
  /** Per tenant: is this checkout's work in the latest backend / frontend / db deploy, and in the latest full deploy (everything: jobs, MCP, parsing…)? */
  /**
   * Per environment: whether HEAD is in the latest deploy of each component (parts), and of a full deploy.
   * touched = the components this branch changed (only those count); undefined on main / unknown history.
   */
  deploys?: GitDeploy[];
  /** Configured components (id + short label), for chips. */
  deployComponents?: Array<{ id: string; short: string }>;
  /** MCP packages this branch changed: published (its version is on npm), unpublished (bumped, not on npm) or unbumped. */
  mcp?: Array<{ name: string; state: "published" | "unpublished" | "unbumped" }>;
  checkedAt: number;
}

export interface LinkedWorktree {
  path: string;
  branch?: string;
  repo: string;
  baseSha?: string;
  source: "detected" | "linked";
  removed?: boolean;
  git?: GitInfo;
}

export interface RepoWorktree {
  path: string;
  branch?: string;
  linked: boolean;
  primary: boolean;
}

export interface CodexModelInfo {
  models: Array<{ slug: string; name: string; description?: string; efforts: string[]; defaultEffort?: string }>;
  /** From ~/.codex/config.toml */
  defaultModel?: string;
  defaultEffort?: string;
}

export interface OverviewSessionRef {
  /** Short handle shown on the board and understood by the Manager chat (A1, D3…). */
  ref?: string;
  /** One-line summary written by Claude. */
  summary?: string;
  id: string;
  title: string;
  engine: Engine;
  status: SessionStatus;
  updatedAt: number;
  branch?: string;
  git?: GitInfo;
  /** First line of the latest reply — what the session last said it did. */
  lastReply?: string;
}

export interface OverviewUnfinished {
  ref?: string;
  summary?: string;
  /** Subject of the branch's latest commit. */
  lastSubject?: string;
  /** Session it belongs to, if any (orphan worktrees have none). */
  sessionId?: string;
  title: string;
  path: string;
  branch?: string;
  dirty: number;
  ahead: number;
  headTime?: number;
}

export interface GcpErrorGroup {
  service: string;
  signature: string;
  sample: string;
  count: number;
  lastSeen: number;
}

export interface TenantErrors {
  tenant: string;
  project: string;
  total: number;
  groups: GcpErrorGroup[];
  /** Error counts per hour, oldest first (24 buckets ending at the current hour). */
  hourly: number[];
  error?: string;
}

/** The same error across tenants (grouped by service + message signature). */
export interface ErrorGroup {
  ref?: string;
  summary?: string;
  key: string;
  service: string;
  signature: string;
  sample: string;
  total: number;
  byTenant: Record<string, number>;
  lastSeen: number;
}

export interface Overview {
  generatedAt: number;
  /** Deploy status per tenant (backend / frontend / db) against main. */
  deploys?: DeployBoard;
  active: OverviewSessionRef[];
  recent: OverviewSessionRef[];
  /** Commits that landed on main in the last 24h (first-parent), per repo. */
  landed: Array<{ sha: string; subject: string; author: string; time: number }>;
  unfinished: OverviewUnfinished[];
  gcp?: { generatedAt: number; tenants: TenantErrors[]; groups: ErrorGroup[] };
  /** Claude's one-line headline for the whole board. */
  headline?: string;
  /** When Claude last annotated the board (summaries + headline). */
  annotatedAt?: number;
}

// ── Cloud dashboard ─────────────────────────────────────────
export type Health = "ok" | "warn" | "bad";

export interface CloudIssue {
  /** Board reference (C1, C2…) the Cloud chat can use. */
  ref?: string;
  tenant: string;
  severity: "warn" | "bad";
  area: "service" | "job" | "cron" | "queue" | "sql" | "auth" | "logs" | "fetch";
  text: string;
  /** Short facts shown as chips, e.g. "13.4% of requests", "last 1h ago". */
  facts?: string[];
  /** The concrete thing: matching error signature, the slow query, the cron's target… */
  detail?: string;
  /** 24 hourly values for a trend line. */
  series?: number[];
  link?: string;
}

export interface CloudService {
  name: string;
  region: string;
  url?: string;
  ready: boolean;
  revision?: string;
  deployedAt?: number;
  deployedBy?: string;
  requests: number;
  err5xx: number;
  err4xx: number;
  /** Latest hourly p95 latency (ms). */
  p95?: number;
  instances?: number;
  hourly: number[];
  hourly5xx: number[];
  link: string;
}

export interface CloudJob {
  name: string;
  status: "succeeded" | "failed" | "running" | "cancelled" | "never";
  lastRun?: number;
  durationS?: number;
  link: string;
}

export interface CloudSchedule {
  name: string;
  schedule: string;
  timeZone?: string;
  paused: boolean;
  lastAttempt?: number;
  failed: boolean;
  code?: number;
  target?: string;
}

export interface CloudQueue {
  name: string;
  running: boolean;
  depth?: number;
  hourly: number[];
  link: string;
}

export interface CloudSql {
  name: string;
  state: string;
  version: string;
  tier: string;
  cpu?: number;
  mem?: number;
  disk?: number;
  connections?: number;
  cpuHourly: number[];
  /** From Query Insights, last 24h: the queries using the most total DB time, and the slowest per call. */
  slow?: { byTotal: SlowQuery[]; byMean: SlowQuery[] };
  link: string;
}

export interface SlowQuery {
  query: string;
  calls: number;
  meanMs: number;
  totalS: number;
}

export interface CloudAuth {
  firebaseProject: string;
  ok: number;
  err4xx: number;
  err5xx: number;
  hourly: number[];
  hourlyErr: number[];
  link: string;
}

export interface TenantCloud {
  tenant: string;
  project: string;
  region?: string;
  fetchedAt: number;
  /** Per-section fetch failures, e.g. { scheduler: "PERMISSION_DENIED" }. */
  failures: Record<string, string>;
  services: CloudService[];
  jobs: CloudJob[];
  schedules: CloudSchedule[];
  queues: CloudQueue[];
  sql: CloudSql[];
  auth?: CloudAuth;
  errors?: TenantErrors;
  issues: CloudIssue[];
  health: Health;
  links: { console: string; logs: string };
}

export interface CloudSnapshot {
  fetchedAt: number;
  /** False when gcloud isn't logged in — the UI asks you to sign in. */
  authOk: boolean;
  installed: boolean;
  refreshing?: boolean;
  tenants: TenantCloud[];
}

// ── Tasks (Linear) ──────────────────────────────────────────
export type TaskScope = "mine" | "team";

export interface LinearStatus {
  connected: boolean;
  name?: string;
  email?: string;
  error?: string;
}

/** Not open work: done, canceled, or a "Duplicate" status (some teams give it a non-canceled type). */
export const isClosedIssue = (i: { status: string; statusType: string }) => i.statusType === "completed" || i.statusType === "canceled" || /^duplicate$/i.test(i.status);

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  priorityLabel: string;
  url: string;
  branchName?: string;
  createdAt: number;
  updatedAt: number;
  dueDate?: string;
  estimate?: number;
  status: string;
  statusType: string;
  statusColor?: string;
  assignee?: string;
  project?: string;
  parent?: string;
  team?: string;
  labels: Array<{ name: string; color?: string }>;
}

export interface LinearMeta {
  teams: Array<{
    id: string;
    key: string;
    name: string;
    states: Array<{ id: string; name: string; type: string; color: string }>;
    members: Array<{ id: string; name: string }>;
    labels: Array<{ id: string; name: string; color: string }>;
  }>;
  projects: Array<{ id: string; name: string; teamIds: string[] }>;
  viewerId: string;
}

/** Fields for creating or editing an issue (ids from LinearMeta). Omitted = unchanged. */
export interface LinearIssueInput {
  teamId?: string;
  title?: string;
  description?: string;
  stateId?: string;
  priority?: number;
  assigneeId?: string | null;
  projectId?: string | null;
  labelIds?: string[];
}

export interface LinearIssueDetail {
  identifier: string;
  description: string;
  teamId?: string;
  stateId?: string;
  assigneeId?: string;
  projectId?: string;
  labelIds: string[];
  creator?: string;
  comments: Array<{ author: string; body: string; createdAt: number }>;
  attachments: Array<{ title: string; url: string }>;
  children: Array<{ identifier: string; title: string; status?: string; done: boolean }>;
}

export interface TaskList {
  scope: TaskScope;
  fetchedAt: number;
  issues: LinearIssue[];
  error?: string;
}

// ── Email (Gmail) ───────────────────────────────────────────
export interface GmailStatus {
  hasClient: boolean;
  connected: boolean;
  email?: string;
  /** Calendar access granted (needs a fresh sign-in after Calendar was added). */
  calendar?: boolean;
  /** Contacts + directory access granted (names and autocomplete). */
  contacts?: boolean;
  /** Permission to create Gmail filters (auto-archive rules). */
  filters?: boolean;
  error?: string;
}

/** A blank new email: the reply box treats a thread with only a draft as a standalone email. */
export const NEW_EMAIL: EmailThreadDetail = {
  id: "", subject: "", snippet: "", from: "", lastFrom: "", lastFromMe: true, date: 0, count: 0, unread: false, starred: false, important: false, inInbox: false,
  messages: [], draft: { id: "", body: "", to: [], cc: [], subject: "" },
};

/** Mail folders, as Gmail queries. */
export const MAIL_FOLDERS = { drafts: "in:draft", sent: "in:sent" } as const;
export const mailFolder = (query: string): "inbox" | "drafts" | "sent" | "search" => (!query ? "inbox" : query === MAIL_FOLDERS.drafts ? "drafts" : query === MAIL_FOLDERS.sent ? "sent" : "search");

export interface EmailThread {
  id: string;
  subject: string;
  snippet: string;
  /** Up to three participants, "me" for you. */
  from: string;
  lastFrom: string;
  lastFromMe: boolean;
  /** Who the latest message went to (first names), for Sent and Drafts. */
  to?: string;
  date: number;
  count: number;
  unread: boolean;
  starred: boolean;
  important: boolean;
  inInbox: boolean;
}

export interface EmailMessage {
  id: string;
  from: string;
  fromEmail: string;
  fromMe: boolean;
  to: string;
  cc: string;
  date: number;
  /** New text only (quoted history stripped). */
  text: string;
  /** Original HTML body, when the email has one (rendered sandboxed). */
  html?: string;
  attachments: EmailAttachment[];
  unread: boolean;
}

export interface EmailAttachment {
  name: string;
  mimeType: string;
  size: number;
  /** Gmail attachment id (with the message id, fetches the file). */
  id: string;
}

export interface EmailThreadDetail extends EmailThread {
  messages: EmailMessage[];
  /** Your saved draft on this thread (latest), opened in the reply box to edit or send. */
  draft?: { id: string; body: string; to: string[]; cc: string[]; subject: string; html?: string; from?: string };
}

export interface Inbox {
  fetchedAt: number;
  /** Gmail search for the list ("" = the inbox). */
  query: string;
  /** 0-based page index, 50 threads per page. */
  page: number;
  pageSize: number;
  threads: EmailThread[];
  /** Starred threads pinned above the inbox (only when not searching). */
  starred: EmailThread[];
  hasNext: boolean;
  /** Threads in the inbox (Gmail's count), or Gmail's estimate for a search. */
  total: number;
  /** Unread inbox threads that are starred or marked Important by Gmail. */
  importantUnread: number;
  loading?: boolean;
  error?: string;
}

export interface Contact {
  email: string;
  name: string;
  source: "directory" | "contacts" | "other" | "mail";
}

export interface TriageRun {
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  total: number;
  verdicts: TriageVerdict[];
  /** Thread ids checked for archiving (your edits are kept). */
  picked: string[];
  error?: string;
}

export interface TriageVerdict {
  id: string;
  subject?: string;
  from?: string;
  verdict: "archive" | "reply" | "keep";
  reason: string;
}

// ── Calendar ────────────────────────────────────────────────
export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  /** ISO dateTime, or YYYY-MM-DD for all-day events. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees: Array<{ email: string; name?: string; response?: string; self?: boolean; organizer?: boolean }>;
  meetLink?: string;
  htmlLink?: string;
  /** Your response: accepted / declined / tentative / needsAction. */
  myResponse?: string;
  organizerSelf: boolean;
  color?: string;
  recurring: boolean;
}

/** What the create/edit form sends. */
export interface EventInput {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  addMeet?: boolean;
}

// ── App settings ────────────────────────────────────────────
export interface AppSettings {
  /** Which app sections appear in the sidebar. */
  show: { manager: boolean; cloud: boolean; analytics: boolean; tasks: boolean; email: boolean; calendar: boolean; terminal: boolean };
  /** Start agents with max permissions (Claude bypass / Codex full access / Cursor full) in each area. */
  bypass: { sessions: boolean; tasks: boolean; manager: boolean; cloud: boolean; email: boolean };
  /** Engine for new chats and task agents. */
  defaultEngine: Engine;
  /** Default model per engine (unset = the engine's own default). */
  models: Partial<Record<Engine, string>>;
  /** Claude model for app helpers: email drafts, zero inbox, event parsing, board summaries, simplify. */
  helperModel: string;
  /** Phone access over Tailscale. */
  remote: { enabled: boolean; keepAwake: boolean };
  /** Main repo: where new chats, Cloud fixes and task agents start (and whose project config is read). */
  repo: string;
  /** Your session tags, offered in every session's menu and the palette. */
  tags: TagDef[];
  /** After each reply, the agent checks the auto tags (see TagDef.auto) against the session's work. */
  autoTags: boolean;
  /** Who Happy writes as (email drafts, zero inbox, events, tasks). Email falls back to the connected Gmail account. */
  profile: { name: string; email: string; company: string; signoff: string; style: string };
  /** Codex API-equivalent prices (USD per 1M tokens) by model; built-in defaults fill the gaps. Refreshed daily. */
  codexPrices?: Record<string, { input: number; cached: number; output: number }>;
  codexPricesAt?: number;
  /** After each reply, ask the same agent (out of sight) for 2–4 next steps and offer them as chips. */
  nextSteps: boolean;
  /** App zoom level (Chromium steps: 0 = 100%, each step ≈ 20%). */
  zoom?: number;
}

export interface RemoteDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
}

export interface RemoteStatus {
  enabled: boolean;
  serving: boolean;
  url?: string;
  tailscale: { installed: boolean; running: boolean; dnsName?: string; login?: string; error?: string };
  pairingCode?: { value: string; expires: number };
  devices: RemoteDevice[];
  keepAwake: boolean;
  message?: string;
}

export interface SessionGroup {
  id: string;
  name: string;
  collapsed?: boolean;
}

/** A Codex thread that can be imported into Happy (Settings → Import). */
export interface CodexThreadInfo {
  id: string;
  title: string;
  cwd: string;
  model?: string;
  updatedAt: number;
  /** Happy session already holding this thread, if imported. */
  imported?: string;
}

export type ItemKind = "user" | "assistant" | "thinking" | "tool" | "system" | "error" | "tags";

export interface TranscriptItem {
  id: string;
  kind: ItemKind;
  text: string;
  /** kind=tags: what the agent's tag check changed. */
  tagsAdded?: string[];
  tagsRemoved?: string[];
  /** Tool name for kind=tool. */
  tool?: string;
  /** Extra detail (tool input/output), shown collapsed. */
  detail?: string;
  status?: "running" | "done" | "failed";
  /** Absolute paths of images attached to / produced by this item (served via hubfile://). */
  images?: string[];
  /** Non-image files the user attached (absolute paths). */
  files?: string[];
  /** File this tool call touched (opens in the preview pane). */
  path?: string;
  /** Before/after text for edit tools (shown as a diff). */
  diff?: { before: string; after: string };
  /** Pinned by you (listed in the Pinned pane). */
  pinned?: boolean;
  /** Plain-language rewrite of an assistant reply (shown instead of the original until toggled). */
  simplified?: string;
  /** Tool wall time and a one-line result ("7 hits", "exit 0"). */
  durationMs?: number;
  result?: string;
  ts: number;
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  reason?: string;
}

/** A session tag and what it means. */
export interface TagDef {
  name: string;
  /** What the tag means, in words the agent can check against the session's work. */
  description: string;
  /** The agent adds and removes it after each reply. Off = only you set it (e.g. qa). */
  auto: boolean;
}

/** A suggested next message, offered after an agent's reply (asked of the same agent, out of sight). */
export interface NextStep {
  /** Short chip text. */
  label: string;
  /** What gets sent when you pick it. */
  message: string;
}

export interface SessionState extends SessionMeta {
  status: SessionStatus;
  /** Next steps for the latest reply (gone once you send anything). */
  nextSteps?: NextStep[];
  items: TranscriptItem[];
  pending?: PermissionRequest;
  costUsd?: number;
  /** Tokens processed (input + cache writes + output, excluding cache reads). */
  tokens?: number;
  /** Total time spent working, plus the start of the current turn if running. */
  activeMs?: number;
  turnStartedAt?: number;
  lastError?: string;
  /** Live: background tasks + processes running in the session's folders. */
  processes?: SessionProcess[];
  /** Messages you sent while it was working, waiting for the turn to end (editable / removable / send now). */
  queued?: QueuedMessage[];
}

export interface QueuedMessage {
  id: string;
  text: string;
  images?: string[];
  files?: string[];
  at: number;
}

export interface SessionProcess {
  /** "task" = a Claude background task (shell/subagent); "os" = a process running inside the session's folder. */
  source: "task" | "os";
  id: string; // task id or pid
  pid?: number;
  label: string; // description or command line
  kind?: string; // task type, or process name
  status?: string;
  startedAt?: number;
  cwd?: string;
}

export interface GitChange {
  path: string; // absolute
  rel: string;
  status: "M" | "A" | "D" | "R" | "?";
  add: number;
  del: number;
}

export interface LimitWindow {
  /** "5h", "week", "week opus"… */
  label: string;
  /** Percent of the window used (null when the provider reported a status but no number). */
  usedPct: number | null;
  resetsAt?: number; // ms epoch
  status?: string;
}

export interface EngineLimits {
  claude?: { windows: LimitWindow[]; at: number };
  codex?: { windows: LimitWindow[]; plan?: string; at: number };
  /** Cursor's CLI exposes no remaining-usage numbers; we show the plan tier and tokens used today. */
  cursor?: { tier?: string; at: number };
  /** Tokens used today per engine (tracked by this app). */
  today?: Partial<Record<Engine, number>>;
}

export interface StatsDay {
  date: string; // YYYY-MM-DD, local
  commits: number;
  added: number;
  deleted: number;
  messages: number;
  tokens: number;
  costUsd: number;
}

/** The Stats page (click the logo): 13 weeks of commits, lines changed, messages and tokens. */
export interface HappyStats {
  generatedAt: number;
  repo: string;
  email: string;
  range: "3m" | "6m" | "1y" | "all";
  days: StatsDay[];
  streak: { current: number; longest: number };
  /** Lines of code in the repo today (non-blank; no libraries, generated files, migrations or data). */
  loc?: { total: number; byLang: Array<{ lang: string; lines: number; files: number }>; byArea: Array<{ area: string; lines: number }> };
  error?: string;
}

export interface UsageTotals {
  tokens: number;
  costUsd: number;
}

export interface CreateSessionInput {
  engine: Engine;
  cwd: string;
  title?: string;
  model?: string;
  prompt?: string;
  /** Attachments (absolute paths) sent with the first prompt. */
  images?: string[];
  files?: string[];
  effort?: string;
  codexSandbox?: CodexSandbox;
  cursorMode?: CursorMode;
  /** Create a dedicated branch + worktree for this session (cwd must be inside a git repo). */
  worktree?: boolean;
  permissionMode?: ClaudePermissionMode;
  /** Resume an existing Claude Code session / Codex thread by its engine id. */
  resumeId?: string;
  /** Name the worktree/branch from this instead of an AI-generated title. */
  worktreeName?: string;
  linearIssue?: string;
  /** Sidebar group to file the session under (found or created by name). */
  group?: string;
  /** Hidden context sent ahead of the first prompt (shown in the transcript without it). */
  context?: string;
}

/** Spin a session off a Cloud item: "ask" = read-only investigation with the board's context, "fix" = coding session on its own branch. */
export interface CloudSpawnInput {
  board: string;
  mode: "ask" | "fix";
  title: string;
  prompt: string;
}

export type PermissionDecision = "allow" | "allow_always" | "deny";
/** Extra payload for question / plan prompts: AskUserQuestion answers (question → answer) or plan feedback. */
export interface PermissionExtra {
  answers?: Record<string, string>;
  feedback?: string;
}

export interface ExternalClaudeSession {
  sessionId: string;
  summary: string;
  cwd?: string;
  gitBranch?: string;
  lastModified: number;
}

export interface BrowserState {
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** A right-click inside the browser pane: where (app page coords) and what was under the mouse. */
export interface BrowserMenu {
  sessionId: string;
  x: number;
  y: number;
  /** The click in the page's own coords (for Inspect). */
  pageX: number;
  pageY: number;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  selectionText: string;
  isEditable: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export type BrowserEdit = "copy" | "cut" | "paste" | "selectAll" | "inspect";

export type FileContent =
  | { kind: "text"; text: string; size: number }
  | { kind: "image" | "pdf" | "binary"; size: number }
  | { kind: "missing" }
  | { kind: "too_large"; size: number };

export interface ResolvedLink {
  path: string;
  kind: "file" | "image" | "dir" | "missing";
  line?: number;
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface GcloudStatus {
  installed: boolean;
  account?: string;
  /** gcloud user credentials valid (gcloud CLI commands work). */
  userOk: boolean;
  /** Application-default credentials valid (client libraries / local scripts). */
  adcOk: boolean;
  checkedAt: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Renderer-facing API exposed by preload. */
export interface HubApi {
  list(): Promise<SessionState[]>;
  create(input: CreateSessionInput): Promise<SessionState>;
  send(id: string, text: string, images?: string[], files?: string[]): Promise<void>;
  setModel(id: string, model: string | null): Promise<void>;
  setEffort(id: string, effort: string | null): Promise<void>;
  setCodexSandbox(id: string, mode: CodexSandbox): Promise<void>;
  codexModels(): Promise<CodexModelInfo>;
  cursorModels(): Promise<Array<{ id: string; name: string }>>;
  setCursorMode(id: string, mode: CursorMode): Promise<void>;
  setTags(id: string, tags: string[]): Promise<void>;
  setArchived(id: string, archived: boolean): Promise<void>;
  removeWorktree(id: string): Promise<{ branchDeleted: boolean }>;
  /** A copy of the chat that continues from here (Claude and Codex); returns the new chat. */
  forkSession(id: string): Promise<SessionState>;
  listWorktrees(id: string): Promise<RepoWorktree[]>;
  stopProcess(id: string, proc: { source: "task" | "os"; id: string }): Promise<void>;
  linkWorktree(id: string, path: string): Promise<void>;
  unlinkWorktree(id: string, path: string): Promise<void>;
  moveToGroup(id: string, groupId: string | null): Promise<void>;
  groups(): Promise<SessionGroup[]>;
  createGroup(name: string): Promise<SessionGroup>;
  renameGroup(groupId: string, name: string): Promise<void>;
  deleteGroup(groupId: string): Promise<void>;
  setGroupCollapsed(groupId: string, collapsed: boolean): Promise<void>;
  onGroups(cb: (g: SessionGroup[]) => void): () => void;
  interrupt(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  setPermissionMode(id: string, mode: ClaudePermissionMode): Promise<void>;
  respondPermission(requestId: string, decision: PermissionDecision, extra?: PermissionExtra): Promise<void>;
  pickFolder(): Promise<string | null>;
  listClaudeSessions(): Promise<ExternalClaudeSession[]>;
  saveAttachment(dataUrl: string): Promise<string>;
  pathForFile(file: File): string;
  readFile(path: string): Promise<FileContent>;
  resolveLink(sessionId: string, raw: string): Promise<ResolvedLink>;
  readDir(path: string): Promise<DirEntry[]>;
  /** Files in a checkout (tracked + untracked, minus .gitignore), relative to it. */
  listFiles(root: string): Promise<string[]>;
  /** Save an edited file; only inside that chat's folders. */
  writeFile(sessionId: string, path: string, text: string): Promise<void>;
  gitDiff(cwd: string, path: string): Promise<string>;
  gitChanges(cwd: string): Promise<GitChange[]>;
  usageToday(): Promise<UsageTotals>;
  limits(): Promise<EngineLimits>;
  onLimits(cb: (l: EngineLimits) => void): () => void;
  overview(refresh?: boolean): Promise<Overview>;
  onOverview(cb: (o: Overview) => void): () => void;
  onUsage(cb: (u: UsageTotals) => void): () => void;
  pickFile(cwd?: string): Promise<string | null>;
  pickFiles(cwd?: string): Promise<string[]>;
  revealFile(path: string): Promise<void>;
  /** Open in the Mac's default app (Preview for PDFs). */
  openFile(path: string): Promise<void>;
  browserSetBounds(sessionId: string, rect: Rect | null): Promise<void>;
  browserNavigate(sessionId: string, url: string): Promise<void>;
  browserNav(sessionId: string, action: "back" | "forward" | "reload" | "stop"): Promise<void>;
  browserState(sessionId: string): Promise<BrowserState | null>;
  onBrowserState(cb: (s: BrowserState) => void): () => void;
  onBrowserMenu(cb: (m: BrowserMenu) => void): () => void;
  /** The browser pane as an image (shown in its place while a menu is open over it). */
  browserSnapshot(sessionId: string): Promise<string | null>;
  browserEdit(sessionId: string, action: BrowserEdit, x?: number, y?: number): Promise<void>;
  onBrowserActivity(cb: (sessionId: string) => void): () => void;
  simplify(sessionId: string, itemId: string): Promise<void>;
  gcloudStatus(): Promise<GcloudStatus>;
  cloud(refresh?: boolean): Promise<CloudSnapshot | null>;
  /** Start the Manager or Cloud chat over (fresh conversation, same settings). */
  newSystemChat(id: string): Promise<SessionState>;
  /** The Cloud chat session (created on first use). */
  cloudChat(): Promise<SessionState>;
  emailChat(): Promise<SessionState>;
  /** Download an attachment to a local file (cached) and return its path. */
  emailAttachment(messageId: string, attachment: EmailAttachment): Promise<string>;
  /** Ask the Mail chat; the open thread (if any) goes along as context. */
  emailAsk(text: string, threadId?: string): Promise<void>;
  /** Send to the Cloud chat with the given board ("all" or a tenant) attached as context. */
  cloudSpawn(input: CloudSpawnInput): Promise<SessionState>;
  cloudAsk(text: string, board: string): Promise<void>;
  /** Restart the desktop app, optionally running `npm run build` first (refuses to restart if the build fails). */
  restartApp(rebuild: boolean): Promise<boolean>;
  codexThreads(): Promise<CodexThreadInfo[]>;
  pinItem(sessionId: string, itemId: string, pinned: boolean): Promise<void>;
  /** Codex prices in effect (defaults + yours), and refresh them from the web now. */
  codexPrices(): Promise<Record<string, { input: number; cached: number; output: number }>>;
  refreshCodexPrices(): Promise<boolean>;
  linkPreview(url: string): Promise<LinkPreview | null>;
  /** Claude models your account can use, as Claude Code last reported them (empty = not known yet). */
  claudeModels(): Promise<Array<{ id: string; label: string }>>;
  routines(): Promise<Routine[]>;
  /** A routine chat's runs, newest first. */
  routineRuns(id: string): Promise<RoutineRun[]>;
  /** Show one run in a routine chat (null = follow the latest). */
  showRoutineRun(id: string, runId: string | null): Promise<void>;
  /** Open a web link in Chrome (else the default browser), outside Happy. */
  openInChrome(url: string): Promise<void>;
  /** The main repo's .happy/config.json (environments, deploys…); {} when there is none. */
  projectConfig(): Promise<ProjectConfig>;
  analytics(q: AnalyticsQuery): Promise<AnalyticsSnapshot>;
  stats(refresh?: boolean, range?: HappyStats["range"]): Promise<HappyStats>;
  termCreate(id: string, cwd: string, cols: number, rows: number, command?: string): Promise<{ id: string; cwd: string; buffer: string }>;
  termList(): Promise<Array<{ id: string; cwd: string; buffer: string }>>;
  /** Run a command from a chat in that chat's terminal (opened in its side panel); the output goes back to the agent. */
  termRun(sessionId: string, command: string): Promise<string>;
  termIdle(): Promise<string[]>;
  deployStarted(job: Omit<DeployJob, "status" | "startedAt">): Promise<void>;
  deployJobs(): Promise<DeployJob[]>;
  deployDismiss(id: string): Promise<void>;
  onDeployJobs(cb: (jobs: DeployJob[]) => void): () => void;
  termWrite(id: string, data: string): Promise<void>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  termKill(id: string): Promise<void>;
  onTermData(cb: (e: { id: string; data: string }) => void): () => void;
  onTermExit(cb: (id: string) => void): () => void;
  editQueued(sessionId: string, queuedId: string, text: string): Promise<void>;
  removeQueued(sessionId: string, queuedId: string): Promise<void>;
  /** Deliver a queued message now: Claude takes it mid-turn; Codex/Cursor stop the turn first. */
  sendQueuedNow(sessionId: string, queuedId: string): Promise<void>;
  addTodo(sessionId: string, todo: { kind: SessionTodo["kind"]; text: string; due?: number }): Promise<void>;
  updateTodo(sessionId: string, todoId: string, patch: Partial<Pick<SessionTodo, "text" | "due" | "done">>): Promise<void>;
  removeTodo(sessionId: string, todoId: string): Promise<void>;
  /** Import Codex threads (resumed in place, recent history shown); returns the Happy session ids. */
  importCodex(ids: string[]): Promise<string[]>;
  remoteStatus(): Promise<RemoteStatus>;
  remoteEnable(on: boolean): Promise<RemoteStatus>;
  remoteNewCode(): Promise<RemoteStatus>;
  remoteRemoveDevice(id: string): Promise<RemoteStatus>;
  /** True in the phone (web) build, false in the desktop window. */
  isRemote?: boolean;
  settings(): Promise<AppSettings>;
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  onSettings(cb: (s: AppSettings) => void): () => void;
  /** A reminder notification was clicked: show this session. */
  onFocusSession(cb: (id: string) => void): () => void;
  gmailStatus(): Promise<GmailStatus>;
  calendarEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
  calendarSave(input: EventInput, opts: { id?: string; notify: boolean }): Promise<CalendarEvent>;
  calendarDelete(id: string, notify: boolean): Promise<void>;
  calendarRespond(id: string, response: "accepted" | "declined" | "tentative"): Promise<void>;
  /** Claude turns a description into a filled-in event form (nothing is created). */
  calendarParse(text: string): Promise<EventInput>;
  onCalendarChanged(cb: () => void): () => void;
  gmailSetClient(clientId: string, clientSecret: string): Promise<GmailStatus>;
  gmailSignIn(): Promise<GmailStatus>;
  gmailSignOut(): Promise<void>;
  inbox(refresh?: boolean): Promise<Inbox>;
  /** Show a page of the inbox or of a Gmail search ("" = inbox). */
  inboxPage(query: string, page: number): Promise<Inbox>;
  onInbox(cb: (i: Inbox) => void): () => void;
  emailThread(id: string): Promise<EmailThreadDetail>;
  emailStar(id: string, on: boolean): Promise<void>;
  emailArchive(ids: string[]): Promise<void>;
  /** Report threads as spam (moved to Spam; Gmail learns from it). */
  emailSpam(ids: string[]): Promise<void>;
  /** Create a Gmail filter that archives mail from `from` (address or "@domain"); optionally archive what's already there. */
  emailAutoArchive(from: string, archiveExisting: boolean): Promise<number>;
  /** Archive everything in the inbox; returns the number of messages archived. */
  emailArchiveAll(keepStarred: boolean): Promise<number>;
  emailDraft(threadId: string, instruction?: string, to?: string[]): Promise<string>;
  emailReplyDefaults(threadId: string): Promise<{ to: string[]; cc: string[]; from?: string }>;
  emailSaveDraft(threadId: string, body: string, rcpt: { to: string[]; cc: string[] }, draftId?: string, subject?: string, from?: string, html?: string): Promise<string>;
  /** Addresses you can send as, default first. */
  emailSendAs(): Promise<EmailSendAs[]>;
  contacts(): Promise<Contact[]>;
  emailSend(draftId: string): Promise<void>;
  /** Start a zero-inbox run (replaces the saved one). */
  emailTriage(): Promise<TriageRun>;
  /** The saved zero-inbox run, if any. */
  emailTriageRun(): Promise<TriageRun | null>;
  emailTriagePick(picked: string[]): Promise<void>;
  emailTriageClear(): Promise<void>;
  onTriage(cb: (r: TriageRun | null) => void): () => void;
  onGoogleStatus(cb: (s: GmailStatus) => void): () => void;
  linearStatus(): Promise<LinearStatus>;
  linearSetKey(key: string): Promise<LinearStatus>;
  linearClearKey(): Promise<void>;
  tasks(scope: TaskScope, refresh?: boolean): Promise<TaskList>;
  onTasks(cb: (t: TaskList) => void): () => void;
  taskDetail(id: string): Promise<LinearIssueDetail>;
  linearMeta(): Promise<LinearMeta>;
  linearUpdate(id: string, input: LinearIssueInput): Promise<void>;
  linearCreate(input: LinearIssueInput): Promise<{ id: string; identifier: string; url: string }>;
  /** Claude turns a description into a filled-in issue form (nothing is created). */
  linearParse(text: string): Promise<LinearIssueInput>;
  /** Start an agent on an issue (own worktree); returns the new session. */
  startTask(issueId: string, engine: Engine): Promise<SessionState>;
  onCloud(cb: (c: CloudSnapshot) => void): () => void;
  gcloudLogin(kind: "user" | "adc"): Promise<boolean>;
  onGcloudLog(cb: (line: string) => void): () => void;
  setBadge(count: number): Promise<void>;
  attention(): Promise<void>;
  onUpdate(cb: (s: SessionState) => void): () => void;
  onRemoved(cb: (id: string) => void): () => void;
}

/** Manager and Cloud chat: app-owned sessions that never appear in the session list or the board. */
/** Idle between turns but something it started is still going (a background task or a process in its folder). */
export const inBackground = (s: { status: SessionStatus; processes?: unknown[]; preparing?: boolean }) => s.status === "idle" && !s.preparing && !!s.processes?.length;

export const isSystemSession = (m: { isManager?: boolean; isCloud?: boolean; isEmail?: boolean }) => !!(m.isManager || m.isCloud || m.isEmail);
