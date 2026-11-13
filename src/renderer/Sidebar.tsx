import { dueLabel, isOverdue, openTodos } from "./Todos";
import { Grid2x2, LayoutList } from "lucide-react";
import { grid, useGrid } from "./grid";
import { Activity, CalendarDays, Cloud, LayoutDashboard, ListChecks, Mail, Plus, Settings, SquareTerminal } from "lucide-react";
import { useTerminalCount } from "./TerminalView";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { inBackground, isClosedIssue, isSystemSession } from "../shared/types";
import type { GitDeploy, GitInfo, Overview, SessionGroup, SessionState, CloudSnapshot, CalendarEvent, Inbox, TaskList } from "../shared/types";
import { hub } from "./App";
import { useMenu } from "./Menu";
import { engineCode, relTime, lastMessageAt, num } from "./models";
import { sessionMenuItems } from "./sessionMenu";
import { useSettings } from "./settings";
import { useToast } from "./toast";

export const DRAG_TYPE = "application/x-session-id";
const STATUS_ALIASES: Record<string, string> = { running: "running", waiting: "needs_permission", error: "error", failed: "error", idle: "idle" };

/** Filter syntax: free text matches titles; tag:x, is:running|waiting|error|idle|background or a stage (is:qa, is:done, is:merged…), eng:cc|cx. */
export function matchesFilter(s: SessionState, q: string): boolean {
  for (const tok of q.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const [k, v] = tok.includes(":") ? tok.split(/:(.*)/) : ["", tok];
    if (k === "tag") {
      if (!s.tags?.some((t) => t.includes(v))) return false;
    } else if (k === "is") {
      if (v === "background" || v === "bg") {
        if (!inBackground(s)) return false;
      } else if (STAGES.includes(v)) {
        if (stageLabel(s) !== v) return false;
      } else if (s.status !== (STATUS_ALIASES[v] ?? v)) return false;
    } else if (k === "eng") {
      const alias = v === "cc" ? "claude" : v === "cx" ? "codex" : v;
      if (!s.engine.startsWith(alias)) return false;
    } else if (!s.title.toLowerCase().includes(tok)) return false;
  }
  return true;
}

const STAGES = ["uncommitted", "committed", "merged", "qa", "done"];
const STATUS_WORD: Record<string, string> = { running: "running", needs_permission: "waiting", error: "failed" };

/** Deploy state only belongs to a session when its branch did work (commits of its own, merged or not). */
const hasOwnWork = (g: GitInfo) => g.merged || !!g.hadWork;

/** Uncommitted / unmerged / merged + per-tenant deploy chips for one checkout. */
function GitBadges({ g, showBranch }: { g: GitInfo; showBranch?: boolean }) {
  // Chips only once the session's own work is in main.
  const showDeploys = !!g.deploys && g.merged;
  return (
    <>
      {g.dirty > 0 && (
        <span className="gb dirty">
          ±{num(g.dirty)}
        </span>
      )}
      {g.ahead > 0 && (
        <span className="gb ahead">
          ↑{num(g.ahead)}
        </span>
      )}
      {g.merged && (
        <span className="gb merged">
          merged
        </span>
      )}
      {showBranch && !g.onMain && !g.merged && g.ahead === 0 && g.dirty === 0 && <span className="gb clean">{g.branch}</span>}
      {showDeploys &&
        g.deploys!.filter((d) => !d.touched || d.touched.length).map((d) => {
          return (
            <span
              key={d.tenant}
              className={`dep ${deployClass(d, g)}`}
              title={`${d.tenant}: ${deployText(d, g)}`}
            >
              {d.tenant}
            </span>
          );
        })}
    </>
  );
}

interface Checkout {
  key: string;
  label: string;
  path: string;
  git?: GitInfo;
  note?: string;
}

/** Every checkout a session works in: its own folder/worktree plus worktrees it created or you linked. */
function checkouts(s: SessionState): Checkout[] {
  const out: Checkout[] = [];
  if (!s.worktree?.removed) {
    out.push({
      key: s.cwd,
      label: s.worktree?.branch ?? s.git?.branch ?? "checkout",
      path: s.cwd,
      git: s.git,
      note: s.worktree ? "worktree" : s.git?.onMain ? "main" : "folder",
    });
  }
  for (const w of s.linkedWorktrees ?? []) {
    if (w.removed) continue;
    out.push({ key: w.path, label: w.branch ?? w.path.split("/").pop()!, path: w.path, git: w.git, note: w.source === "detected" ? "agent's worktree" : "linked" });
  }
  // Started in the main checkout, then the work moved to a worktree: the worktree is what matters.
  return out.length > 1 && out[0].note === "main" ? out.slice(1) : out;
}

