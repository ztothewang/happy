import { isClosedIssue } from "../../shared/types";
import { num } from "../models";
import { MessageCircle, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Engine, LinearIssue, LinearIssueDetail, LinearIssueInput, LinearMeta, LinearStatus, Overview, SessionState, TaskList, TaskScope, TenantCloud } from "../../shared/types";
import { hub } from "../App";
import { tenantColor } from "../charts";
import { Markdown } from "../Markdown";
import { Connect } from "../TasksView";
import { useToast } from "../toast";
import { Actions, BigTitle, Chips, Empty, Fab, Group, IconBtn, KV, Nav, Pill, Row, Seg, Sheet, ago, cleanErr } from "./ui";

const TChip = ({ t }: { t: string }) => (
  <span className="mx-tchip" style={{ ["--c" as string]: tenantColor(t) }}>
    {t}
  </span>
);
const k = (n?: number) => (n == null ? "–" : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const pct = (n?: number) => (n == null ? "–" : `${Math.round(n * 100)}%`);
const ms = (n?: number) => (n == null ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);

// ── Board ──────────────────────────────────────────────────────
export function MBoard({ onOpenSession, onChat, onCloud }: { onOpenSession(id: string): void; onChat(): void; onCloud(): void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void hub().overview().then(setO);
    return hub().onOverview(setO);
  }, []);
  const errs = o?.gcp?.tenants.reduce((n, t) => n + t.total, 0) ?? 0;
  return (
    <div className="mx-screen">
      <Nav
        right={
          <IconBtn label="Refresh" onClick={async () => (setBusy(true), setO(await hub().overview(true)), setBusy(false))}>
            <RefreshCw size={17} className={busy ? "mx-spin" : ""} />
          </IconBtn>
        }
      />
      <div className="mx-scroll">
        <BigTitle>Board</BigTitle>
        {!o ? (
          <Empty>building the board…</Empty>
        ) : (
          <>
            {o.headline && <div className="mx-headline">{o.headline}</div>}
            <div className="mx-cards">
              <div className="mx-card">
                <div className="mx-card-h">
                  Active <b>{num(o.active.length)}</b>
                </div>
                {o.active.length ? (
                  o.active.map((r) => (
                    <button key={r.id} className="mx-card-line" onClick={() => onOpenSession(r.id)}>
                      <Pill tone={r.status === "running" ? "run" : r.status === "needs_permission" ? "need" : "bad"}>{r.ref}</Pill>
                      <span>{r.summary ?? r.title}</span>
                    </button>
                  ))
                ) : (
                  <div className="mx-muted">Nothing running</div>
                )}
              </div>
              {o.deploys && (
                <div className="mx-card">
                  <div className="mx-card-h">
                    Deploys <b>{o.deploys.tenants.filter((t) => Object.values(t.parts).some((c) => c.behind)).length} behind</b>
                  </div>
                  {o.deploys.tenants.map((t) => (
                    <div key={t.tenant} className="mx-card-line mx-dp">
                      <Pill>{t.tenant}</Pill>
                      {o.deploys!.components.map(({ id, short }) => {
                        const c = t.parts[id];
                        return (
                          <span key={id} className={!c ? "muted" : c.behind ? (c.behind > 20 ? "bad" : "warn") : "ok"}>
                            {short} {!c ? "—" : c.behind || "✓"}
                          </span>
                        );
                      })}
                  {o.deploys?.mcp?.filter((m) => m.unpublished || m.unbumped).map((m) => (
                    <div key={m.name} className="mx-card-line mx-dp">
                      <Pill>pkg</Pill>
                      <span className="warn">{m.name.replace(/^@[^/]+\//, "")} {m.unpublished ? `${m.main} → publish` : `${num(m.unbumped)} unbumped`}</span>
                    </div>
                  ))}
                    </div>
                  ))}
                </div>
              )}
              <div className="mx-card">
                <div className="mx-card-h">
                  Needs merging <b>{num(o.unfinished.length)}</b>
                </div>
                {o.unfinished.slice(0, 6).map((u) => (
                  <button key={u.path} className="mx-card-line" onClick={() => u.sessionId && onOpenSession(u.sessionId)}>
                    <Pill tone="cool">{u.ref}</Pill>
                    <span>{u.summary ?? u.title}</span>
                  </button>
                ))}
                {!o.unfinished.length && <div className="mx-muted">Everything is on main</div>}
              </div>
              <div className="mx-card">
                <div className="mx-card-h">
                  Done · 24h <b>{num(o.recent.length)}</b>
                </div>
                {o.recent.slice(0, 6).map((r) => (
                  <button key={r.id} className="mx-card-line" onClick={() => onOpenSession(r.id)}>
                    <Pill>{r.ref}</Pill>
                    <span>{r.summary ?? r.title}</span>
                  </button>
                ))}
                {!o.recent.length && <div className="mx-muted">Nothing yet today</div>}
              </div>
              {o.gcp && (
                <button className="mx-card" onClick={onCloud}>
                  <div className="mx-card-h">
                    Errors · 24h <b>{errs}</b>
                  </div>
                  <div className="mx-card-line">
                    {o.gcp.tenants.map((t) => (
                      <span key={t.tenant} className="mx-inline">
                        <TChip t={t.tenant} /> {t.error ? "?" : t.total}
                      </span>
                    ))}
                  </div>
                  <div className="mx-link">Open Cloud ›</div>
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <Fab onClick={onChat}>
        <MessageCircle size={18} /> Chat
      </Fab>
    </div>
  );
}

// ── Tasks ──────────────────────────────────────────────────────
const PRIO = ["–", "!!", "▲", "■", "▼"];
const PRIO_LABEL = ["No priority", "Urgent", "High", "Medium", "Low"];
const prioRank = (p: number) => (p === 0 ? 5 : p);

let metaP: Promise<LinearMeta> | null = null;
const linearMeta = () => (metaP ??= hub().linearMeta().catch((e) => ((metaP = null), Promise.reject(e))));

function TaskSheet({ issue, sessions, engine, onClose, onOpenSession }: { issue: LinearIssue; sessions: SessionState[]; engine: Engine; onClose(): void; onOpenSession(id: string): void }) {
  const toast = useToast();
  const [d, setD] = useState<LinearIssueDetail | null>(null);
  const [meta, setMeta] = useState<LinearMeta | null>(null);
  const [eng, setEng] = useState<Engine>(engine);
  const [showDesc, setShowDesc] = useState(false);
  useEffect(() => {
    void hub().taskDetail(issue.id).then(setD).catch(() => {});
    void linearMeta().then(setMeta).catch(() => {});
  }, [issue.id]);
  const team = meta?.teams.find((t) => t.id === d?.teamId) ?? meta?.teams[0];
  const update = async (input: LinearIssueInput, msg: string) => {
    try {
      await hub().linearUpdate(issue.id, input);
      toast(msg);
    } catch (e) {
      toast(cleanErr(e));
    }
  };
  const start = async () => {
    try {
      const s = await hub().startTask(issue.id, eng);
      onClose();
      onOpenSession(s.id);
    } catch (e) {
      toast(cleanErr(e));
    }
  };
  const live = sessions[0];
  return (
    <Sheet onClose={onClose} full>
      <div className="mx-sheet-sub">
        {issue.identifier} · {issue.project ?? "No project"}
      </div>
      <h4 className="mx-sheet-title">{issue.title}</h4>
      <div className="mx-facts selects">
        <label>
          <select defaultValue={d?.stateId ?? ""} key={d?.stateId} onChange={(e) => void update({ stateId: e.target.value }, "Status updated")}>
            {!d?.stateId && <option value="">{issue.status}</option>}
            {team?.states.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className={`p${issue.priority}`}>
          <select defaultValue={issue.priority} onChange={(e) => void update({ priority: Number(e.target.value) }, "Priority updated")}>
            {PRIO_LABEL.map((l, i) => (
              <option key={i} value={i}>
                {PRIO[i]} {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          <select defaultValue={d?.assigneeId ?? ""} key={d?.assigneeId} onChange={(e) => void update({ assigneeId: e.target.value || null }, "Assignee updated")}>
            <option value="">Unassigned</option>
            {team?.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {issue.labels.slice(0, 3).map((l) => (
          <span key={l.name}>{l.name}</span>
        ))}
      </div>
      {live && (
        <button className="mx-btn wide" onClick={() => (onClose(), onOpenSession(live.id))}>
          {live.engine} is on it · open ›
        </button>
      )}
      <Actions
        items={[
          d && { label: showDesc ? "Hide description" : "Description", hint: d.description ? "" : "none", onClick: () => setShowDesc(!showDesc) },
          d && d.comments.length > 0 && { label: `Comments · ${num(d.comments.length)}`, onClick: () => setShowDesc(true) },
          { label: "Open in Linear ↗", onClick: () => window.open(issue.url, "_blank") },
        ]}
      />
      {showDesc && d && (
        <div className="mx-desc">
          {d.description ? <Markdown text={d.description} /> : <div className="mx-muted">No description.</div>}
          {d.comments.map((c, i) => (
            <div key={i} className="mx-comment">
              <b>{c.author}</b> <span className="mx-muted">{ago(c.createdAt)}</span>
              <Markdown text={c.body} />
            </div>
          ))}
        </div>
      )}
      <div className="mx-btnrow sticky">
        <select className="mx-btn" value={eng} onChange={(e) => setEng(e.target.value as Engine)}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="cursor">Cursor</option>
        </select>
        <button className="mx-btn primary grow" onClick={() => void start()}>
          Hand to {eng === "claude" ? "Claude" : eng === "codex" ? "Codex" : "Cursor"}
        </button>
      </div>
    </Sheet>
  );
}

/** One iOS-style picker row: label left, current value right, the native picker (wheel / checklist) on tap. */
function PickRow<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange(v: T): void }) {
  const shown = options.find(([v]) => v === value)?.[1] ?? "—";
  return (
    <label className="mx-pick">
      <span>{label}</span>
      <b>{shown}</b>
      <select value={String(value)} onChange={(e) => onChange(options.find(([v]) => String(v) === e.target.value)![0])}>
        {options.map(([v, l]) => (
          <option key={String(v)} value={String(v)}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** New Linear issue: a plain form (title, details, team, status, priority, assignee, project, labels), or describe it and let Claude fill the form. */
function CreateTaskSheet({ onClose, onCreated }: { onClose(): void; onCreated(): void }) {
  const toast = useToast();
  const [mode, setMode] = useState<"write" | "describe">("write");
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<LinearIssueInput>({ title: "", description: "", priority: 0 });
  const [meta, setMeta] = useState<LinearMeta | null>(null);
  const [busy, setBusy] = useState<"parse" | "create" | null>(null);
  const [filled, setFilled] = useState(false);
  useEffect(
    () =>
      void linearMeta()
        .then((m) => {
          setMeta(m);
          setDraft((d) => ({ ...d, teamId: d.teamId ?? m.teams[0]?.id, assigneeId: d.assigneeId === undefined ? m.viewerId : d.assigneeId }));
        })
        .catch(() => {}),
    [],
  );
  const team = meta?.teams.find((t) => t.id === draft.teamId) ?? meta?.teams[0];
  const set = (patch: Partial<LinearIssueInput>) => setDraft((d) => ({ ...d, ...patch }));
  const parse = async () => {
    setBusy("parse");
    try {
      const d = await hub().linearParse(text);
      setDraft((cur) => ({ ...cur, ...d, teamId: d.teamId ?? cur.teamId }));
      setFilled(true);
      setMode("write");
    } catch (e) {
      toast(cleanErr(e));
    }
    setBusy(null);
  };
  const create = async () => {
    setBusy("create");
    try {
      const r = await hub().linearCreate({ ...draft, title: draft.title?.trim(), teamId: draft.teamId ?? meta?.teams[0]?.id });
      toast(`Created ${r.identifier}`);
      onCreated();
      onClose();
    } catch (e) {
      toast(cleanErr(e));
    }
    setBusy(null);
  };
  const labels = draft.labelIds ?? [];
  return (
    <Sheet onClose={onClose} full>
      <h4 className="mx-sheet-title">New task</h4>
      <Seg
        value={mode}
        onChange={setMode}
        options={[
          ["write", "Write it"],
          ["describe", <><Sparkles size={14} /> Describe to Claude</>],
        ]}
      />
      {mode === "describe" ? (
        <>
          <textarea
            className="mx-input tall"
            autoFocus
            placeholder="Checkout page times out for EU users since Tuesday's deploy. High priority, assign me."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="mx-btnrow">
            <button className="mx-btn primary" disabled={!!busy || !text.trim()} onClick={() => void parse()}>
              {busy === "parse" ? "reading…" : <><Sparkles size={16} /> Fill the form</>}
            </button>
          </div>
        </>
      ) : (
        <>
          {filled && <div className="mx-sheet-sub">Filled in by Claude. Check it, then create.</div>}
          <input className="mx-input" autoFocus={!filled} value={draft.title ?? ""} onChange={(e) => set({ title: e.target.value })} placeholder="Title" enterKeyHint="next" />
          <textarea className="mx-input tall" value={draft.description ?? ""} onChange={(e) => set({ description: e.target.value })} placeholder="Details (optional)" />
          <div className="mx-picks">
            {meta && meta.teams.length > 1 && (
              <PickRow label="Team" value={draft.teamId ?? ""} options={meta.teams.map((t) => [t.id, t.name])} onChange={(v) => set({ teamId: v, stateId: undefined, projectId: null, labelIds: [] })} />
            )}
            <PickRow label="Status" value={draft.stateId ?? ""} options={[["", "Default"], ...(team?.states ?? []).map((st): [string, string] => [st.id, st.name])]} onChange={(v) => set({ stateId: v || undefined })} />
            <PickRow label="Priority" value={draft.priority ?? 0} options={PRIO_LABEL.map((l, i): [number, string] => [i, l])} onChange={(v) => set({ priority: v })} />
            <PickRow
              label="Assignee"
              value={draft.assigneeId ?? ""}
              options={[["", "Unassigned"], ...(team?.members ?? []).map((m): [string, string] => [m.id, m.id === meta?.viewerId ? `${m.name} (me)` : m.name])]}
              onChange={(v) => set({ assigneeId: v || null })}
            />
            <PickRow
              label="Project"
              value={draft.projectId ?? ""}
              options={[["", "None"], ...(meta?.projects ?? []).filter((p) => !team || p.teamIds.includes(team.id)).map((p): [string, string] => [p.id, p.name])]}
              onChange={(v) => set({ projectId: v || null })}
            />
            <label className="mx-pick">
              <span>Labels</span>
              <b>{labels.length ? labels.map((id) => team?.labels.find((l) => l.id === id)?.name).filter(Boolean).join(", ") : "None"}</b>
              <select multiple value={labels} onChange={(e) => set({ labelIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                {team?.labels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mx-btnrow sticky">
            <button className="mx-btn primary" disabled={!!busy || !draft.title?.trim() || !meta} onClick={() => void create()}>
              {busy === "create" ? "creating…" : "Create task"}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

export function MTasks({ sessions, onOpenSession, defaultEngine }: { sessions: Record<string, SessionState>; onOpenSession(id: string): void; defaultEngine: Engine }) {
  const [status, setStatus] = useState<LinearStatus | null>(null);
  const [scope, setScope] = useState<TaskScope>("mine");
  const [sort, setSort] = useState<"priority" | "updated" | "status">("priority");
  const [list, setList] = useState<TaskList | null>(null);
  const [open, setOpen] = useState<LinearIssue | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  useEffect(() => void hub().linearStatus().then(setStatus), []);
  useEffect(() => {
    if (!status?.connected) return;
    setList(null);
    void hub().tasks(scope).then(setList);
    return hub().onTasks((t) => t.scope === scope && setList(t));
  }, [status?.connected, scope]);
  const bySession = useMemo(() => {
    const m = new Map<string, SessionState[]>();
    for (const s of Object.values(sessions)) if (s.linearIssue) m.set(s.linearIssue, [...(m.get(s.linearIssue) ?? []), s]);
    return m;
  }, [sessions]);
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    const xs = (list?.issues ?? []).filter((i) => (showClosed || !isClosedIssue(i)) && (!n || `${i.identifier} ${i.title} ${i.project ?? ""}`.toLowerCase().includes(n)));
    return xs.sort((a, b) =>
      sort === "priority" ? prioRank(a.priority) - prioRank(b.priority) || b.updatedAt - a.updatedAt : sort === "updated" ? b.updatedAt - a.updatedAt : a.status.localeCompare(b.status),
    );
  }, [list, sort, q, showClosed]);
  if (status && !status.connected)
    return (
      <div className="mx-screen">
        <div className="mx-scroll">
          <Connect status={status} onConnected={setStatus} />
        </div>
      </div>
    );
  return (
    <div className="mx-screen">
      <Nav
        right={
          <IconBtn label="New task with Claude" onClick={() => setCreating(true)}>
            <Sparkles size={18} />
          </IconBtn>
        }
      />
      <div className="mx-scroll">
        <BigTitle>Tasks</BigTitle>
        <Seg value={scope} onChange={setScope} options={[["mine", `Mine${list && scope === "mine" ? ` · ${list.issues.filter((i) => !isClosedIssue(i)).length}` : ""}`], ["team", "Everyone"]]} />
        <input className="mx-search" placeholder="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} />
        <Chips value={sort} onChange={setSort} options={[["priority", "Priority"], ["updated", "Recent"], ["status", "Status"]]} />
        <label className="mx-check mx-sub-pad">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> include done, canceled and duplicates (last 30 days)
        </label>
        {!list ? (
          <Empty>loading…</Empty>
        ) : (
          <Group>
            {rows.map((i) => {
              const s = bySession.get(i.identifier)?.[0];
              return (
                <Row
                  key={i.id}
                  wrap
                  lead={<span className={`mx-prio p${i.priority}`}>{PRIO[i.priority]}</span>}
                  title={i.title}
                  sub={`${i.identifier} · ${i.status}${i.labels[0] ? ` · ${i.labels[0].name}` : ""}`}
                  right={s ? <Pill tone={s.status === "running" ? "run" : s.status === "needs_permission" ? "need" : undefined}>{s.engine}</Pill> : null}
                  onClick={() => setOpen(i)}
                />
              );
            })}
            {!rows.length && <Row title="No open tasks" chevron={false} />}
          </Group>
        )}
      </div>
      <Fab round onClick={() => setCreating(true)}>
        <Plus size={26} />
      </Fab>
      {open && <TaskSheet issue={open} sessions={bySession.get(open.identifier) ?? []} engine={defaultEngine} onClose={() => setOpen(null)} onOpenSession={onOpenSession} />}
      {creating && <CreateTaskSheet onClose={() => setCreating(false)} onCreated={() => void hub().tasks(scope, true).then(setList)} />}
    </div>
  );
}

export { KV };
