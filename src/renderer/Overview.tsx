import { FileText, FolderOpen, MessageSquare, Wrench } from "lucide-react";
import { runInTerminal, useDeployJobs } from "./TerminalView";
import { Fragment, useEffect, useState } from "react";
import { isDeployed } from "../shared/types";
import type { Routine, ErrorGroup, GitInfo, Overview, OverviewSessionRef, TenantErrors, DeployBoard, DeployComponent } from "../shared/types";
import { hub } from "./App";
import { LineChart, tenantColor } from "./charts";
import { startGcloudLogin } from "./GcloudChip";
import { relTime, num } from "./models";

const ago = (ts: number) => {
  const r = relTime(ts);
  return /^\d+[mhd]$/.test(r) ? `${r} ago` : r === "now" ? "just now" : r;
};

function Ref({ r }: { r?: string }) {
  return r ? <span className="ref">{r}</span> : null;
}

function Chips({ g }: { g?: GitInfo }) {
  if (!g) return null;
  const deployed = g.merged ? (g.deploys ?? []).filter(isDeployed) : [];
  return (
    <span className="ov-chips">
      {g.merged ? <span className="gb merged">merged</span> : g.ahead > 0 ? <span className="gb ahead">↑{num(g.ahead)}</span> : null}
      {g.dirty > 0 && <span className="gb dirty">±{num(g.dirty)}</span>}
      {deployed.map((d) => (
        <span key={d.tenant} className={`dep ${d.full || (d.touched ?? Object.keys(d.parts)).every((c) => d.parts[c]) ? "full" : "part"}`}>
          {d.tenant}
        </span>
      ))}
    </span>
  );
}

/** One bullet: ref · Claude's one-liner (fallback: raw) · chips · links. */
function SessionBullet({ r, onOpen }: { r: OverviewSessionRef; onOpen(id: string): void }) {
  return (
    <li className="ov-li">
      <Ref r={r.ref} />
      <div className="ov-li-body">
        <div className="ov-li-line">
          <span className="ov-li-text">{r.summary ?? r.title}</span>
          <Chips g={r.git} />
          <button className="ov-act" onClick={() => onOpen(r.id)}>
            <MessageSquare size={11} /> open
          </button>
        </div>
        <div className="ov-li-meta">
          <span>{r.title}</span>
          <span>{r.engine}</span>
          {r.branch && <span className="wt">⎇ {r.branch}</span>}
          <span>{ago(r.updatedAt)}</span>
        </div>
      </div>
    </li>
  );
}

/** Hourly error counts per tenant as lines (last 24h). */
function ErrorChart({ tenants }: { tenants: TenantErrors[] }) {
  return (
    <LineChart
      label="Errors per hour by tenant, last 24 hours"
      series={tenants.map((t) => ({ key: t.tenant, label: t.tenant, color: tenantColor(t.tenant), values: t.hourly, total: t.error ? "?" : t.total }))}
    />
  );
}

/** Ask / Fix on a production error: its own session (with a worktree) in the tenant's group, like Cloud items. */
function errorAction(mode: "ask" | "fix", g: ErrorGroup, projects: Record<string, string>, onOpen: (id: string) => void) {
  const tenants = Object.entries(g.byTenant).sort((a, b) => b[1] - a[1]);
  const board = tenants[0]?.[0] ?? "all";
  const where = tenants.map(([t, n]) => `${t}${projects[t] ? ` (GCP project ${projects[t]})` : ""}: ${n}×`).join(", ");
  const facts = `${g.service} logged this ${num(g.total)}× in the last 24h (${where}), last seen ${new Date(g.lastSeen).toLocaleString()}.\n\nSignature: ${g.signature}\n\nSample:\n${g.sample}`;
  const prompt =
    mode === "ask"
      ? `What's causing this production error, and how bad is it?\n\n${facts}`
      : `Investigate and fix this production error.\n\n${facts}\n\nStart by confirming it with read-only gcloud (logs, metrics) and the code. Then propose the fix and implement it on this branch. Don't deploy or change cloud resources without asking me first.`;
  void hub()
    .cloudSpawn({ mode, board, title: `${board}: ${g.summary ?? g.signature}`.slice(0, 80), prompt })
    .then((s) => onOpen(s.id));
}