type Stage = "uncommitted" | "committed" | "merged";
/** A checkout's code stage (undefined = nothing of its own yet). */
const stageOf = (g?: GitInfo): Stage | undefined => (!g ? undefined : g.dirty > 0 ? "uncommitted" : g.merged ? "merged" : g.ahead > 0 && !g.onMain ? "committed" : g.onMain && g.ahead > 0 ? "committed" : undefined);
const STAGE_ORDER: Stage[] = ["uncommitted", "committed", "merged"];
/** The session's stage: the earliest across its checkouts (one branch still uncommitted means the work isn't done). */
export function sessionStage(s: SessionState): { stage?: Stage; deploy?: "pending" | "deployed" } {
  const stages = checkouts(s).map((c) => stageOf(c.git)).filter((x): x is Stage => !!x);
  const stage = STAGE_ORDER.find((x) => stages.includes(x));
  if (stage !== "merged") return { stage };
  const ds = checkouts(s).flatMap((c) => (c.git?.merged ? (c.git.deploys ?? []).filter((d) => !d.touched || d.touched.length) : []));
  if (!ds.length) return { stage };
  return { stage, deploy: ds.some((d) => !d.full && (d.touched ?? Object.keys(d.parts)).some((p) => !d.parts[p])) ? "pending" : "deployed" };
}

/** The commits a chat's work is at (one per checkout): what a QA sign-off is tied to. */
export const workHeads = (s: SessionState) => checkouts(s).map((c) => c.git?.head).filter((h): h is string => !!h).sort();

/**
 * The stage pill a chat shows. Merged and live everywhere is "qa" until you mark it checked, then "done"; new
 * commits after that put it back in "qa". Merged but not live yet stays "merged".
 */
export function stageLabel(s: SessionState): string | undefined {
  const { stage, deploy } = sessionStage(s);
  if (stage !== "merged" || deploy !== "deployed") return stage;
  const heads = workHeads(s);
  return s.qaDone && heads.length && heads.join() === [...s.qaDone.heads].sort().join() ? "done" : "qa";
}

/** The branch a chat is working on: its most recently active checkout. */
const workBranch = (s: SessionState) => {
  const all = checkouts(s);
  return all.length ? [...all].sort((a, b) => activity(b) - activity(a))[0].label : (s.worktree?.branch ?? s.git?.branch);
};

const agoText = (ts: number) => {
  const r = relTime(ts);
  return /^\d+[mhd]$/.test(r) ? `${r} ago` : r === "now" ? "just now" : `on ${r}`;
};

/** Most recently active checkout: uncommitted work counts as "now", else latest commit. */
const activity = (c: Checkout) => (c.git?.dirty ? Date.now() : (c.git?.headTime ?? 0));

/** Manager row subtitle: what the board says at a glance. */
/** One compact line in the top nav: icon, label, a count or short status on the right (details in the tooltip). */
const NAV_KEYS: Record<string, string> = { Manager: "⌘1", Cloud: "⌘2", Tasks: "⌘3", Mail: "⌘4", Calendar: "⌘5", Terminal: "⌘6", "Chat wall": "⌘7", "Chat grid": "⌘8" };

function NavItem(props: { icon: React.ReactNode; label: string; right?: React.ReactNode; tone?: "hot" | "warn" | "dim"; title?: string; active: boolean; onClick(): void }) {
  return (
    <div className={`nav-row ${props.active ? "on" : ""}`} onClick={props.onClick} title={props.title}>
      <span className="nav-ic">{props.icon}</span>
      <span className="nav-label">{props.label}</span>
      {NAV_KEYS[props.label] && <span className="nav-kbd">{NAV_KEYS[props.label]}</span>}
      {props.right != null && props.right !== "" && <span className={`nav-n ${props.tone ?? ""}`}>{props.right}</span>}
    </div>
  );
}

/** Chat grid entry: how many chats are in it. */
function GridNav({ active, onClick }: { active: boolean; onClick(): void }) {
  const n = useGrid().length;
  return <NavItem icon={<Grid2x2 size={14} />} label="Chat grid" right={n || ""} tone="dim" title={n ? `${n} chats side by side` : "Pick chats to see side by side"} active={active} onClick={onClick} />;
}

/** Manager entry: how many chats are working; board facts in the tooltip. */
function ManagerNav({ s, working, active, onClick }: { s: SessionState; working: number; active: boolean; onClick(): void }) {
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => {
    hub().overview().then(setO);
    return hub().onOverview(setO);
  }, []);
  const errs = o?.gcp?.tenants.reduce((n, t) => n + t.total, 0) ?? 0;
  return (
    <NavItem
      icon={<LayoutDashboard size={14} />}
      label="Manager"
      right={s.status === "running" ? "thinking" : working ? `${working} active` : o?.unfinished.length ? `${num(o.unfinished.length)} to merge` : ""}
      tone={s.status === "needs_permission" ? "warn" : "dim"}
      title={o ? `${num(o.recent.length)} done in 24h · ${num(o.unfinished.length)} unmerged · ${errs} production errors` : undefined}
      active={active}
      onClick={onClick}
    />
  );
}

