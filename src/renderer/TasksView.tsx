import { isClosedIssue } from "../shared/types";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Engine, LinearIssue, LinearIssueDetail, LinearIssueInput, LinearMeta, LinearStatus, SessionState, TaskList, TaskScope, TaskSource } from "../shared/types";
import { hub } from "./App";
import { Markdown } from "./Markdown";
import { relTime, num } from "./models";
import { ResizeHandle, usePanelWidth } from "./resize";
import { useSettings } from "./settings";
import { useToast } from "./toast";

const SCOPE_KEY = "happy.tasks.scope";
const SOURCE_LABEL: Record<TaskSource, string> = { linear: "Linear", github: "GitHub" };
/** Where Tasks come from right now (Linear unless switched to GitHub Issues). */
const useSource = (): TaskSource => useSettings()?.taskSource ?? "linear";

/** Linear / GitHub switch. */
function SourceToggle({ source }: { source: TaskSource }) {
  return (
    <div className="tk-seg" role="group" aria-label="Task source">
      {(["linear", "github"] as const).map((x) => (
        <button key={x} className={source === x ? "on" : ""} onClick={() => source !== x && void hub().saveSettings({ taskSource: x })}>
          {SOURCE_LABEL[x]}
        </button>
      ))}
    </div>
  );
}