function ErrorBullet({ g, projects, onOpen }: { g: ErrorGroup; projects: Record<string, string>; onOpen(id: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="ov-li">
      <Ref r={g.ref} />
      <div className="ov-li-body">
        <button className="ov-li-line ov-err-btn" onClick={() => setOpen(!open)}>
          <span className="ov-li-text">{g.summary ?? g.signature}</span>
          <span className="ov-chips">
            {Object.entries(g.byTenant).map(([t, n]) => (
              <span key={t} className="err-chip" style={{ ["--c" as string]: tenantColor(t) }}>
                {t} {n}
              </span>
            ))}
          </span>
        </button>
        <div className="ov-li-meta">
          <span>{g.service}</span>
          <span>{num(g.total)}× · last {ago(g.lastSeen)}</span>
          <button className="link-btn" onClick={() => setOpen(!open)}>
            {open ? "hide log" : "log sample"}
          </button>
          <button className="ov-act" onClick={() => errorAction("ask", g, projects, onOpen)} title="Investigate in its own chat">
            <MessageSquare size={11} />
            ask
          </button>
          <button className="ov-act" onClick={() => errorAction("fix", g, projects, onOpen)} title="Fix in a new chat on its own branch">
            <Wrench size={11} />
            fix
          </button>
        </div>
        {open && <pre className="tool-detail">{g.sample}</pre>}
      </div>
    </li>
  );
}

/** Deploy status: per environment, how far each component is behind main (hover for what's pending). */
function DeployButton({ tenant, commands, components }: { tenant: string; commands: Record<string, string>; components: DeployBoard["components"] }) {
  const [open, setOpen] = useState(false);
  const kinds = [...components.map((c) => c.id), "core", "full"].filter((k) => commands[k]);
  if (!kinds.length) return null;
  const go = (kind: string) => {
    setOpen(false);
    const cmd = commands[kind];
    if (!confirm(`Deploy ${kind} to ${tenant}?\n\nRuns on the Terminal page (an idle shell, or a new one) in your main repo:\n\n${cmd}`)) return;
    // Tracked: an invisible marker after the script reports its exit code back to Happy.
    const id = `d${Date.now().toString(36)}`;
    const wrapped = `${cmd}; printf '\\033]1337;HappyJob=${id};%s\\007' $?`;
    void runInTerminal(wrapped, `deploy ${tenant} ${kind}`).then((termId) => {
      if (!termId) return alert("All 4 terminals are busy. Free one up on the Terminal page, then deploy again.");
      void hub().deployStarted({ id, tenant, kind, command: cmd, termId });
    });
  };
  return (
    <span className="dp-go">
      <button className="link-btn" onClick={() => setOpen(!open)}>
        deploy ▾
      </button>
      {open && (
        <span className="dp-menu" onMouseLeave={() => setOpen(false)}>
          {kinds.map((k) => (
            <button key={k} onClick={() => go(k)} title={commands[k]}>
              {k}
              <small>{k === "core" ? components.map((c) => c.short).join(" + ") : k === "full" ? "everything" : ""}</small>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function DeployStrip({ d }: { d: DeployBoard }) {
  const jobs = useDeployJobs();
  /** Latest tracked deploy covering this tenant's component (full covers all three). */
  const jobFor = (tenant: string, comp: string) =>
    [...jobs].reverse().find((j) => j.tenant === tenant && (j.kind === comp || j.kind === "full" || (j.kind === "core" && comp !== "full")));
  const cell = (c: DeployComponent | undefined, name: string, tenant: string, comp: string) => {
    const j = jobFor(tenant, comp);
    if (j?.status === "running")
      return (
        <td className="dp-cell running" title={`${j.command}\nstarted ${new Date(j.startedAt).toLocaleTimeString()}`} onClick={() => window.dispatchEvent(new CustomEvent("happy:open-terminal"))}>
          <b>deploying…</b>
          <span>{ago(j.startedAt)}</span>
        </td>
      );
    // A finished deploy shows its result until the component falls behind again (failures until retried or dismissed).
    if (j?.status === "failed")
      return (
        <td className="dp-cell far" title={`${j.command}\nexited ${j.exitCode} · click to open the terminal, right-click to dismiss`} onClick={() => window.dispatchEvent(new CustomEvent("happy:open-terminal"))} onContextMenu={(e) => (e.preventDefault(), void hub().deployDismiss(j.id))}>
          <b>✗ failed</b>
          <span>{ago(j.finishedAt ?? j.startedAt)}</span>
        </td>
      );
    if (j?.status === "success" && (!c || !c.behind))
      return (
        <td className="dp-cell ok" title={`${j.command}\nfinished ${new Date(j.finishedAt ?? 0).toLocaleTimeString()}`}>
          <b>✓ deployed</b>
          <span>{ago(j.finishedAt ?? j.startedAt)}</span>
        </td>
      );
    if (!c) return <td className="dp-na">—</td>;
    const tone = !c.behind ? "ok" : c.behind > 20 ? "far" : "behind";
    return (
      <td className={`dp-cell ${tone}`} title={`${name} deployed ${new Date(c.at).toLocaleString()} (${c.sha.slice(0, 7)})${c.pending.length ? `\n\nNot deployed yet:\n${c.pending.join("\n")}${c.behind > c.pending.length ? `\n…and ${c.behind - c.pending.length} more` : ""}` : "\n\nUp to date with main"}`}>
        <b>{c.behind ? `${num(c.behind)} behind` : "✓"}</b>
        <span>{ago(c.at)}</span>
      </td>
    );
  };
  return (
    <section className="card dp">
      <h3>
        Deploys <span className="muted small">vs {d.mainRef}</span>
        {d.unpushed > 0 && <span className="gb ahead">main has {d.unpushed} unpushed</span>}
      </h3>
      <table className="dp-table">
        <thead>
          <tr>
            <th />
            {d.components.map((c) => (
              <th key={c.id}>{c.id}</th>
            ))}
            <th title="Last full deploy (everything) and commits on main since">full</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {d.tenants.map((t) => (
            <tr key={t.tenant}>
              <th>
                <span className="err-chip" style={{ ["--c" as string]: d.colors[t.tenant] ?? tenantColor(t.tenant) }}>
                  {t.tenant}
                </span>
              </th>
              {d.components.map((c) => (
                <Fragment key={c.id}>{cell(t.parts[c.id], c.label, t.tenant, c.id)}</Fragment>
              ))}
              {cell(t.full, "Full deploy (everything)", t.tenant, "full")}
              <td className="dp-act">
                <DeployButton tenant={t.tenant} commands={d.commands[t.tenant] ?? {}} components={d.components} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!!d.mcp?.length && (
        <div className="dp-mcp">
          <span className="muted">packages</span>
          {d.mcp.map((m) => (
            <span key={m.name} className={`dp-mcp-pkg ${m.unpublished ? "behind" : m.unbumped ? "warn" : "ok"}`} title={`${m.dir}: ${m.main} on main · ${m.npm ?? "?"} on npm${m.unbumped ? ` · ${num(m.unbumped)} change${m.unbumped === 1 ? "" : "s"} since the last version bump` : ""}`}>
              <b>{m.name}</b> {m.main}
              {m.unpublished ? <em> · npm {m.npm} → publish</em> : m.unbumped ? <em> · {num(m.unbumped)} unbumped</em> : <em> ✓</em>}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/** The Manager's board (left panel). Refs (A1, D2, M3, E4) are what the chat on the right understands. */
const until = (ts: number) => {
  const m = Math.round((ts - Date.now()) / 60_000);
  return m < 60 ? `in ${Math.max(1, m)}m` : m < 36 * 60 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 1440)}d`;
};

/** Scheduled routines from the Claude and Codex apps (read-only: they run there, not in Happy). */
function Routines() {
  const [rs, setRs] = useState<Routine[] | null>(null);
  useEffect(() => {
    const load = () => void hub().routines().then(setRs).catch(() => setRs([]));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (!rs?.length) return null;
  return (
    <section className="card">
      <h3>
        Routines <span className="ov-count">{rs.filter((r) => r.enabled).length} on</span>
      </h3>
      <ul className="ov-ul">
        {rs.map((r) => (
          <li key={r.id} className={`ov-li rt ${r.enabled ? "" : "off"}`} title={[r.description, r.lastResult && `Last run:\n${r.lastResult}`].filter(Boolean).join("\n\n")}>
            <span className="sc-pill">{r.engine}</span>
            <div className="ov-li-body">
              <div className="ov-li-line">
                <span className="ov-li-text">{r.name}</span>
              </div>
              <div className="ov-li-meta">
                <span>{r.schedule}</span>
                {r.enabled ? r.nextRun && <span>next {until(r.nextRun)}</span> : <span className="rt-paused">paused</span>}
                {r.lastRun && <span>last ran {ago(r.lastRun)}</span>}
                <button className="ov-act" onClick={() => hub().openFile(r.file)}>
                  <FileText size={11} />
                  prompt
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OverviewView({ onOpen }: { onOpen(id: string): void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    hub().overview().then(setO);
    const off = hub().onOverview(setO);
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const refresh = async () => {
    setBusy(true);
    setO(await hub().overview(true));
    setBusy(false);
  };

  if (!o) return <div className="muted pad center mono small">building overview…</div>;
  const errTotal = o.gcp?.tenants.reduce((n, t) => n + t.total, 0) ?? 0;

  return (
    <div className="ov">
      <div className="ov-top">
        <div className="ov-headline">{o.headline ?? "Overview"}</div>
        <div className="ov-bar">
          <span className="muted mono small">
            data {ago(o.generatedAt)}
            {o.annotatedAt ? ` · summaries ${ago(o.annotatedAt)}` : " · writing summaries…"}
          </span>
          <button className="kb" onClick={refresh} disabled={busy}>
            {busy ? "refreshing…" : "refresh"}
          </button>
        </div>
      </div>

      {o.deploys && <DeployStrip d={o.deploys} />}

      {o.active.length > 0 && (
        <section className="card">
          <h3>
            Active now <span className="ov-count">{num(o.active.length)}</span>
          </h3>
          <ul className="ov-ul">
            {o.active.map((r) => (
              <SessionBullet key={r.id} r={r} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h3>
          Needs merging <span className="ov-count">{num(o.unfinished.length)}</span>
        </h3>
        {o.unfinished.length ? (
          <ul className="ov-ul">
            {o.unfinished.map((u) => (
              <li key={u.path} className="ov-li">
                <Ref r={u.ref} />
                <div className="ov-li-body">
                  <div className="ov-li-line">
                    <span className="ov-li-text">{u.summary ?? u.lastSubject ?? u.branch ?? u.title}</span>
                    <span className="ov-chips">
                      {u.ahead > 0 && <span className="gb ahead">↑{num(u.ahead)}</span>}
                      {u.dirty > 0 && <span className="gb dirty">±{num(u.dirty)}</span>}
                    </span>
                  </div>
                  <div className="ov-li-meta">
                    {u.branch && <span className="wt">⎇ {u.branch}</span>}
                    {u.sessionId ? (
                      <button className="ov-act" onClick={() => onOpen(u.sessionId!)}>
                        <MessageSquare size={11} />
                        open session
                      </button>
                    ) : (
                      <span>no session</span>
                    )}
                    <button className="ov-act" onClick={() => hub().revealFile(u.path)}>
                      <FolderOpen size={11} />
                      folder
                    </button>
                    {u.headTime && <span>last commit {ago(u.headTime)}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ov-empty">Nothing waiting to merge.</div>
        )}
      </section>

      <section className="card">
        <h3>
          Done in the last 24h <span className="ov-count">{num(o.recent.length)}</span>
        </h3>
        {o.recent.length ? (
          <ul className="ov-ul">
            {o.recent.map((r) => (
              <SessionBullet key={r.id} r={r} onOpen={onOpen} />
            ))}
          </ul>
        ) : (
          <div className="ov-empty">No session activity.</div>
        )}
        {o.landed.length > 0 && (
          <details className="ov-landed">
            <summary>{num(o.landed.length)} commits landed on main</summary>
            {o.landed.map((c) => (
              <div key={c.sha} className="ov-commit">
                <span className="mono small muted">{c.sha}</span>
                <span className="ov-commit-subj">{c.subject}</span>
                <span className="muted small">{ago(c.time)}</span>
              </div>
            ))}
          </details>
        )}
      </section>

      <Routines />

      <section className="card">
        <h3>
          Production errors, 24h <span className="ov-count">{errTotal}</span>
          {o.gcp && <span className="ov-count"> · checked {ago(o.gcp.generatedAt)}</span>}
        </h3>
        {o.gcp ? (
          <>
            <ErrorChart tenants={o.gcp.tenants} />
            {o.gcp.tenants.filter((t) => t.error).map((t) => (
              <div key={t.tenant} className="ov-empty">
                {t.tenant}: couldn't read logs ({t.error})
                {/auth|login|credential|token|permission/i.test(t.error ?? "") && (
                  <button className="kb" style={{ marginLeft: 8 }} onClick={() => startGcloudLogin("user")}>
                    log in to gcloud
                  </button>
                )}
              </div>
            ))}
            <ul className="ov-ul">
              {o.gcp.groups.slice(0, 10).map((g) => (
                <ErrorBullet key={g.key} g={g} projects={Object.fromEntries(o.gcp!.tenants.map((t) => [t.tenant, t.project]))} onOpen={onOpen} />
              ))}
            </ul>
          </>
        ) : (
          <div className="ov-empty">No cloud environments configured (environments + cloud in .happy/config.json).</div>
        )}
      </section>
    </div>
  );
}
