import { MessageCircle, RefreshCw, Wrench } from "lucide-react";
import { num } from "../models";
import { createContext, useContext, useEffect, useState } from "react";
import type { CloudIssue, CloudService, CloudSnapshot, GcpErrorGroup, SlowQuery, TenantCloud } from "../../shared/types";
import { hub } from "../App";
import { LineChart, Spark, tenantColor } from "../charts";
import { startGcloudLogin } from "../GcloudChip";
import { BigTitle, Chips, Empty, Fab, Group, IconBtn, Nav, Pill, Row, Sheet, ago } from "./ui";

/** What you can start from anything on the Cloud pages: a question to the Cloud chat, or a new coding session to fix it. */
export interface CloudActions {
  ask(board: string, question: string): void;
  fix(board: string, title: string, prompt: string): void;
}
const Actions = createContext<CloudActions>({ ask: () => {}, fix: () => {} });
const useActions = () => useContext(Actions);

const k = (n?: number) => (n == null ? "–" : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const pct = (n?: number) => (n == null ? "–" : `${Math.round(n * 100)}%`);
const ms = (n?: number) => (n == null ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
const sum24 = (rows: number[][]) => rows.reduce((acc, r) => acc.map((v, i) => v + (r[i] ?? 0)), new Array(24).fill(0) as number[]);
const TChip = ({ t }: { t: string }) => (
  <span className="mx-tchip" style={{ ["--c" as string]: tenantColor(t) }}>
    {t}
  </span>
);

/** The prompt for a fix session: the problem as Cloud sees it, plus how to work on it safely. */
export function fixPrompt(tenant: TenantCloud | undefined, what: string, details: string[]) {
  return [
    `Investigate and fix this production issue${tenant ? ` on ${tenant.tenant} (GCP project ${tenant.project}${tenant.region ? `, ${tenant.region}` : ""})` : ""}:`,
    what,
    ...details.filter(Boolean),
    "Start by confirming it with read-only gcloud (logs, metrics) and the code. Then propose the fix and implement it on this branch. Don't deploy or change cloud resources without asking me first.",
  ].join("\n\n");
}

/** Ask / Fix buttons used on every Cloud detail. */
function AskFix({ board, question, fixTitle, fix }: { board: string; question: string; fixTitle?: string; fix?: string }) {
  const a = useActions();
  return (
    <div className="mx-btnrow">
      <button className="mx-btn" onClick={() => a.ask(board, question)}>
        <MessageCircle size={16} /> Ask
      </button>
      {fix && (
        <button className="mx-btn primary" onClick={() => a.fix(board, fixTitle ?? question, fix)}>
          <Wrench size={16} /> Fix in new chat
        </button>
      )}
    </div>
  );
}

function Chart({ title, note, series, format }: { title: string; note?: string; series: Array<{ key: string; label: string; values: number[]; color: string; total?: number | string }>; format?: (n: number) => string }) {
  return (
    <div className="mx-chart">
      <div className="mx-chart-h">
        <b>{title}</b>
        {note && <span>{note}</span>}
      </div>
      <LineChart label={title} height={130} series={series} format={format} />
    </div>
  );
}

/** A needs-attention item with its details inline: facts, the error/query, the trend, and actions. */
function IssueCard({ i, tenant, onOpen }: { i: CloudIssue; tenant?: TenantCloud; onOpen(): void }) {
  const a = useActions();
  return (
    <div className={`mx-issue ${i.severity}`}>
      <button className="mx-issue-main" onClick={onOpen}>
        <span className="mx-issue-h">
          <TChip t={i.tenant} />
          <span className="mx-issue-area">{i.area}</span>
          <span className="mx-issue-ref">{i.ref}</span>
        </span>
        <b>{i.text}</b>
        {!!i.facts?.length && (
          <span className="mx-issue-facts">
            {i.facts.slice(0, 4).map((f) => (
              <span key={f}>{f}</span>
            ))}
          </span>
        )}
        {i.detail && <code className="mx-issue-detail">{i.detail}</code>}
        {i.series && (
          <span className="mx-issue-spark">
            <Spark values={i.series} width={300} height={28} />
          </span>
        )}
      </button>
      <span className="mx-issue-acts">
        <button onClick={() => a.ask(i.tenant, `What's causing ${i.ref}? (${i.text})`)}>
          <MessageCircle size={15} /> Ask
        </button>
        {i.area !== "fetch" && (
          <button onClick={() => a.fix(i.tenant, `${i.tenant}: ${i.text}`, fixPrompt(tenant, i.text, [i.facts?.length ? `Facts: ${i.facts.join("; ")}` : "", i.detail ? `Detail:\n${i.detail}` : ""]))}>
            <Wrench size={15} /> Fix
          </button>
        )}
      </span>
    </div>
  );
}

function IssueSheet({ i, tenant, onClose }: { i: CloudIssue; tenant?: TenantCloud; onClose(): void }) {
  return (
    <Sheet onClose={onClose} full>
      <div className="mx-sheet-sub mx-inline">
        <TChip t={i.tenant} /> {i.area} · {i.ref}
      </div>
      <h4 className="mx-sheet-title">{i.text}</h4>
      {!!i.facts?.length && (
        <div className="mx-facts">
          {i.facts.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      )}
      {i.detail && <pre className="mx-cmd">{i.detail}</pre>}
      {i.series && (
        <div className="mx-pad">
          <Chart title="Last 24 hours" series={[{ key: "s", label: i.area === "sql" ? "CPU %" : "per hour", values: i.series, color: "var(--warn)" }]} />
        </div>
      )}
      <AskFix board={i.tenant} question={`What's causing ${i.ref}? (${i.text})`} fixTitle={`${i.tenant}: ${i.text}`} fix={i.area === "fetch" ? undefined : fixPrompt(tenant, i.text, [i.facts?.length ? `Facts: ${i.facts.join("; ")}` : "", i.detail ? `Detail:\n${i.detail}` : ""])} />
    </Sheet>
  );
}

function ServiceScreen({ svc, t, onBack }: { svc: CloudService; t: TenantCloud; onBack(): void }) {
  const errs = (t.errors?.groups ?? []).filter((g) => g.service === svc.name);
  return (
    <div className="mx-screen mx-dense">
      <Nav onBack={onBack} title={svc.name} />
      <div className="mx-scroll">
        <div className="mx-sub-pad mx-inline">
          <TChip t={t.tenant} /> {svc.ready ? "serving" : "not ready"} · {svc.region}
        </div>
        <div className="mx-metrics">
          <div>
            <span>Requests 24h</span>
            <b>{k(svc.requests)}</b>
          </div>
          <div>
            <span>5xx</span>
            <b className={svc.err5xx ? "warn" : ""}>{k(svc.err5xx)}</b>
          </div>
          <div>
            <span>p95 latency now</span>
            <b>{ms(svc.p95)}</b>
          </div>
          <div>
            <span>4xx · instances</span>
            <b>
              {k(svc.err4xx)} · {svc.instances ?? "–"}
            </b>
          </div>
        </div>
        <div className="mx-pad">
          <Chart
            title="Requests per hour"
            series={[
              { key: "r", label: "requests", values: svc.hourly, color: "var(--accent)", total: k(svc.requests) },
              { key: "e", label: "5xx", values: svc.hourly5xx, color: "var(--bad)", total: svc.err5xx },
            ]}
          />
        </div>
        {errs.length > 0 && (
          <Group title="Errors from this service">
            {errs.map((g, i) => (
              <Row key={i} chevron={false} wrap title={g.signature} sub={`${num(g.count)}× · last ${ago(g.lastSeen)} ago`} />
            ))}
          </Group>
        )}
        <Group title="Deploy">
          <Row chevron={false} title="Revision" right={(svc.revision ?? "–").replace(`${svc.name}-`, "")} />
          <Row chevron={false} title="Deployed" right={svc.deployedAt ? `${ago(svc.deployedAt)} ago` : "–"} />
          {svc.deployedBy && <Row chevron={false} title="By" right={svc.deployedBy} />}
        </Group>
        <div className="mx-gap" />
        <AskFix
          board={t.tenant}
          question={`How is ${svc.name} on ${t.tenant} doing? Anything wrong in the last 24h?`}
          fixTitle={`${t.tenant}: ${svc.name} errors`}
          fix={
            svc.err5xx || errs.length
              ? fixPrompt(t, `${svc.name} returned ${num(svc.err5xx)} server errors (5xx) in 24h out of ${num(svc.requests)} requests.`, [errs.length ? `Top errors:\n${errs.slice(0, 5).map((g) => `×${num(g.count)} ${g.signature}`).join("\n")}` : ""])
              : undefined
          }
        />
      </div>
    </div>
  );
}

type Detail = { kind: "error"; g: GcpErrorGroup } | { kind: "query"; q: SlowQuery } | { kind: "issue"; i: CloudIssue } | null;

function TenantScreen({ t, onBack }: { t: TenantCloud; onBack(): void }) {
  const [svcName, setSvcName] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail>(null);
  const [open, setOpen] = useState<string | null>(null);
  const db = t.sql[0];
  const req = t.services.reduce((n, s) => n + s.requests, 0);
  const e5 = t.services.reduce((n, s) => n + s.err5xx, 0);
  const svc = t.services.find((s) => s.name === svcName);
  if (svc) return <ServiceScreen svc={svc} t={t} onBack={() => setSvcName(null)} />;
  const toggle = (id: string) => setOpen(open === id ? null : id);
  return (
    <div className="mx-screen mx-dense">
      <Nav onBack={onBack} title={t.tenant} />
      <div className="mx-scroll">
        <div className="mx-sub-pad">
          {t.project} · {t.region}
        </div>
        <div className="mx-metrics">
          <div>
            <span>Requests 24h</span>
            <b>{k(req)}</b>
          </div>
          <div>
            <span>5xx</span>
            <b className={e5 ? "warn" : ""}>{k(e5)}</b>
          </div>
          <div>
            <span>Error logs</span>
            <b>{k(t.errors?.total)}</b>
          </div>
          <div>
            <span>DB CPU · disk</span>
            <b>
              {pct(db?.cpu)} · {pct(db?.disk)}
            </b>
          </div>
        </div>
        {t.issues.length > 0 && (
          <>
            <div className="mx-group-h">
              <span>Needs attention</span>
            </div>
            <div className="mx-issues">
              {t.issues.map((i, n) => (
                <IssueCard key={n} i={i} tenant={t} onOpen={() => setDetail({ kind: "issue", i })} />
              ))}
            </div>
          </>
        )}
        <div className="mx-pad">
          <Chart
            title="Requests per hour"
            series={[
              { key: "r", label: "requests", values: sum24(t.services.map((s) => s.hourly)), color: "var(--accent)", total: k(req) },
              { key: "e", label: "5xx", values: sum24(t.services.map((s) => s.hourly5xx)), color: "var(--bad)", total: e5 },
            ]}
          />
          {t.errors && <Chart title="Error logs per hour" series={[{ key: "l", label: "entries", values: t.errors.hourly, color: "var(--warn)", total: t.errors.total }]} />}
          {db && <Chart title="Database CPU" note={`${db.tier} · ${db.connections ?? "?"} connections`} format={(n) => `${Math.round(n)}%`} series={[{ key: "c", label: "CPU", values: db.cpuHourly.map((v) => v * 100), color: "var(--accent)", total: pct(db.cpu) }]} />}
        </div>
        <Group title="Services">
          {t.services.map((s) => (
            <Row key={s.name} title={s.name} sub={`${k(s.requests)} req · p95 ${ms(s.p95)}`} right={s.err5xx ? <Pill tone="bad">{num(s.err5xx)} 5xx</Pill> : null} onClick={() => setSvcName(s.name)} />
          ))}
        </Group>
        {!!t.errors?.groups.length && (
          <Group title={`Top errors · ${k(t.errors.total)}`}>
            {t.errors.groups.slice(0, 10).map((g, i) => (
              <Row key={i} wrap title={g.signature} sub={`${num(g.count)}× · ${g.service} · last ${ago(g.lastSeen)} ago`} onClick={() => setDetail({ kind: "error", g })} />
            ))}
          </Group>
        )}
        {db?.slow && (
          <Group title="Slowest database queries">
            {db.slow.byMean.slice(0, 6).map((q, i) => (
              <Row key={i} wrap title={<code className="mx-q">{q.query}</code>} sub={`${ms(q.meanMs)} avg · ${num(q.calls)} calls · ${q.totalS >= 60 ? `${Math.round(q.totalS / 60)}m` : `${Math.round(q.totalS)}s`} total`} onClick={() => setDetail({ kind: "query", q })} />
            ))}
          </Group>
        )}
        <Group title="Background work">
          <Row title="Crons" right={t.schedules.filter((s) => s.failed).length ? `${t.schedules.filter((s) => s.failed).length} failing` : `${num(t.schedules.length)} · all ok`} onClick={() => toggle("c")} />
          {open === "c" &&
            t.schedules.map((s) => (
              <Row key={s.name} chevron={false} title={s.name} sub={`${s.schedule}${s.target ? ` · ${s.target}` : ""} · ${s.paused ? "paused" : s.lastAttempt ? `ran ${ago(s.lastAttempt)} ago` : "never ran"}`} right={s.failed ? <Pill tone="bad">failed</Pill> : null} />
            ))}
          <Row title="Jobs" right={`${t.jobs.filter((j) => j.status === "failed").length} failed · ${num(t.jobs.length)}`} onClick={() => toggle("j")} />
          {open === "j" &&
            t.jobs.map((j) => (
              <Row key={j.name} chevron={false} title={j.name} sub={`${j.lastRun ? `ran ${ago(j.lastRun)} ago` : "never ran"}${j.durationS != null ? ` · took ${j.durationS >= 60 ? `${Math.round(j.durationS / 60)}m` : `${j.durationS}s`}` : ""}`} right={<Pill tone={j.status === "failed" ? "bad" : j.status === "running" ? "run" : undefined}>{j.status}</Pill>} />
            ))}
          <Row title="Task queues" right={`${t.queues.reduce((n, q) => n + (q.depth ?? 0), 0)} waiting`} onClick={() => toggle("q")} />
          {open === "q" && (
            <div className="mx-pad">
              <Chart title="Tasks waiting per hour" series={t.queues.map((q, i) => ({ key: q.name, label: q.name, values: q.hourly, color: ["var(--accent)", "var(--warn)", "var(--ok)", "var(--tag)", "var(--dim)"][i % 5], total: q.depth ?? 0 }))} />
            </div>
          )}
          {t.auth && <Row title="Firebase sign-in" right={`${k(t.auth.ok)} ok${t.auth.err4xx ? ` · ${num(t.auth.err4xx)} rejected` : ""}`} onClick={() => toggle("a")} />}
          {open === "a" && t.auth && (
            <div className="mx-pad">
              <Chart
                title="Sign-in calls per hour"
                series={[
                  { key: "c", label: "calls", values: t.auth.hourly, color: "var(--accent)", total: t.auth.ok + t.auth.err4xx + t.auth.err5xx },
                  { key: "x", label: "rejected", values: t.auth.hourlyErr, color: "var(--bad)", total: t.auth.err4xx + t.auth.err5xx },
                ]}
              />
            </div>
          )}
        </Group>
        <div className="mx-gap" />
        <AskFix board={t.tenant} question={`Give me a quick health check of ${t.tenant}: what's wrong and what should I fix first?`} />
      </div>
      {detail?.kind === "issue" && <IssueSheet i={detail.i} tenant={t} onClose={() => setDetail(null)} />}
      {detail?.kind === "error" && (
        <Sheet onClose={() => setDetail(null)}>
          <div className="mx-sheet-sub">
            {detail.g.service} · {num(detail.g.count)}× · last {ago(detail.g.lastSeen)} ago
          </div>
          <h4 className="mx-sheet-title mx-small-title">{detail.g.signature}</h4>
          {detail.g.sample && <pre className="mx-cmd">{detail.g.sample}</pre>}
          <AskFix
            board={t.tenant}
            question={`What's causing this ${detail.g.service} error on ${t.tenant}? "${detail.g.signature}"`}
            fixTitle={`${t.tenant}: ${detail.g.service} error`}
            fix={fixPrompt(t, `${detail.g.service} logged this error ${num(detail.g.count)} times in 24h:`, [detail.g.sample || detail.g.signature])}
          />
        </Sheet>
      )}
      {detail?.kind === "query" && (
        <Sheet onClose={() => setDetail(null)} full>
          <div className="mx-sheet-sub">
            {ms(detail.q.meanMs)} average · {num(detail.q.calls)} calls · {Math.round(detail.q.totalS)}s of database time in 24h
          </div>
          <pre className="mx-cmd">{detail.q.query}</pre>
          <AskFix
            board={t.tenant}
            question={`Why is this query slow on ${t.tenant} (${ms(detail.q.meanMs)} avg, ${num(detail.q.calls)} calls)? ${detail.q.query.slice(0, 300)}`}
            fixTitle={`${t.tenant}: slow query`}
            fix={fixPrompt(t, `This database query averages ${ms(detail.q.meanMs)} and ran ${num(detail.q.calls)} times in 24h. Find where it comes from and make it fast (index, query change, or caching).`, [detail.q.query])}
          />
        </Sheet>
      )}
    </div>
  );
}

export function MCloud({ actions }: { actions: CloudActions }) {
  const [snap, setSnap] = useState<CloudSnapshot | null>(null);
  const [filter, setFilter] = useState("all");
  const [issue, setIssue] = useState<CloudIssue | null>(null);
  const [tenant, setTenant] = useState<string | null>(null);
  useEffect(() => {
    void hub().cloud().then(setSnap);
    return hub().onCloud(setSnap);
  }, []);
  const tenants = snap?.tenants ?? [];
  const t = tenants.find((x) => x.tenant === tenant);
  const issues = tenants
    .flatMap((x) => x.issues)
    .filter((i) => filter === "all" || i.tenant === filter)
    .sort((a, b) => Number(a.ref?.slice(1) ?? 99) - Number(b.ref?.slice(1) ?? 99));
  return (
    <Actions.Provider value={actions}>
      {t ? (
        <TenantScreen t={t} onBack={() => setTenant(null)} />
      ) : (
        <div className="mx-screen">
          <Nav
            right={
              <IconBtn label="Refresh" onClick={() => void hub().cloud(true).then(setSnap)}>
                <RefreshCw size={17} className={snap?.refreshing ? "mx-spin" : ""} />
              </IconBtn>
            }
          />
          <div className="mx-scroll">
            <BigTitle sub={snap?.fetchedAt ? (ago(snap.fetchedAt) === "now" ? "updated just now" : `updated ${ago(snap.fetchedAt)} ago`) : undefined}>Cloud</BigTitle>
            {snap && !snap.authOk && (
              <button className="mx-banner" onClick={() => startGcloudLogin("user")}>
                gcloud login expired. Sign in on the laptop ›
              </button>
            )}
            <Chips value={filter} onChange={setFilter} options={[["all", `All ${tenants.reduce((n, x) => n + x.issues.length, 0) || ""}`], ...tenants.map((x) => [x.tenant, `${x.tenant}${x.issues.length ? ` ${num(x.issues.length)}` : ""}`] as [string, string])]} />
            {!snap ? (
              <Empty>loading…</Empty>
            ) : (
              <>
                <div className="mx-group-h">
                  <span>Needs attention</span>
                </div>
                <div className="mx-issues">
                  {issues.length ? issues.map((i, n) => <IssueCard key={n} i={i} tenant={tenants.find((x) => x.tenant === i.tenant)} onOpen={() => setIssue(i)} />) : <Empty>Nothing needs attention ✓</Empty>}
                </div>
                <Group title="Tenants">
                  {tenants
                    .filter((x) => filter === "all" || x.tenant === filter)
                    .map((x) => (
                      <Row key={x.tenant} lead={<TChip t={x.tenant} />} title={x.project} sub={`${k(x.services.reduce((n, s) => n + s.requests, 0))} req · ${k(x.errors?.total)} errors · DB ${pct(x.sql[0]?.disk)} disk`} onClick={() => setTenant(x.tenant)} />
                    ))}
                </Group>
              </>
            )}
          </div>
          <Fab onClick={() => actions.ask(filter, "")}>
            <MessageCircle size={18} /> Ask
          </Fab>
          {issue && <IssueSheet i={issue} tenant={tenants.find((x) => x.tenant === issue.tenant)} onClose={() => setIssue(null)} />}
        </div>
      )}
    </Actions.Provider>
  );
}