/** GitHub Issues setup: signs in through the GitHub CLI, so the only thing to pick is the repo. */
function GitHubConnect({ status, onRetry }: { status: LinearStatus; onRetry(): void }) {
  const st = useSettings();
  const [repo, setRepo] = useState(st?.githubRepo || status.repo || "");
  return (
    <div className="tk-connect">
      <h2>Connect GitHub Issues</h2>
      <p className="muted">
        Happy uses your GitHub CLI sign-in, so there's no key to paste. If you haven't yet, run <code>gh auth login</code> in a terminal. Issues come from the repo below
        (blank = your main repo's origin). Statuses and priorities are the repo's <code>status: …</code> and <code>priority: …</code> labels; milestones stand in for projects.
      </p>
      <form
        className="tk-connect-row"
        onSubmit={(e) => {
          e.preventDefault();
          void hub()
            .saveSettings({ githubRepo: repo.trim() })
            .then(onRetry);
        }}
      >
        <input id="github-repo" spellCheck={false} placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <button className="kb" type="submit">
          connect
        </button>
      </form>
      {status.error && <div className="tk-err">{status.error}</div>}
    </div>
  );
}
const STATUS_KEY = "happy.tasks.statuses";

/** Which statuses show: your explicit picks, else open work only (done / canceled / duplicate hidden). */
export function useStatusFilter() {
  const [picks, setPicks] = useState<Record<string, boolean>>(() => load(STATUS_KEY, {} as Record<string, boolean>));
  useEffect(() => save(STATUS_KEY, picks), [picks]);
  const shown = (i: LinearIssue) => picks[i.status] ?? !isClosedIssue(i);
  return { picks, setPicks, shown };
}

function StatusFilter({ issues, picks, setPicks, shown }: { issues: LinearIssue[]; picks: Record<string, boolean>; setPicks(p: Record<string, boolean>): void; shown(i: LinearIssue): boolean }) {
  const [open, setOpen] = useState(false);
  const statuses = [...new Map(issues.map((i) => [i.status, i])).values()]
    .map((i) => ({ name: i.status, color: i.statusColor, closed: isClosedIssue(i), count: issues.filter((x) => x.status === i.status).length, on: shown(i) }))
    .sort((a, b) => Number(a.closed) - Number(b.closed) || b.count - a.count);
  const hiddenN = statuses.filter((x) => !x.on).length;
  return (
    <span className="tk-statuses">
      <button className={`kb ${Object.keys(picks).length ? "on" : ""}`} onClick={() => setOpen(!open)}>
        statuses{hiddenN ? ` · ${statuses.length - hiddenN}/${num(statuses.length)}` : ""} ▾
      </button>
      {open && (
        <span className="tk-st-menu" onMouseLeave={() => setOpen(false)}>
          {statuses.map((x) => (
            <label key={x.name} className={x.closed ? "closed" : ""}>
              <input type="checkbox" checked={x.on} onChange={(e) => setPicks({ ...picks, [x.name]: e.target.checked })} />
              <i style={{ background: x.color }} />
              <span>{x.name}</span>
              <small>{num(x.count)}</small>
            </label>
          ))}
          <span className="tk-st-foot">
            <span className="muted small">closed = last 30 days</span>
            <button className="link-btn" onClick={() => setPicks({})}>
              reset
            </button>
          </span>
        </span>
      )}
    </span>
  );
}
const SORT_KEY = "happy.tasks.sort";
const ENGINE_KEY = "happy.tasks.engine";

type SortKey = "priority" | "id" | "title" | "status" | "project" | "updated" | "created";
type Sort = { key: SortKey; dir: 1 | -1 };

const STATUS_ORDER: Record<string, number> = { started: 0, unstarted: 1, triage: 2, backlog: 3 };
/** Urgent first, "no priority" last. */
const prioRank = (p: number) => (p === 0 ? 5 : p);
const PRIO_ICON = ["—", "!!", "▮▮▮", "▮▮▯", "▮▯▯"];
const STATUS_WORD: Record<string, string> = { running: "working", needs_permission: "needs you", error: "failed", idle: "idle" };

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

function compare(a: LinearIssue, b: LinearIssue, key: SortKey): number {
  switch (key) {
    case "priority":
      return prioRank(a.priority) - prioRank(b.priority) || (STATUS_ORDER[a.statusType] ?? 9) - (STATUS_ORDER[b.statusType] ?? 9) || b.updatedAt - a.updatedAt;
    case "id":
      return a.identifier.localeCompare(b.identifier, undefined, { numeric: true });
    case "title":
      return a.title.localeCompare(b.title);
    case "status":
      return (STATUS_ORDER[a.statusType] ?? 9) - (STATUS_ORDER[b.statusType] ?? 9) || a.status.localeCompare(b.status);
    case "project":
      return (a.project ?? "~").localeCompare(b.project ?? "~");
    case "updated":
      return b.updatedAt - a.updatedAt;
    case "created":
      return b.createdAt - a.createdAt;
  }
}

export function Connect({ status, onConnected }: { status: LinearStatus | null; onConnected(s: LinearStatus): void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>(status?.error);
  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      onConnected(await hub().linearSetKey(key));
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
    setBusy(false);
  };
  return (
    <div className="tk-connect">
      <h2>Connect Linear</h2>
      <p className="muted">
        Happy reads and edits your Linear issues with a personal API key. Create one in Linear under Settings → Security &amp; access → Personal API keys
        (with read and write access), then paste it here. It's encrypted with your macOS keychain and only sent to api.linear.app.
      </p>
      <a className="cl-ext" href="https://linear.app/settings/account/security" target="_blank" rel="noreferrer">
        open Linear API key settings ↗
      </a>
      <form
        className="tk-connect-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) void submit();
        }}
      >
        <input id="linear-key" type="password" autoComplete="off" spellCheck={false} placeholder="lin_api_…" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="kb" type="submit" disabled={busy || !key.trim()}>
          {busy ? "checking…" : "connect"}
        </button>
      </form>
      {err && <div className="tk-err">{err}</div>}
    </div>
  );
}

const PRIORITIES = [
  { v: 0, label: "No priority" },
  { v: 1, label: "Urgent" },
  { v: 2, label: "High" },
  { v: 3, label: "Medium" },
  { v: 4, label: "Low" },
];
const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

let metaCache: { source: TaskSource; p: Promise<LinearMeta> } | null = null;
/** Teams/projects/labels for the form (Linear, or the GitHub repo); `error` explains a failed load instead of spinning forever. */
function useLinearMeta(): { meta: LinearMeta | null; error?: string; retry(): void } {
  const source = useSource();
  const [meta, setMeta] = useState<LinearMeta | null>(null);
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  useEffect(() => {
    setError(undefined);
    if (metaCache?.source !== source) metaCache = { source, p: hub().linearMeta() };
    metaCache.p.then(setMeta).catch((e) => {
      metaCache = null;
      setError(cleanErr(e));
    });
  }, [n, source]);
  return { meta, error, retry: () => setN((x) => x + 1) };
}