export const CLOUD = "cloud";

/** The Cloud dashboard entry: worst health dot + which tenants need attention. */
function CloudRow({ active, onClick }: { active: boolean; onClick(): void }) {
  const [c, setC] = useState<CloudSnapshot | null>(null);
  useEffect(() => {
    hub().cloud().then(setC);
    return hub().onCloud(setC);
  }, []);
  const tenants = c?.tenants ?? [];
  const fine = tenants.filter((t) => t.health === "ok").map((t) => t.tenant);
  const issues = tenants.reduce((n, t) => n + t.issues.length, 0);
  return (
    <NavItem
      icon={<Cloud size={14} />}
      label="Cloud"
      right={!c ? "" : !c.authOk ? "sign in" : issues || "ok"}
      tone={!c?.authOk ? "warn" : issues ? undefined : "dim"}
      title={c?.authOk ? [...tenants.filter((t) => t.health !== "ok").map((t) => `${t.tenant} ${num(t.issues.length)}`), fine.length ? `${fine.join(" ")} ok` : ""].filter(Boolean).join(" · ") : "gcloud login expired"}
      active={active}
      onClick={onClick}
    />
  );
}

export const TASKS = "tasks";
export const ANALYTICS = "analytics";

/** The Analytics entry: product events from PostHog ("connect" until a key is added). */
function AnalyticsRow({ active, onClick }: { active: boolean; onClick(): void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    const load = () => void hub().analyticsStatus().then((s) => setConnected(s.connected));
    load();
    window.addEventListener("happy:posthog", load);
    return () => window.removeEventListener("happy:posthog", load);
  }, []);
  return <NavItem icon={<Activity size={14} />} label="Analytics" right={connected === false ? "connect" : ""} tone="dim" title={connected === false ? "connect PostHog" : "Product events from PostHog"} active={active} onClick={onClick} />;
}
export const EMAIL = "email";
export const CALENDAR = "calendar";
export const SETTINGS = "settings";
export const TERMINAL = "terminal";
export const STATS = "stats";
export const CHAT_WALL = "chatwall";
export const GRID = "grid";

function TerminalNav({ active, onClick }: { active: boolean; onClick(): void }) {
  const n = useTerminalCount();
  return <NavItem icon={<SquareTerminal size={14} />} label="Terminal" right={n || ""} tone="dim" title={n ? `${n} shell${n === 1 ? "" : "s"} running` : "Open a shell in your main repo"} active={active} onClick={onClick} />;
}

/** The Calendar entry: what's next today. */
function CalendarRow({ active, onClick }: { active: boolean; onClick(): void }) {
  const [ok, setOk] = useState<boolean | null>(null);
  const [today, setToday] = useState<CalendarEvent[] | null>(null);
  const [, tick] = useState(0);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      const st = await hub().gmailStatus();
      if (stop) return;
      setConnected(st.connected);
      setOk(!!st.calendar);
      if (!st.calendar) return;
      const d = new Date();
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
      setToday(await hub().calendarEvents(start.toISOString(), end.toISOString()).catch(() => null));
    };
    void load();
    const t = setInterval(() => void load(), 5 * 60_000);
    const m = setInterval(() => tick((n) => n + 1), 60_000);
    const off = hub().onCalendarChanged(() => void load());
    const offStatus = hub().onGoogleStatus(() => void load());
    return () => {
      stop = true;
      clearInterval(t);
      clearInterval(m);
      off();
      offStatus();
    };
  }, []);
  const now = Date.now();
  const timed = (today ?? []).filter((e) => !e.allDay && e.myResponse !== "declined");
  const next = timed.find((e) => +new Date(e.end) > now);
  const live = next && +new Date(next.start) <= now;
  const at = next ? (live ? "now" : new Date(next.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) : "";
  return (
    <NavItem
      icon={<CalendarDays size={14} />}
      label="Calendar"
      right={ok === false ? "connect" : at}
      tone={live ? "warn" : "dim"}
      title={ok === false ? (connected ? "sign in again for calendar" : "connect Google") : next ? `${at} · ${next.title}` : today ? "nothing else today" : undefined}
      active={active}
      onClick={onClick}
    />
  );
}

