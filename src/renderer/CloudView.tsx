import { useEffect, useRef, useState } from "react";
import { num } from "./models";
import type { CloudIssue, CloudSnapshot, SessionState, SlowQuery, TenantCloud } from "../shared/types";
import { hub } from "./App";
import { LineChart, Spark, tenantColor } from "./charts";
import { startGcloudLogin } from "./GcloudChip";
import { ResizeHandle, usePanelWidth } from "./resize";
import { SessionView } from "./SessionView";
import { fixPrompt } from "./mobile/MCloud";

const TAB_KEY = "happy.cloud.tab";
const CHAT_KEY = "happy.cloud.chat";

const k = (n?: number) => (n == null ? "–" : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const pct = (n?: number) => (n == null ? "–" : `${Math.round(n * 100)}%`);
const ms = (n?: number) => (n == null ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
const secs = (n: number) => (n >= 3600 ? `${(n / 3600).toFixed(1)}h` : n >= 60 ? `${Math.round(n / 60)}m` : n >= 10 ? `${Math.round(n)}s` : `${n.toFixed(1)}s`);
const ago = (ts?: number) => {
  if (!ts) return "never";
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const sumBy = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const addSeries = (rows: number[][]) => rows.reduce((acc, r) => acc.map((v, i) => v + (r[i] ?? 0)), new Array(24).fill(0) as number[]);
const reqHourly = (t: TenantCloud) => addSeries(t.services.map((s) => s.hourly));
const errHourly = (t: TenantCloud) => addSeries(t.services.map((s) => s.hourly5xx));
const AREA: Record<CloudIssue["area"], string> = { service: "cloud run", job: "job", cron: "cron", queue: "queue", sql: "database", auth: "firebase", logs: "logs", fetch: "fetch" };

const open = (url?: string) => url && window.open(url, "_blank");
const Ext = ({ href, children = "console ↗" }: { href?: string; children?: React.ReactNode }) =>
  href ? (
    <a className="cl-ext" href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
      {children}
    </a>
  ) : null;

function TenantChip({ t }: { t: string }) {
  return (
    <span className="cl-tchip" style={{ ["--c" as string]: tenantColor(t) }}>
      {t}
    </span>
  );
}

type IssueAct = (mode: "ask" | "fix", i: CloudIssue) => void;

function IssueRow({ i, onAsk }: { i: CloudIssue; onAsk: IssueAct }) {
  return (
    <div className="cl-issue">
      <span className={`cl-sev ${i.severity}`} />
      <span className="cl-ref">{i.ref}</span>
      <TenantChip t={i.tenant} />
      <div className="cl-issue-main">
        <div className="cl-issue-hd">
          <span className="cl-area">{AREA[i.area]}</span>
          <span className="cl-issue-txt">{i.text}</span>
        </div>
        {!!i.facts?.length && (
          <div className="cl-facts">
            {i.facts.map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
        )}
        {i.detail && (
          <div className="cl-detail" title={i.detail}>
            {i.detail}
          </div>
        )}
      </div>
      <div className="cl-issue-right">
        {i.series && <Spark values={i.series} width={110} height={22} />}
        <span className="cl-issue-acts">
          <Ext href={i.link} />
          <button className="link-btn" onClick={() => onAsk("ask", i)} title="Investigate in its own chat">
            ask
          </button>
          {i.area !== "fetch" && (
            <button className="link-btn" onClick={() => onAsk("fix", i)} title="Fix in a new chat on its own branch">
              fix
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function Issues({ issues, title, onAsk }: { issues: CloudIssue[]; title: string; onAsk: IssueAct }) {
  return (
    <div className="card">
      <h3>
        {title}
        <span className="ov-count">{num(issues.length)}</span>
      </h3>
      {issues.length ? issues.map((i, n) => <IssueRow key={`${i.ref}-${n}`} i={i} onAsk={onAsk} />) : <div className="cl-clear">✓ nothing needs attention</div>}
    </div>
  );
}

function TenantCard({ t, onOpen }: { t: TenantCloud; onOpen(): void }) {
  const req = sumBy(t.services, (s) => s.requests);
  const e5 = sumBy(t.services, (s) => s.err5xx);
  // The main service: one named "backend", else the busiest.
  const be = t.services.find((s) => s.name === "backend") ?? [...t.services].sort((x, y) => (y.requests ?? 0) - (x.requests ?? 0))[0];
  const db = t.sql[0];
  const backlog = sumBy(t.queues, (q) => q.depth ?? 0);
  const jobsFailed = t.jobs.filter((j) => j.status === "failed").length;
  const cronsFailed = t.schedules.filter((s) => s.failed).length;
  const a = t.auth;
  return (
    <button className="card cl-tcard" onClick={onOpen}>
      <div className="cl-tcard-hd">
        <b style={{ color: tenantColor(t.tenant) }}>{t.tenant}</b>
        <span className="muted mono small">{t.project}</span>
        <span className="cl-pill">{t.issues.length ? `${num(t.issues.length)} to look at` : "all clear"}</span>
      </div>
      <Spark values={reqHourly(t)} bad={errHourly(t)} width={216} height={26} />
      <div className="cl-kv">
        <span>Requests 24h</span>
        <span>{k(req)}</span>
        <span>5xx</span>
        <span className={e5 ? "warn" : ""}>
          {k(e5)}
          {req ? ` (${((e5 / req) * 100).toFixed(2)}%)` : ""}
        </span>
        <span>Backend p95</span>
        <span>{ms(be?.p95)}</span>
        <span>Error logs 24h</span>
        <span>{k(t.errors?.total)}</span>
        <span>Database CPU · disk</span>
        <span className={(db?.disk ?? 0) >= 0.8 ? "warn" : ""}>
          {pct(db?.cpu)} · {pct(db?.disk)}
        </span>
        <span>Queue backlog</span>
        <span>{k(backlog)}</span>
        <span>Firebase sign-in calls</span>
        <span>
          {a ? (
            <>
              {k(a.ok)} ok{a.err4xx ? <span className="warn"> · {num(a.err4xx)} rejected</span> : null}
            </>
          ) : (
            "–"
          )}
        </span>
        <span>Crons · jobs failing</span>
        <span className={cronsFailed || jobsFailed ? "bad" : ""}>
          {cronsFailed} · {jobsFailed}
        </span>
      </div>
    </button>
  );
}

function QueryRows({ rows, tenant }: { rows: Array<SlowQuery & { tenant?: string }>; tenant?: boolean }) {
  return (
    <div className="cl-tbl">
      <table>
        <thead>
          <tr>
            {tenant && <th />}
            <th className="n">avg</th>
            <th className="n">calls</th>
            <th className="n">total</th>
            <th>query</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((q, i) => (
            <tr key={i}>
              {tenant && (
                <td>
                  <TenantChip t={q.tenant!} />
                </td>
              )}
              <td className={`n ${q.meanMs >= 1000 ? "warn" : ""}`}>{ms(q.meanMs)}</td>
              <td className="n">{k(q.calls)}</td>
              <td className="n">{secs(q.totalS)}</td>
              <td className="cl-q" title={q.query}>
                {q.query}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AllBoard({ snap, onTab, onAsk }: { snap: CloudSnapshot; onTab(t: string): void; onAsk: IssueAct }) {
  const T = snap.tenants;
  const issues = T.flatMap((t) => t.issues).sort((a, b) => Number(a.ref?.slice(1)) - Number(b.ref?.slice(1)));
  const series = (f: (t: TenantCloud) => number[], total: (t: TenantCloud) => number | undefined) =>
    T.map((t) => ({ key: t.tenant, label: t.tenant, color: tenantColor(t.tenant), values: f(t), total: total(t) ?? "?" }));
  return (
    <>
      <Issues issues={issues} title="Needs attention" onAsk={onAsk} />
      <div className="cl-grid4 cl-tenants">
        {T.map((t) => (
          <TenantCard key={t.tenant} t={t} onOpen={() => onTab(t.tenant)} />
        ))}
      </div>
      <div className="card">
        <h3>
          Heaviest database queries · 24h<span className="ov-count">top 3 per environment by total time</span>
        </h3>
        <QueryRows tenant rows={T.flatMap((t) => (t.sql[0]?.slow?.byTotal ?? []).slice(0, 3).map((q) => ({ ...q, tenant: t.tenant })))} />
      </div>
      <div className="cl-grid2">
        <div className="card">
          <h3>Requests per hour</h3>
          <LineChart label="Requests per hour by environment" series={series(reqHourly, (t) => sumBy(t.services, (s) => s.requests))} />
        </div>
        <div className="card">
          <h3>Error logs per hour</h3>
          <LineChart label="Error log entries per hour by environment" series={series((t) => t.errors?.hourly ?? new Array(24).fill(0), (t) => t.errors?.total)} />
        </div>
        <div className="card">
          <h3>5xx per hour</h3>
          <LineChart label="5xx responses per hour by environment" series={series(errHourly, (t) => sumBy(t.services, (s) => s.err5xx))} />
        </div>
        <div className="card">
          <h3>Firebase auth calls per hour</h3>
          <LineChart
            label="Firebase auth API calls per hour by environment"
            series={series((t) => t.auth?.hourly ?? new Array(24).fill(0), (t) => (t.auth ? t.auth.ok + t.auth.err4xx + t.auth.err5xx : undefined))}
          />
        </div>
      </div>
    </>
  );
}

function TenantBoard({ t, onAsk }: { t: TenantCloud; onAsk: IssueAct }) {
  const [qmode, setQmode] = useState<"total" | "mean">("total");
  const db = t.sql[0];
  const sched = `https://console.cloud.google.com/cloudscheduler?project=${t.project}`;
  return (
    <>
      <Issues issues={t.issues} title={`${t.tenant} · needs attention`} onAsk={onAsk} />
      <div className="card">
        <h3>
          Cloud Run services<span className="ov-count">{num(t.services.length)}</span>
          <span className="cl-h-right">
            <Ext href={t.links.console} />
          </span>
        </h3>
        <div className="cl-tbl">
          <table>
            <thead>
              <tr>
                <th>service</th>
                <th>revision</th>
                <th className="n">requests</th>
                <th className="n">5xx</th>
                <th className="n">4xx</th>
                <th className="n">p95</th>
                <th className="n">inst</th>
                <th>24h</th>
                <th>deployed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {t.services.map((s) => (
                <tr key={s.name} onClick={() => open(s.link)} className="cl-click">
                  <td>
                    <span className={`gc-dot ${s.ready ? "ok" : "bad"}`} /> <b className="cl-nm">{s.name}</b>
                  </td>
                  <td className="muted mono">{(s.revision ?? "").replace(`${s.name}-`, "")}</td>
                  <td className="n">{k(s.requests)}</td>
                  <td className={`n ${s.err5xx ? "bad" : ""}`}>{s.err5xx || "·"}</td>
                  <td className="n muted">{k(s.err4xx)}</td>
                  <td className="n">{ms(s.p95)}</td>
                  <td className="n">{s.instances ?? "·"}</td>
                  <td>
                    <Spark values={s.hourly} bad={s.hourly5xx} />
                  </td>
                  <td className="muted">{ago(s.deployedAt)}</td>
                  <td>
                    <Ext href={s.link}>↗</Ext>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {db?.slow && (
        <div className="card">
          <h3>
            Database queries · 24h<span className="ov-count">Query Insights</span>
            <span className="cl-h-right cl-seg">
              <button className={qmode === "total" ? "on" : ""} onClick={() => setQmode("total")}>
                most total time
              </button>
              <button className={qmode === "mean" ? "on" : ""} onClick={() => setQmode("mean")}>
                slowest per call
              </button>
              <Ext href={db.link.replace("/overview", "/insights")}>insights ↗</Ext>
            </span>
          </h3>
          <QueryRows rows={qmode === "total" ? db.slow.byTotal : db.slow.byMean} />
        </div>
      )}
      <div className="cl-grid2">
        <div className="card">
          <h3>
            Top errors 24h<span className="ov-count">{k(t.errors?.total)} entries</span>
            <span className="cl-h-right">
              <Ext href={t.links.logs}>logs ↗</Ext>
            </span>
          </h3>
          {t.errors?.error ? (
            <div className="ov-empty">couldn't read logs ({t.errors.error})</div>
          ) : t.errors?.groups.length ? (
            t.errors.groups.slice(0, 8).map((g, i) => (
              <div key={i} className="cl-err" title={g.sample}>
                <span className="cl-err-n">{num(g.count)}</span>
                <span className="cl-err-svc">{g.service}</span>
                <span className="cl-err-sig">{g.signature}</span>
              </div>
            ))
          ) : (
            <div className="cl-clear">✓ no errors</div>
          )}
        </div>
        {t.auth && (
          <div className="card">
            <h3>
              Firebase auth<span className="ov-count">{t.auth.firebaseProject}</span>
              <span className="cl-h-right">
                <Ext href={t.auth.link} />
              </span>
            </h3>
            <div className="cl-kv cl-kv-pad">
              <span>Successful calls 24h</span>
              <span>{k(t.auth.ok)}</span>
              <span>Rejected (4xx)</span>
              <span className={t.auth.err4xx ? "warn" : ""}>{num(t.auth.err4xx)}</span>
              <span>Server errors (5xx)</span>
              <span className={t.auth.err5xx ? "bad" : ""}>{num(t.auth.err5xx)}</span>
            </div>
            <LineChart
              label="Firebase auth calls per hour"
              series={[
                { key: "calls", label: "calls", color: "var(--accent)", values: t.auth.hourly, total: t.auth.ok + t.auth.err4xx + t.auth.err5xx },
                { key: "rejected", label: "rejected", color: "var(--bad)", values: t.auth.hourlyErr, total: t.auth.err4xx + t.auth.err5xx },
              ]}
            />
          </div>
        )}
        {t.sql.map((d) => (
          <div key={d.name} className="card">
            <h3>
              Cloud SQL
              <span className="ov-count">
                {d.name} · {d.version} · {d.tier}
              </span>
              <span className="cl-h-right">
                <Ext href={d.link} />
              </span>
            </h3>
            <div className="cl-kv cl-kv-pad">
              <span>State</span>
              <span className={d.state === "RUNNABLE" ? "ok" : "bad"}>{d.state.toLowerCase()}</span>
              <span>CPU now</span>
              <span>{pct(d.cpu)}</span>
              <span>Memory</span>
              <span>{pct(d.mem)}</span>
              <span>Disk</span>
              <span className={(d.disk ?? 0) >= 0.8 ? "warn" : ""}>{pct(d.disk)}</span>
              <span>Connections</span>
              <span>{d.connections ?? "–"}</span>
            </div>
            <LineChart
              label="Database CPU per hour"
              format={(n) => `${Math.round(n)}%`}
              series={[{ key: "cpu", label: "CPU", color: "var(--accent)", values: d.cpuHourly.map((v) => v * 100), total: pct(d.cpu) }]}
            />
          </div>
        ))}
        <div className="card">
          <h3>
            Task queues<span className="ov-count">{num(t.queues.length)}</span>
          </h3>
          <div className="cl-tbl">
            <table>
              <thead>
                <tr>
                  <th>queue</th>
                  <th>state</th>
                  <th className="n">waiting</th>
                  <th>24h</th>
                </tr>
              </thead>
              <tbody>
                {t.queues.map((q) => (
                  <tr key={q.name} onClick={() => open(q.link)} className="cl-click">
                    <td className="cl-nm">{q.name}</td>
                    <td className={q.running ? "ok" : "warn"}>{q.running ? "running" : "paused"}</td>
                    <td className="n">{q.depth ?? 0}</td>
                    <td>
                      <Spark values={q.hourly} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="cl-grid2">
        <div className="card">
          <h3>
            Crons
            <span className="ov-count">
              {t.schedules.filter((s) => !s.paused).length} enabled · {t.schedules.filter((s) => s.paused).length} paused
            </span>
            <span className="cl-h-right">
              <Ext href={sched} />
            </span>
          </h3>
          <div className="cl-tbl">
            <table>
              <thead>
                <tr>
                  <th>cron</th>
                  <th>schedule</th>
                  <th>last run</th>
                  <th>result</th>
                </tr>
              </thead>
              <tbody>
                {[...t.schedules]
                  .sort((x, y) => Number(y.failed) - Number(x.failed) || Number(x.paused) - Number(y.paused) || (y.lastAttempt ?? 0) - (x.lastAttempt ?? 0))
                  .map((s) => (
                    <tr key={s.name} className={s.paused ? "cl-stale" : ""} title={s.target}>
                      <td className="cl-nm">{s.name}</td>
                      <td className="mono muted">{s.schedule}</td>
                      <td className="muted">{s.paused ? "paused" : ago(s.lastAttempt)}</td>
                      <td className={s.failed ? "bad" : s.paused ? "" : "ok"}>{s.failed ? `failed (${s.code})` : s.paused ? "–" : "ok"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3>
            Cloud Run jobs<span className="ov-count">{num(t.jobs.length)}</span>
          </h3>
          <div className="cl-tbl">
            <table>
              <thead>
                <tr>
                  <th>job</th>
                  <th>last run</th>
                  <th className="n">took</th>
                  <th>result</th>
                </tr>
              </thead>
              <tbody>
                {t.jobs.map((j) => (
                  <tr key={j.name} className={`cl-click ${j.status === "never" ? "cl-stale" : ""}`} onClick={() => open(j.link)}>
                    <td className="cl-nm">{j.name}</td>
                    <td className="muted">{ago(j.lastRun)}</td>
                    <td className="n">{j.durationS == null ? "·" : j.durationS >= 60 ? `${Math.round(j.durationS / 60)}m` : `${j.durationS}s`}</td>
                    <td className={j.status === "failed" ? "bad" : j.status === "succeeded" ? "ok" : j.status === "running" ? "warn" : "muted"}>{j.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function readLocal(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {}
}

/** The Cloud dashboard: live GCP state for every tenant, with a board-aware chat docked on the right. */
export function CloudView({ sessions, dropZone, onOpen }: { sessions: Record<string, SessionState>; dropZone: React.RefObject<HTMLElement | null>; onOpen(id: string): void }) {
  const [snap, setSnap] = useState<CloudSnapshot | null>(null);
  const [tab, setTab] = useState(() => readLocal(TAB_KEY, "all"));
  const [chatOpen, setChatOpen] = useState(() => readLocal(CHAT_KEY, "") === "open");
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatWidth, setChatWidth] = usePanelWidth("cloud-chat", 360);
  const [draft, setDraft] = useState<string | undefined>();
  const [, tick] = useState(0);

  useEffect(() => {
    hub().cloud().then(setSnap);
    const off = hub().onCloud(setSnap);
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  useEffect(() => writeLocal(TAB_KEY, tab), [tab]);
  useEffect(() => writeLocal(CHAT_KEY, chatOpen ? "open" : ""), [chatOpen]);
  useEffect(() => {
    if (chatOpen && !chatId) void hub().cloudChat().then((s) => setChatId(s.id));
  }, [chatOpen, chatId]);
  // On a laptop-width window an empty chat starts minimized (the bar at the bottom opens it).
  const autoMin = useRef(false);
  useEffect(() => {
    if (autoMin.current || !chatId || !sessions[chatId]) return;
    autoMin.current = true;
    if (window.innerWidth < 1500 && !sessions[chatId].items.length) setChatOpen(false);
  }, [chatId, sessions]);
  // ⌃/ toggles the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "/") {
        e.preventDefault();
        setChatOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tenants = snap?.tenants ?? [];
  const current = tenants.find((t) => t.tenant === tab);
  const board = current ? current.tenant : "all";
  // Ask/Fix on one issue spins off its own session (filed under "<Tenant> cloud"); the chat panel is for free-form questions.
  const ask: IssueAct = (mode, i) => {
    const t = tenants.find((x) => x.tenant === i.tenant);
    const facts = [i.facts?.length ? `Facts: ${i.facts.join("; ")}` : "", i.detail ? `Detail:\n${i.detail}` : ""];
    void hub()
      .cloudSpawn(
        mode === "ask"
          ? { mode, board: i.tenant, title: i.text, prompt: [`What's causing this${i.ref ? ` (${i.ref})` : ""}? ${i.text}`, ...facts].filter(Boolean).join("\n\n") }
          : { mode, board: i.tenant, title: `${i.tenant}: ${i.text}`, prompt: fixPrompt(t, i.text, facts) },
      )
      .then((s) => onOpen(s.id));
  };
  const chat = chatId ? sessions[chatId] : undefined;
  const allIssues = tenants.flatMap((t) => t.issues).length;

  return (
    <div className="cl">
      <div className="cl-main">
        <div className="cl-tabs">
          <button className={`cl-tab ${board === "all" ? "on" : ""}`} onClick={() => setTab("all")}>
            all{allIssues > 0 && <span className="cl-n">{allIssues}</span>}
          </button>
          {tenants.map((t) => (
            <button key={t.tenant} className={`cl-tab ${tab === t.tenant ? "on" : ""}`} onClick={() => setTab(t.tenant)}>
              {t.tenant}
              {t.issues.length > 0 && <span className="cl-n">{num(t.issues.length)}</span>}
            </button>
          ))}
          <span className="cl-tabs-right">
            <span className="muted mono small">{snap?.refreshing ? "refreshing…" : snap?.fetchedAt ? `updated ${ago(snap.fetchedAt)} · every 10m` : ""}</span>
            <button className="kb" disabled={snap?.refreshing} onClick={() => void hub().cloud(true).then(setSnap)}>
              refresh
            </button>
          </span>
        </div>
        <div className="cl-scroll">
          {snap && !snap.authOk && (
            <div className="cl-banner">
              <span>
                <b>{snap.installed ? "gcloud login expired." : "gcloud isn't installed."}</b>{" "}
                <span className="muted">{snap.fetchedAt ? `Showing data from ${ago(snap.fetchedAt)}. Sign in to refresh.` : "Sign in to load your cloud data."}</span>
              </span>
              {snap.installed && (
                <button className="kb" onClick={() => startGcloudLogin("user")}>
                  sign in to gcloud
                </button>
              )}
            </div>
          )}
          {!snap ? (
            <div className="muted pad center mono small">loading cloud data…</div>
          ) : !tenants.length ? (
            snap.authOk && <div className="muted pad center mono small">No tenants found (looking for env.*.prod files in your repos).</div>
          ) : current ? (
            <TenantBoard key={current.tenant} t={current} onAsk={ask} />
          ) : (
            <AllBoard snap={snap} onTab={setTab} onAsk={ask} />
          )}
        </div>
        {!chatOpen && (
          <button className="cl-chatbar" onClick={() => setChatOpen(true)}>
            <span className="m-only">chat</span>
            <span className="m-hide-text">Ask about</span> <b>{board === "all" ? "all tenants" : board}</b>
            <span className="kbd">⌃/</span>
          </button>
        )}
      </div>
      {chatOpen && <ResizeHandle width={chatWidth} onWidth={setChatWidth} side="right" min={300} max={900} reset={400} />}
      {chatOpen && (
        <aside className="cl-chat" style={{ width: chatWidth }}>
          <div className="cl-chat-h">
            <b>Cloud chat</b>
            <span className="muted mono small">sees: {board === "all" ? "all tenants" : board}</span>
            {chat && chat.items.length > 0 && (
              <button className="link-btn cl-newchat" disabled={chat.status === "running"} onClick={() => void hub().newSystemChat(chat.id)} title="Start a fresh conversation">
                new chat
              </button>
            )}
            <button className="icon-btn cl-min" title="Minimize (⌃/)" onClick={() => setChatOpen(false)}>
              –
            </button>
          </div>
          {chat ? (
            <ChatBody chat={chat} board={board} draft={draft} onDraftUsed={() => setDraft(undefined)} dropZone={dropZone} />
          ) : (
            <div className="muted pad center mono small">starting…</div>
          )}
        </aside>
      )}
    </div>
  );
}

function ChatBody(props: { chat: SessionState; board: string; draft?: string; onDraftUsed(): void; dropZone: React.RefObject<HTMLElement | null> }) {
  // A prefilled question (from an "ask" button) is sent right away with the current board attached.
  useEffect(() => {
    if (!props.draft) return;
    void hub().cloudAsk(props.draft, props.board);
    props.onDraftUsed();
  }, [props.draft]);
  return (
    <SessionView
      key={props.chat.id}
      session={props.chat}
      dropZone={props.dropZone}
      onSend={(text) => void hub().cloudAsk(text, props.board)}
      placeholder={`ask about ${props.board === "all" ? "all tenants" : props.board}`}
    />
  );
}