interface Form {
  teamId: string;
  title: string;
  description: string;
  stateId: string;
  priority: number;
  assigneeId: string;
  projectId: string;
  labelIds: string[];
}
const formFrom = (x: LinearIssueInput | LinearIssueDetail, fallbackTeam: string): Form => ({
  teamId: ("teamId" in x && x.teamId) || fallbackTeam,
  title: "title" in x ? (x.title ?? "") : "",
  description: x.description ?? "",
  stateId: ("stateId" in x && x.stateId) || "",
  priority: "priority" in x ? (x.priority ?? 0) : 0,
  assigneeId: ("assigneeId" in x && x.assigneeId) || "",
  projectId: ("projectId" in x && x.projectId) || "",
  labelIds: x.labelIds ?? [],
});

/** Title / status / priority / assignee / project / labels / description — shared by edit and create. */
function IssueFields({ f, set, meta, preview }: { f: Form; set(p: Partial<Form>): void; meta: LinearMeta; preview: boolean }) {
  const team = meta.teams.find((t) => t.id === f.teamId) ?? meta.teams[0];
  const project = useSource() === "github" ? "Milestone" : "Project";
  return (
    <div className="tk-form">
      <input id="issue-title" className="tk-f-title" placeholder="Issue title" value={f.title} onChange={(e) => set({ title: e.target.value })} />
      <div className="tk-f-grid">
        {meta.teams.length > 1 && (
          <label>
            <span>Team</span>
            <select value={f.teamId} onChange={(e) => set({ teamId: e.target.value, stateId: "", labelIds: [], assigneeId: "" })}>
              {meta.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>Status</span>
          <select value={f.stateId} onChange={(e) => set({ stateId: e.target.value })}>
            {!f.stateId && <option value="">default</option>}
            {team?.states.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Priority</span>
          <select value={f.priority} onChange={(e) => set({ priority: Number(e.target.value) })}>
            {PRIORITIES.map((p) => (
              <option key={p.v} value={p.v}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Assignee</span>
          <select value={f.assigneeId} onChange={(e) => set({ assigneeId: e.target.value })}>
            <option value="">Unassigned</option>
            {team?.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === meta.viewerId ? `${m.name} (me)` : m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{project}</span>
          <select value={f.projectId} onChange={(e) => set({ projectId: e.target.value })}>
            <option value="">No {project.toLowerCase()}</option>
            {meta.projects
              .filter((p) => !team || p.teamIds.includes(team.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {!!team?.labels.length && (
        <div className="tk-f-labels">
          {team.labels.map((l) => {
            const on = f.labelIds.includes(l.id);
            return (
              <button key={l.id} type="button" className={`tk-label tk-label-btn ${on ? "on" : ""}`} style={{ ["--c" as string]: l.color }} onClick={() => set({ labelIds: on ? f.labelIds.filter((x) => x !== l.id) : [...f.labelIds, l.id] })}>
                {l.name}
              </button>
            );
          })}
        </div>
      )}
      {preview ? (
        f.description.trim() ? <Markdown text={f.description} className="tk-desc" /> : <div className="muted small">No description.</div>
      ) : (
        <textarea id="issue-desc" className="tk-f-desc" placeholder="Description (markdown)" value={f.description} onChange={(e) => set({ description: e.target.value })} rows={10} />
      )}
    </div>
  );
}

function diff(f: Form, base: Form): LinearIssueInput {
  const out: LinearIssueInput = {};
  if (f.title !== base.title) out.title = f.title;
  if (f.description !== base.description) out.description = f.description;
  if (f.stateId !== base.stateId && f.stateId) out.stateId = f.stateId;
  if (f.priority !== base.priority) out.priority = f.priority;
  if (f.assigneeId !== base.assigneeId) out.assigneeId = f.assigneeId || null;
  if (f.projectId !== base.projectId) out.projectId = f.projectId || null;
  if (f.labelIds.join() !== base.labelIds.join()) out.labelIds = f.labelIds;
  if (f.teamId !== base.teamId) out.teamId = f.teamId;
  return out;
}

function IssuePanel({ issue, sessions, engine, onEngine, onStart, onOpen, onClose, width, onOpenParent }: {
  issue: LinearIssue;
  /** Open the parent issue in the panel (when it's in the list). */
  onOpenParent?(): void;
  sessions: SessionState[];
  engine: Engine;
  onEngine(e: Engine): void;
  onStart(): void;
  onOpen(id: string): void;
  onClose(): void;
  width: number;
}) {
  const source = useSource();
  const toast = useToast();
  const { meta, error: metaErr, retry } = useLinearMeta();
  const [d, setD] = useState<LinearIssueDetail | null>(null);
  const [base, setBase] = useState<Form | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setD(null);
    setF(null);
    setEditingDesc(false);
    hub()
      .taskDetail(issue.id)
      .then((x) => {
        setD(x);
        const form = formFrom({ ...x, title: issue.title, priority: issue.priority } as never, x.teamId ?? "");
        setBase(form);
        setF(form);
      })
      .catch((e) => setErr(cleanErr(e)));
  }, [issue.id]);
  const changes = f && base ? diff(f, base) : {};
  const dirty = Object.keys(changes).length > 0;
  const [saved, setSaved] = useState(false);
  // Edits save themselves: pickers right away, typed text (title, description) once you pause.
  const save = async (snapshot: Form, patch: typeof changes) => {
    setBusy(true);
    try {
      await hub().linearUpdate(issue.id, patch);
      setBase(snapshot);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      toast(`Couldn't save ${issue.identifier}: ${cleanErr(e)}`);
    }
    setBusy(false);
  };
  // Closing the panel mid-typing still saves what you wrote.
  const pending = useRef<{ f: Form | null; changes: typeof changes }>({ f: null, changes: {} });
  pending.current = { f, changes };
  useEffect(
    () => () => {
      const p = pending.current;
      if (p.f && Object.keys(p.changes).length) void hub().linearUpdate(issue.id, p.changes).catch(() => {});
    },
    [issue.id],
  );
  useEffect(() => {
    if (!dirty || !f || busy) return;
    const typed = "title" in changes || "description" in changes;
    const t = setTimeout(() => void save(f, changes), typed ? 900 : 0);
    return () => clearTimeout(t);
  }, [JSON.stringify(changes), busy]);
  return (
    <aside className="tk-side" style={{ width }}>
      <div className="tk-side-h">
        <span className="mono muted">{issue.identifier}</span>
        {issue.parent && (
          <span className="tk-parent-of" title={issue.parentTitle}>
            sub-issue of{" "}
            {onOpenParent ? (
              <button className="link-btn mono" onClick={onOpenParent}>
                {issue.parent}
              </button>
            ) : (
              <span className="mono">{issue.parent}</span>
            )}
            {issue.parentTitle && <span className="tk-parent-title"> {issue.parentTitle}</span>}
          </span>
        )}
        <a className="cl-ext" href={issue.url} target="_blank" rel="noreferrer">
          open in {SOURCE_LABEL[source]} ↗
        </a>
        <button className="icon-btn" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="tk-side-body">
        <div className="tk-start">
          <div className="tk-seg" role="group" aria-label="Agent">
            {(["claude", "codex", "cursor"] as Engine[]).map((e) => (
              <button key={e} className={engine === e ? "on" : ""} onClick={() => onEngine(e)}>
                {e}
              </button>
            ))}
          </div>
          <button className="tk-go" onClick={onStart}>
            hand to {engine} →
          </button>
        </div>
        {sessions.length > 0 && (
          <div className="tk-sessions">
            {sessions.map((s) => (
              <button key={s.id} className="tk-sess" onClick={() => onOpen(s.id)}>
                <span className={`st ${s.status}`}>{s.preparing ? "setting up" : STATUS_WORD[s.status] ?? s.status}</span>
                <span>{s.engine}</span>
                <span className="muted">{relTime(s.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}
        {err || metaErr ? (
          <div className="tk-err">
            {err ?? `Couldn't load ${SOURCE_LABEL[source]} fields: ${metaErr}`}{" "}
            {metaErr && (
              <button className="link-btn" onClick={retry}>
                retry
              </button>
            )}
          </div>
        ) : !f || !meta || !d ? (
          <div className="muted mono small">loading…</div>
        ) : (
          <>
            <IssueFields f={f} set={(p) => setF({ ...f, ...p })} meta={meta} preview={!editingDesc} />
            {!editingDesc && (
              <button className="link-btn tk-edit-desc" onClick={() => setEditingDesc(true)}>
                edit description
              </button>
            )}
            {d.children.length > 0 && (
              <div className="tk-sub">
                <h4>Sub-issues</h4>
                {d.children.map((c) => (
                  <div key={c.identifier} className={c.done ? "tk-done" : ""}>
                    <span className="mono">{c.identifier}</span> {c.title} <span className="muted">· {c.status}</span>
                  </div>
                ))}
              </div>
            )}
            {d.attachments.length > 0 && (
              <div className="tk-sub">
                <h4>Attachments</h4>
                {d.attachments.map((a) => (
                  <div key={a.url}>
                    <a className="cl-ext" href={a.url} target="_blank" rel="noreferrer">
                      {a.title} ↗
                    </a>
                  </div>
                ))}
              </div>
            )}
            <Comments issueId={issue.id} comments={d.comments} onChanged={() => void hub().taskDetail(issue.id).then(setD)} />
          </>
        )}
      </div>
      {(busy || dirty || saved) && (
        <div className="tk-side-foot tk-autosave">
          <span className="muted small">{busy ? "saving…" : dirty ? "editing…" : "saved ✓"}</span>
        </div>
      )}
    </aside>
  );
}

function CreatePanel({ initial, width, onClose, onCreated }: { initial?: LinearIssueInput; width: number; onClose(): void; onCreated(identifier: string): void }) {
  const source = useSource();
  const toast = useToast();
  const { meta, error: metaErr, retry } = useLinearMeta();
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (!meta) return;
    const team = meta.teams[0]?.id ?? "";
    setF(formFrom(initial ?? { assigneeId: meta.viewerId }, team));
  }, [meta, initial]);
  const create = async () => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await hub().linearCreate({
        teamId: f.teamId,
        title: f.title,
        description: f.description || undefined,
        stateId: f.stateId || undefined,
        priority: f.priority,
        assigneeId: f.assigneeId || undefined,
        projectId: f.projectId || undefined,
        labelIds: f.labelIds.length ? f.labelIds : undefined,
      });
      toast(`Created ${r.identifier}`);
      onCreated(r.identifier);
    } catch (e) {
      toast(`Couldn't create: ${cleanErr(e)}`);
    }
    setBusy(false);
  };
  return (
    <aside className="tk-side" style={{ width }}>
      <div className="tk-side-h">
        <b>New issue</b>
        <button className="link-btn" onClick={() => setPreview(!preview)}>
          {preview ? "edit" : "preview"}
        </button>
        <button className="icon-btn" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="tk-side-body">
        {metaErr ? (
          <div className="tk-err">
            Couldn't load {SOURCE_LABEL[source]} fields: {metaErr}{" "}
            <button className="link-btn" onClick={retry}>
              retry
            </button>
          </div>
        ) : !f || !meta ? (
          <div className="muted mono small">loading…</div>
        ) : (
          <IssueFields f={f} set={(p) => setF({ ...f, ...p })} meta={meta} preview={preview} />
        )}
      </div>
      <div className="tk-side-foot">
        <button className="link-btn" onClick={onClose}>
          cancel
        </button>
        <button className="tk-go" disabled={busy || !f?.title.trim()} onClick={() => void create()}>
          {busy ? "creating…" : "create issue"}
        </button>
      </div>
    </aside>
  );
}

/** Tasks: open Linear or GitHub issues, sortable, expandable, one click to hand one to an agent. */
export function TasksView({ sessions, onOpen }: { sessions: Record<string, SessionState>; onOpen(id: string): void }) {
  const toast = useToast();
  const source = useSource();
  const [checks, setChecks] = useState(0);
  const [status, setStatus] = useState<LinearStatus | null>(null);
  const [scope, setScope] = useState<TaskScope>(() => load(SCOPE_KEY, "mine"));
  const { picks, setPicks, shown } = useStatusFilter();
  const [sort, setSort] = useState<Sort>(() => load(SORT_KEY, { key: "priority", dir: 1 }));
  const st = useSettings();
  const [picked, setEngine] = useState<Engine | null>(() => load<Engine | null>(ENGINE_KEY, null));
  const engine: Engine = picked ?? st?.defaultEngine ?? "claude";
  const [list, setList] = useState<TaskList | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ initial?: LinearIssueInput } | null>(null);
  const [ask, setAsk] = useState("");
  const [parsing, setParsing] = useState(false);
  const [sideWidth, setSideWidth] = usePanelWidth("tasks-side", 480);
  const [q, setQ] = useState("");

  useEffect(() => {
    setStatus(null);
    setOpen(null);
    void hub().linearStatus().then(setStatus);
  }, [source, checks]);
  useEffect(() => save(SCOPE_KEY, scope), [scope]);
  useEffect(() => save(SORT_KEY, sort), [sort]);
  useEffect(() => {
    if (picked) save(ENGINE_KEY, picked);
  }, [picked]);
  useEffect(() => {
    if (!status?.connected) return;
    setList(null);
    void hub().tasks(scope).then(setList);
    return hub().onTasks((t) => t.scope === scope && setList(t));
  }, [status, scope]);

  const bySession = useMemo(() => {
    const m = new Map<string, SessionState[]>();
    for (const s of Object.values(sessions)) if (s.linearIssue) m.set(s.linearIssue, [...(m.get(s.linearIssue) ?? []), s]);
    for (const v of m.values()) v.sort((a, b) => b.updatedAt - a.updatedAt);
    return m;
  }, [sessions]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const xs = (list?.issues ?? []).filter(
      (i) => shown(i) && (!needle || `${i.identifier} ${i.title} ${i.project ?? ""} ${i.labels.map((l) => l.name).join(" ")} ${i.assignee ?? ""}`.toLowerCase().includes(needle)),
    );
    return xs.sort((a, b) => compare(a, b, sort.key) * sort.dir);
  }, [list, sort, q, picks]);

  if (!status) return <div className="muted pad center mono small">checking {SOURCE_LABEL[source]}…</div>;
  if (!status.connected)
    return (
      <div className="tk">
        <div className="tk-bar">
          <SourceToggle source={source} />
        </div>
        {source === "github" ? <GitHubConnect status={status} onRetry={() => setChecks((n) => n + 1)} /> : <Connect status={status} onConnected={setStatus} />}
      </div>
    );

  const head = (key: SortKey, label: string, cls = "") => (
    <th className={`tk-th ${cls} ${sort.key === key ? "on" : ""}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}>
      {label}
      {sort.key === key ? (sort.dir === 1 ? " ↓" : " ↑") : ""}
    </th>
  );
  const start = async (issue: LinearIssue) => {
    try {
      const s = await hub().startTask(issue.id, engine);
      toast(`${issue.identifier} handed to ${engine}`);
      onOpen(s.id);
    } catch (e) {
      toast(`Couldn't start: ${String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
    }
  };
  const urgent = rows.filter((i) => i.priority === 1 || i.priority === 2).length;
  const fromText = async () => {
    if (!ask.trim()) return;
    setParsing(true);
    try {
      const initial = await hub().linearParse(ask);
      setOpen(null);
      setCreating({ initial });
      setAsk("");
    } catch (e) {
      toast(`Claude couldn't read that: ${String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
    }
    setParsing(false);
  };
  const openIssue = list?.issues.find((i) => i.id === open);

  return (
    <div className="tk">
      <div className="tk-bar">
        <SourceToggle source={source} />
        <div className="tk-seg" role="group" aria-label="Whose issues">
          <button className={scope === "mine" ? "on" : ""} onClick={() => setScope("mine")}>
            mine
          </button>
          <button className={scope === "team" ? "on" : ""} onClick={() => setScope("team")}>
            everyone
          </button>
        </div>
        <StatusFilter issues={list?.issues ?? []} picks={picks} setPicks={setPicks} shown={shown} />
        <input id="task-filter" className="tk-filter" placeholder="filter" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        <form
          className="cal-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void fromText();
          }}
        >
          <input id="issue-ask" placeholder="describe a ticket… Claude fills it in" value={ask} onChange={(e) => setAsk(e.target.value)} spellCheck={false} />
          <button className="kb" type="submit" disabled={parsing || !ask.trim()}>
            {parsing ? "reading…" : "create with Claude"}
          </button>
        </form>
        <button className="tk-go" onClick={() => (setOpen(null), setCreating({}))}>
          new
        </button>
        <span className="muted mono small bar-meta">
          {list ? `${num(rows.length)} open · ${urgent} urgent/high` : ""}
          {list?.error ? ` · ${list.error}` : ""}
        </span>
        <span className="tk-bar-right">
          <span className="muted mono small bar-meta bar-opt">
            {status.name}
            {status.repo ? ` · ${status.repo}` : ""} · {list?.fetchedAt ? `updated ${relTime(list.fetchedAt)}` : "loading…"}
          </span>
          <button
            className="kb"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setList(await hub().tasks(scope, true));
              setBusy(false);
            }}
          >
            {busy ? "refreshing…" : "refresh"}
          </button>
        </span>
      </div>
      <div className="tk-split">
      <div className="tk-scroll">
        {!list ? (
          <div className="muted pad center mono small">loading issues…</div>
        ) : !rows.length ? (
          <div className="muted pad center mono small">{q ? "no matches" : "No open issues. Nice."}</div>
        ) : (
          <table className="tk-tbl">
            <thead>
              <tr>
                {head("priority", "pri", "tk-pri")}
                {head("id", "id")}
                {head("title", "title", "tk-title-h")}
                {head("status", "status")}
                {head("project", "project")}
                {scope === "team" && <th>assignee</th>}
                {head("updated", "updated")}
                <th>agent</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const linked = bySession.get(i.identifier) ?? [];
                const live = linked[0];
                const isOpen = open === i.id;
                return (
                  <Fragment key={i.id}>
                    <tr className={`tk-row ${isOpen ? "open" : ""}`} onClick={() => (setCreating(null), setOpen(isOpen ? null : i.id))}>
                      <td className={`tk-pri p${i.priority}`} title={i.priorityLabel}>
                        {PRIO_ICON[i.priority] ?? "—"}
                      </td>
                      <td className="mono muted">{i.identifier}</td>
                      <td className="tk-title">
                        {i.parent && (
                          <span className="tk-parent" title={`Sub-issue of ${i.parent}${i.parentTitle ? ` · ${i.parentTitle}` : ""}`}>
                            ↳ {i.parent}
                          </span>
                        )}
                        <span className="tk-title-text">{i.title}</span>
                        {i.labels.slice(0, 3).map((l) => (
                          <span key={l.name} className="tk-label" style={{ ["--c" as string]: l.color ?? "var(--dim)" }}>
                            {l.name}
                          </span>
                        ))}
                      </td>
                      <td>
                        <span className="tk-status">
                          <i style={{ background: i.statusColor ?? "var(--dim2)" }} />
                          {i.status}
                        </span>
                      </td>
                      <td className="muted">{i.project ?? "–"}</td>
                      {scope === "team" && <td className="muted">{i.assignee ?? "–"}</td>}
                      <td className="muted mono">{relTime(i.updatedAt)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {live ? (
                          <button className="tk-agent" onClick={() => onOpen(live.id)} title="Open the agent's session">
                            <span className={`st ${live.status}`}>{live.preparing ? "setting up" : STATUS_WORD[live.status] ?? live.status}</span> {live.engine}
                          </button>
                        ) : (
                          <button className="tk-hand" onClick={() => void start(i)} title={`Hand to ${engine}`}>
                            hand to {engine}
                          </button>
                        )}
                      </td>
                    </tr>

                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {(openIssue || creating) && <ResizeHandle width={sideWidth} onWidth={setSideWidth} side="right" min={340} max={1000} reset={480} />}
      {creating ? (
        <CreatePanel
          initial={creating.initial}
          width={sideWidth}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null);
            void hub().tasks(scope, true).then(setList);
          }}
        />
      ) : (
        openIssue && (
          <IssuePanel
            key={openIssue.id}
            issue={openIssue}
            sessions={bySession.get(openIssue.identifier) ?? []}
            engine={engine}
            onEngine={setEngine}
            onStart={() => void start(openIssue)}
            onOpen={onOpen}
            onClose={() => setOpen(null)}
            onOpenParent={(() => {
              const p = openIssue.parentId && list?.issues.find((x) => x.id === openIssue.parentId);
              return p ? () => setOpen(p.id) : undefined;
            })()}
            width={sideWidth}
          />
        )
      )}
      </div>
    </div>
  );
}

/** A ticket's comments: read them, add one (⌘↵ posts), edit or delete your own. */
function Comments({ issueId, comments, onChanged }: { issueId: string; comments: LinearIssueDetail["comments"]; onChanged(): void }) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const run = async (f: () => Promise<void>, done?: () => void) => {
    setBusy(true);
    try {
      await f();
      done?.();
      onChanged();
    } catch (e) {
      toast(cleanErr(e));
    }
    setBusy(false);
  };
  const post = () => draft.trim() && void run(() => hub().linearAddComment(issueId, draft.trim()), () => setDraft(""));
  return (
    <div className="tk-sub tk-comments">
      <h4>Comments{comments.length ? ` · ${num(comments.length)}` : ""}</h4>
      {comments.map((c) => (
        <div key={c.id} className="tk-comment">
          <div className="muted small tk-c-h">
            <span>
              <b>{c.author}</b> · {relTime(c.createdAt)}
              {c.edited ? " · edited" : ""}
            </span>
            {c.mine && editing?.id !== c.id && (
              <span className="tk-c-acts">
                <button className="link-btn" onClick={() => setEditing({ id: c.id, body: c.body })}>
                  edit
                </button>
                {confirmDel === c.id ? (
                  <button className="link-btn danger" disabled={busy} onClick={() => void run(() => hub().linearDeleteComment(c.id), () => setConfirmDel(null))}>
                    delete for good?
                  </button>
                ) : (
                  <button className="link-btn" onClick={() => setConfirmDel(c.id)} onBlur={() => setTimeout(() => setConfirmDel((x) => (x === c.id ? null : x)), 200)}>
                    delete
                  </button>
                )}
              </span>
            )}
          </div>
          {editing?.id === c.id ? (
            <div className="tk-c-edit">
              <textarea
                id={`tk-c-edit-${c.id}`}
                value={editing.body}
                autoFocus
                rows={Math.min(12, Math.max(3, editing.body.split("\n").length + 1))}
                onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.metaKey) (e.preventDefault(), void run(() => hub().linearEditComment(c.id, editing.body.trim()), () => setEditing(null)));
                  if (e.key === "Escape") setEditing(null);
                }}
              />
              <div className="tk-c-row">
                <button className="tk-go" disabled={busy || !editing.body.trim()} onClick={() => void run(() => hub().linearEditComment(c.id, editing.body.trim()), () => setEditing(null))}>
                  save
                </button>
                <button className="link-btn" onClick={() => setEditing(null)}>
                  cancel
                </button>
              </div>
            </div>
          ) : (
            <Markdown text={c.body} />
          )}
        </div>
      ))}
      <div className="tk-c-new">
        <textarea
          id={`tk-c-new-${issueId}`}
          placeholder="Add a comment (markdown) · ⌘↵ to post"
          value={draft}
          rows={draft.split("\n").length > 2 ? 5 : 2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && e.metaKey && (e.preventDefault(), post())}
        />
        {draft.trim() && (
          <div className="tk-c-row">
            <button className="tk-go" disabled={busy} onClick={post}>
              {busy ? "posting…" : "comment"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