/** The Email entry: important unreads first. */
function EmailRow({ active, onClick }: { active: boolean; onClick(): void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  useEffect(() => {
    void hub()
      .gmailStatus()
      .then((st) => {
        setConnected(st.connected);
        if (st.connected) void hub().inbox().then(setInbox);
      });
    return hub().onInbox((i) => {
      setInbox(i);
      setConnected(true);
    });
  }, []);
  const inInbox = inbox?.total ?? 0;
  return (
    <NavItem
      icon={<Mail size={14} />}
      label="Mail"
      right={connected === false ? "connect" : inbox?.importantUnread || (inbox ? inInbox : "")}
      tone={inbox?.importantUnread ? undefined : "dim"}
      title={inbox ? `${num(inbox.importantUnread)} important unread · ${inInbox} in inbox` : connected === false ? "connect Gmail" : undefined}
      active={active}
      onClick={onClick}
    />
  );
}

/** The Tasks entry: open Linear issues assigned to you. */
function TasksRow({ active, onClick }: { active: boolean; onClick(): void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [t, setT] = useState<TaskList | null>(null);
  useEffect(() => {
    void hub()
      .linearStatus()
      .then((st) => {
        setConnected(st.connected);
        if (st.connected) void hub().tasks("mine").then(setT);
      });
    return hub().onTasks((x) => {
      if (x.scope === "mine") {
        setT(x);
        setConnected(true);
      }
    });
  }, []);
  const open = t?.issues.filter((i) => !isClosedIssue(i)) ?? [];
  const hot = open.filter((i) => i.priority === 1 || i.priority === 2).length;
  return (
    <NavItem
      icon={<ListChecks size={14} />}
      label="Tasks"
      right={connected === false ? "connect" : t ? (hot ? hot : open.length) : ""}
      tone={hot ? "hot" : "dim"}
      title={t ? `${num(open.length)} open${hot ? ` · ${hot} urgent/high` : ""}` : connected === false ? "connect Linear" : undefined}
      active={active}
      onClick={onClick}
    />
  );
}

/**
 * For a branch: only the parts it changed. "full" = in the latest full deploy; else the changed parts that are
 * deployed, and "pending" for the ones that aren't. (No branch info: "core" = every component.)
 */
const shortOf = (g: GitInfo | undefined, id: string) => g?.deployComponents?.find((c) => c.id === id)?.short ?? id;
const deployText = (d: GitDeploy, g?: GitInfo) => {
  const all = g?.deployComponents?.map((c) => c.id) ?? Object.keys(d.parts);
  if (d.touched) {
    if (!d.touched.length) return "";
    const done = d.touched.filter((c) => d.parts[c]);
    const todo = d.touched.filter((c) => !d.parts[c]);
    if (!todo.length) return d.full ? "full" : done.map((c) => shortOf(g, c)).join("+");
    return `${done.map((c) => shortOf(g, c)).join("+")}${done.length ? " · " : ""}${todo.map((c) => shortOf(g, c)).join("+")} pending`;
  }
  if (d.full) return "full";
  const done = all.filter((c) => d.parts[c]);
  return done.length && done.length === all.length ? "core" : done.map((c) => shortOf(g, c)).join("+") || "—";
};
const deployClass = (d: GitDeploy, g?: GitInfo) => {
  if (d.touched) return !d.touched.length ? "none" : d.touched.every((c) => d.parts[c]) ? (d.full ? "full" : "core") : d.touched.some((c) => d.parts[c]) ? "part pending" : "pending";
  const all = g?.deployComponents?.map((c) => c.id) ?? Object.keys(d.parts);
  return d.full ? "full" : all.length && all.every((c) => d.parts[c]) ? "core" : all.some((c) => d.parts[c]) ? "part" : "none";
};

/** A tag's meaning from Settings (hover text). */
let tagDefs: Record<string, string> = {};
const tagDescription = (t: string) => tagDefs[t] || undefined;
export const setTagDefs = (defs: Array<{ name: string; description: string }>) => void (tagDefs = Object.fromEntries(defs.map((d) => [d.name, d.description])));

/** Hover card for a whole session row: what it is, where it works, and what's deployed where. One at a time. */
function SessionCard({ s, x, y, onEnter, onLeave }: { s: SessionState; x: number; y: number; onEnter(): void; onLeave(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(y);
  // Keep the card on screen.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(y, window.innerHeight - h - 8)));
  }, [y, s]);
  const all = checkouts(s);
  const word = s.preparing ? "setting up" : inBackground(s) ? "background" : (STATUS_WORD[s.status] ?? "idle");
  return (
    <div className="wt-card" ref={ref} style={{ left: x, top }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="sc-title">{s.title}</div>
      <div className="sc-kv">
        <span className="sc-k">status</span>
        <span>
          <span className={`sc-pill st ${s.preparing ? "running" : inBackground(s) ? "background" : s.status}`}>{word}</span> <span className="muted">last active {agoText(lastMessageAt(s))}</span>
        </span>
        <span className="sc-k">agent</span>
        <span>
          <span className="sc-pill">{engineCode(s.engine, s.isManager)}</span> {s.model && <span className="sc-pill">{s.model.replace(/^claude-/, "")}</span>}
        </span>
        {!!s.tags?.length && (
          <>
            <span className="sc-k">tags</span>
            <span className="sc-tags">
              {s.tags.map((t) => (
                <span key={t} className="r-tag" title={tagDescription(t)}>
                  #{t}
                </span>
              ))}
            </span>
          </>
        )}
        {!!s.processes?.length && (
          <>
            <span className="sc-k">running</span>
            <span className="sc-procs">
              {s.processes.slice(0, 3).map((p) => (
                <span key={`${p.source}:${p.id}`}>{p.label}</span>
              ))}
              {s.processes.length > 3 && <span className="muted">+{s.processes.length - 3} more</span>}
            </span>
          </>
        )}
        {openTodos(s).length > 0 && (
          <>
            <span className="sc-k">todo</span>
            <span className="sc-procs">
              {openTodos(s)
                .slice(0, 3)
                .map((t) => (
                  <span key={t.id} className={isOverdue(t) ? "overdue" : ""}>
                    {t.text}
                    {t.due && <span className="muted"> · {dueLabel(t.due)}</span>}
                  </span>
                ))}
            </span>
          </>
        )}
      </div>
      {all.map((c) => (
        <BranchBlock key={c.key} c={c} />
      ))}
      {!all.length && <div className="wt-card-path">{s.cwd}</div>}
    </div>
  );
}

/** One branch in the hover card: its stage, then (once merged) where each changed part is deployed, and its packages. */
function BranchBlock({ c }: { c: Checkout }) {
  const g = c.git;
  const stage = stageOf(g);
  const comps = g?.deployComponents ?? [];
  const deploys = g && hasOwnWork(g) && g.merged ? (g.deploys ?? []).filter((d) => !d.touched || d.touched.length) : [];
  const cols = comps.filter((x) => deploys.some((d) => !d.touched || d.touched.includes(x.id)));
  return (
    <div className="sc-branch">
      <div className="sc-branch-h">
        <span className="sc-branch-name" title={c.path}>
          {c.label}
        </span>
        {stage ? <span className={`sc-stage s-${stage}`}>{stage}</span> : <span className="muted">{g ? "no changes" : "checking…"}</span>}
      </div>
      {g && (g.dirty > 0 || g.ahead > 0 || g.headTime) && (
        <div className="sc-facts">
          {g.dirty > 0 && <span>{num(g.dirty)} file{g.dirty === 1 ? "" : "s"} uncommitted</span>}
          {g.ahead > 0 && (
            <span>
              {num(g.ahead)} commit{g.ahead === 1 ? "" : "s"} not in {g.onMain ? "origin" : "main"}
            </span>
          )}
          {g.headTime && <span className="muted">last commit {agoText(g.headTime)}</span>}
        </div>
      )}
      {deploys.length > 0 && cols.length > 0 && (
        <div className="sc-dep">
          {deploys.map((d) => {
            const changed = d.touched ?? cols.map((x) => x.id);
            const pending = d.full ? [] : changed.filter((p) => !d.parts[p]);
            return (
              <span key={d.tenant} className={pending.length ? "pend" : "ok"} title={cols.map((x) => `${x.short} ${!changed.includes(x.id) ? "–" : d.full || d.parts[x.id] ? "deployed" : "pending"}`).join(" · ")}>
                {d.tenant} {pending.length ? pending.map((p) => cols.find((x) => x.id === p)?.short ?? p).join("+") : "✓"}
              </span>
            );
          })}
        </div>
      )}
      {!!g?.mcp?.length && (
        <table className="sc-table">
          <tbody>
            {g.mcp.map((m) => (
              <tr key={m.name}>
                <td>{m.name.replace(/^@[^/]+\//, "")}</td>
                <td className={m.state === "published" ? "ok" : "pend"} style={{ textAlign: "right" }}>
                  {m.state === "published" ? "published" : m.state === "unpublished" ? "publish needed" : "not bumped"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Row(props: {
  s: SessionState;
  active: boolean;
  unread?: "done" | "blocked" | "failed";
  renaming: boolean;
  onClick(e: React.MouseEvent): void;
  /** In the chat grid (marked with a small grid icon). */
  inGrid?: boolean;
  onContext(e: React.MouseEvent): void;
  onRenamed(): void;
  onTag(t: string): void;
  onHover(s: SessionState | null, el?: HTMLElement): void;
}) {
  const { s } = props;
  return (
    <div
      className={`r ${props.active ? "on" : ""} ${props.unread ? "unread" : ""} ${s.status}`}
      onMouseEnter={(e) => props.onHover(s, e.currentTarget)}
      onMouseLeave={() => props.onHover(null)}
      onClick={props.onClick}
      onContextMenu={props.onContext}
      draggable={!s.isManager && !props.renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, s.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <span className="r-line">
        <span className={`r-dot ${s.preparing ? "running" : inBackground(s) ? "background" : s.status}`} />
        {props.renaming ? (
          <input
            className="row-rename"
            defaultValue={s.title}
            autoFocus
            onFocus={(e) => e.target.select()}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              void hub().rename(s.id, e.target.value);
              props.onRenamed();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") props.onRenamed();
            }}
          />
        ) : (
          <span className="r-title">
            {s.title}
          </span>
        )}
        {props.inGrid && (
          <span className="r-ind r-grid" title="In the chat grid">
            <Grid2x2 size={11} />
          </span>
        )}
        {openTodos(s).length > 0 && <span className={`r-ind ${openTodos(s).some(isOverdue) ? "overdue" : ""}`} title="Open reminders and follow-ups">◷{openTodos(s).length}</span>}
        {!!s.processes?.length && <span className="r-ind" title="Running processes">⚙{num(s.processes.length)}</span>}
        {props.unread && (
          <span className={`alert ${props.unread}`}>{props.unread === "blocked" ? "needs you" : props.unread === "failed" ? "failed" : "done"}</span>
        )}
        <span className="r-time">{s.isManager ? "" : relTime(lastMessageAt(s))}</span>
      </span>
      {!s.isManager && <RowSub s={s} onTag={props.onTag} />}
    </div>
  );
}

/**
 * Second line: status | code stage | tags, in fixed columns so they line up down the list. Quiet states (idle,
 * no changes) are left blank, and a row with nothing to say stays one line.
 */
export function RowSub({ s, onTag }: { s: SessionState; onTag(t: string): void }) {
  const busy = s.preparing || s.status !== "idle" || inBackground(s);
  const cls = s.preparing ? "running" : inBackground(s) ? "background" : s.status;
  const label = stageLabel(s);
  if (!busy && !label && !s.tags?.length) return null; // nothing to say: one line
  return (
    <span className="r-sub2">
      {busy && <span className={`r-st st ${cls}`}>{s.preparing ? "setting up" : inBackground(s) ? "background" : STATUS_WORD[s.status]}</span>}
      {label && <span className={`sc-stage s-${label.replace(" ", "-")}`}>{label}</span>}
      <span className="r-tags">
        {s.tags?.map((t) => (
          <span
            key={t}
            className="r-tag"
            title={tagDescription(t)}
            onClick={(e) => {
              e.stopPropagation();
              onTag(t);
            }}
          >
            #{t}
          </span>
        ))}
      </span>
    </span>
  );
}

function Group(props: {
  title: string;
  members: SessionState[];
  collapsed?: boolean;
  onToggle?(): void;
  onDropSession?(id: string): void;
  onContext?(e: React.MouseEvent): void;
  renaming?: boolean;
  onRename?(name: string | null): void;
  extra?: React.ReactNode;
  /** Group color (unused in the compact sidebar). */
  color?: string;
  /** No header (ungrouped chats when there are no groups). */
  bare?: boolean;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`section-wrap ${over ? "drop-over" : ""}`}
      onDragOver={(e) => {
        if (!props.onDropSession || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id) props.onDropSession?.(id);
      }}
    >
      {!props.bare && <div className="gh" onClick={props.onToggle} onContextMenu={props.onContext}>
        {props.onToggle && <span className={`caret-icon ${props.collapsed ? "" : "open"}`}>›</span>}
        {props.renaming ? (
          <input
            className="row-rename"
            defaultValue={props.title}
            autoFocus
            onFocus={(e) => e.target.select()}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => props.onRename?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") props.onRename?.(null);
            }}
          />
        ) : (
          <span className="gh-title">{props.title}</span>
        )}
        <span className="gh-agg">
          {props.members.length > 0 && <span className="gh-count">{num(props.members.length)}</span>}
          {props.extra}
        </span>
      </div>}
      {!props.collapsed && (
        <div className={props.color ? "g-body" : undefined} style={props.color ? ({ ["--gc" as string]: props.color } as React.CSSProperties) : undefined}>
          {props.children}
        </div>
      )}
    </div>
  );
}

export function Sidebar(props: {
  sessions: SessionState[];
  groups: SessionGroup[];
  allTags: string[];
  selected: string | null;
  unread: Map<string, "done" | "blocked" | "failed">;
  filter: string;
  onFilter(q: string): void;
  onSelect(id: string): void;
  onNew(): void;
  width: number;
}) {
  const menu = useMenu();
  const toast = useToast();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onHover = (s: SessionState | null, el?: HTMLElement) => {
    clearTimeout(hoverTimer.current);
    // Leaving a row: give the pointer a moment to reach the card (it stays while you're on it, so you can scroll it).
    if (!s || !el) return void (hoverTimer.current = setTimeout(() => setHover(null), 300));
    const side = el.closest(".sidebar")!.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    hoverTimer.current = setTimeout(() => setHover({ id: s.id, x: side.right + 8, y: row.top - 4 }), 350);
  };
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // ⋯ → Rename in the top bar renames inline here.
  useEffect(() => {
    const on = (e: Event) => setRenaming((e as CustomEvent<string>).detail);
    window.addEventListener("rename-session", on);
    return () => window.removeEventListener("rename-session", on);
  }, []);

  // "/" focuses the filter (when not typing elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.key === "/" && !e.metaKey && !(el && /INPUT|TEXTAREA/.test(el.tagName))) {
        e.preventDefault();
        document.getElementById("session-filter")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtering = !!props.filter.trim();
  const ok = (s: SessionState) => matchesFilter(s, props.filter);
  const manager = props.sessions.find((s) => s.isManager);
  const show = useSettings()?.show ?? { manager: true, cloud: true, analytics: true, tasks: true, email: true, calendar: true, terminal: true };
  const live = props.sessions.filter((s) => !isSystemSession(s) && !s.archived && ok(s));
  const archived = props.sessions.filter((s) => !isSystemSession(s) && s.archived && ok(s));
  // Routine chats sit in their own section, not in General or a group.
  const routines = live.filter((s) => s.routineId);
  const chats = live.filter((s) => !s.routineId);
  const ungrouped = chats.filter((s) => !s.groupId || !props.groups.some((g) => g.id === s.groupId));
  const [routinesOpen, setRoutinesOpen] = useState(() => {
    try {
      return localStorage.getItem("happy.sidebar.routines") !== "0";
    } catch {
      return true;
    }
  });

  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const start = (e: DragEvent) => e.dataTransfer?.types.includes(DRAG_TYPE) && setDragging(true);
    const end = () => setDragging(false);
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => (window.removeEventListener("dragstart", start), window.removeEventListener("dragend", end), window.removeEventListener("drop", end));
  }, []);

  const gridIds = useGrid();
  const row = (s: SessionState) => (
    <Row
      key={s.id}
      s={s}
      active={s.id === props.selected}
      unread={props.unread.get(s.id)}
      renaming={renaming === s.id}
      // ⌘-click: add to (or take out of) the chat grid instead of opening.
      onClick={(e) =>
        e.metaKey
          ? (grid.toggle(s.id), toast(grid.ids().includes(s.id) ? `added "${s.title}" to the chat grid` : `removed "${s.title}" from the chat grid`))
          : // On the grid, a chat that's in it scrolls to its card instead of leaving.
            props.selected === GRID && grid.ids().includes(s.id)
            ? window.dispatchEvent(new CustomEvent("happy:grid-focus", { detail: s.id }))
            : props.onSelect(s.id)
      }
      inGrid={gridIds.includes(s.id)}
      onRenamed={() => setRenaming(null)}
      onTag={(t) => props.onFilter(props.filter === `tag:${t}` ? "" : `tag:${t}`)}
      onHover={renaming ? () => {} : onHover}
      onContext={async (e) => {
        e.preventDefault();
        onHover(null);
        const { clientX: x, clientY: y } = e;
        const worktrees = s.isManager ? [] : await hub().listWorktrees(s.id).catch(() => []);
        menu.at(x, y, sessionMenuItems({ s, groups: props.groups, allTags: props.allTags, onRename: () => setRenaming(s.id), toast, worktrees }));
      }}
    />
  );

  return (
    <aside className="sidebar" style={{ width: props.width }} onDragStart={() => onHover(null)} onScroll={() => onHover(null)}>
      <div className="filter">
        <img className={`logo logo-btn ${props.selected === STATS ? "on" : ""}`} src="apple-touch-icon.png" alt="Happy" title="Your stats" draggable={false} onClick={() => props.onSelect(STATS)} />
        <span className="filter-box">
        <input
          id="session-filter"
          value={props.filter}
          placeholder="filter   tag: is: eng:"
          onChange={(e) => props.onFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              props.onFilter("");
              (e.target as HTMLInputElement).blur();
            }
          }}
          spellCheck={false}
        />
        {props.filter && (
          <button className="filter-clear" title="Clear filter (Esc)" onClick={() => props.onFilter("")}>
            ×
          </button>
        )}
        </span>
        <button className={`icon-btn ${props.selected === SETTINGS ? "on" : ""}`} title="Settings (⌘,)" onClick={() => props.onSelect(SETTINGS)}>
          <Settings size={15} />
        </button>
      </div>
      <div className="rows">
        {manager && !filtering && show.manager && (
          <ManagerNav s={manager} working={live.filter((x) => x.status === "running").length} active={props.selected === manager.id} onClick={() => props.onSelect(manager.id)} />
        )}
        {!filtering && show.cloud && <CloudRow active={props.selected === CLOUD} onClick={() => props.onSelect(CLOUD)} />}
        {!filtering && show.analytics && <AnalyticsRow active={props.selected === ANALYTICS} onClick={() => props.onSelect(ANALYTICS)} />}
        {!filtering && show.tasks && <TasksRow active={props.selected === TASKS} onClick={() => props.onSelect(TASKS)} />}
        {!filtering && show.email && <EmailRow active={props.selected === EMAIL} onClick={() => props.onSelect(EMAIL)} />}
        {!filtering && show.calendar && <CalendarRow active={props.selected === CALENDAR} onClick={() => props.onSelect(CALENDAR)} />}
        {!filtering && show.terminal && <TerminalNav active={props.selected === TERMINAL} onClick={() => props.onSelect(TERMINAL)} />}
        <div className="chats-h">
          <span>Chats</span>
          <button className="icon-btn" title="New chat (⌘N)" onClick={() => props.onNew()}>
            <Plus size={14} />
          </button>
        </div>
        {/* The ways to see many chats at once sit with the chats. */}
        {!filtering && <NavItem icon={<LayoutList size={14} />} label="Chat wall" right={live.filter((x) => !isSystemSession(x)).length || ""} tone="dim" active={props.selected === CHAT_WALL} onClick={() => props.onSelect(CHAT_WALL)} />}
        {!filtering && <GridNav active={props.selected === GRID} onClick={() => props.onSelect(GRID)} />}
        <Group
          title="General"
          bare={!props.groups.some((g) => chats.some((x) => x.groupId === g.id)) && !routines.length}
          members={ungrouped}
          onDropSession={(id) => hub().moveToGroup(id, null)}
        >
          {ungrouped.map(row)}
          {live.length === 0 && <div className="drop-hint">{filtering ? "no matches" : "no sessions yet"}</div>}
        </Group>

        {props.groups.map((g) => {
          const members = chats.filter((s) => s.groupId === g.id);
          // Empty groups stay out of the way; they show up as drop targets while you drag a chat.
          if (!members.length && (filtering || !dragging)) return null;
          return (
            <Group
              key={g.id}
              title={g.name}
              members={members}
              collapsed={g.collapsed && !filtering}
              onToggle={() => hub().setGroupCollapsed(g.id, !g.collapsed)}
              onDropSession={(id) => hub().moveToGroup(id, g.id)}
              renaming={renamingGroup === g.id}
              onRename={(name) => {
                if (name) void hub().renameGroup(g.id, name);
                setRenamingGroup(null);
              }}
              onContext={(e) =>
                menu.atMouse(e, [
                  { label: "Rename group", onSelect: () => setRenamingGroup(g.id) },
                  { label: "Delete group", danger: true, hint: "keeps sessions", onSelect: () => hub().deleteGroup(g.id) },
                ])
              }
            >
              {members.map(row)}
              {members.length === 0 && <div className="drop-hint">drag sessions here</div>}
            </Group>
          );
        })}

        {addingGroup ? (
          <input
            className="group-new"
            placeholder="group name"
            autoFocus
            onBlur={(e) => {
              if (e.target.value.trim()) void hub().createGroup(e.target.value);
              setAddingGroup(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setAddingGroup(false);
            }}
          />
        ) : (
          !filtering && (
            <button className="new-group" onClick={() => setAddingGroup(true)}>
              + new group
            </button>
          )
        )}

        {routines.length > 0 && (
          <Group
            title="Routines"
            members={routines}
            collapsed={!routinesOpen && !filtering}
            onToggle={() => {
              setRoutinesOpen(!routinesOpen);
              try {
                localStorage.setItem("happy.sidebar.routines", routinesOpen ? "0" : "1");
              } catch {}
            }}
          >
            {routines.map(row)}
          </Group>
        )}

        {archived.length > 0 && (
          <Group title="Archived" members={archived} collapsed={!showArchived && !filtering} onToggle={() => setShowArchived(!showArchived)}>
            {archived.map(row)}
          </Group>
        )}
      </div>
      {hover && props.sessions.find((x) => x.id === hover.id) && (
        <SessionCard
          s={props.sessions.find((x) => x.id === hover.id)!}
          x={hover.x}
          y={hover.y}
          onEnter={() => clearTimeout(hoverTimer.current)}
          onLeave={() => (hoverTimer.current = setTimeout(() => setHover(null), 200))}
        />
      )}
    </aside>
  );
}
