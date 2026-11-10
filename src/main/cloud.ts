import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CloudAuth,
  CloudIssue,
  CloudJob,
  CloudQueue,
  CloudSchedule,
  CloudService,
  CloudSnapshot,
  CloudSql,
  Health,
  SlowQuery,
  TenantCloud,
  TenantErrors,
} from "../shared/types.js";

const run = promisify(execFile);
/** Counts in issue text with thousands separators. */
const num = (n?: number) => (n ?? 0).toLocaleString("en-US");
const HOURS = 24;

async function gjson<T = any>(args: string[]): Promise<T> {
  const { stdout } = await run("gcloud", [...args, "--format=json"], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout || "[]") as T;
}

/** Short reason from a gcloud / API failure (first meaningful line). */
function reason(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = String(e.stderr || e.message || err);
  const line = text.split("\n").find((l) => /ERROR|denied|disabled|not found|PERMISSION|UNAUTH|reauth/i.test(l)) ?? text.split("\n")[0];
  return line.replace(/^ERROR: \([^)]*\)\s*/, "").slice(0, 200);
}

/** Access token for the Monitoring REST API — kept in memory only, refreshed every ~45 min. */
let token: { value: string; at: number } | undefined;
async function accessToken(): Promise<string> {
  if (token && Date.now() - token.at < 45 * 60_000) return token.value;
  const { stdout } = await run("gcloud", ["auth", "print-access-token", "--quiet"], { timeout: 20_000 });
  token = { value: stdout.trim(), at: Date.now() };
  return token.value;
}
export function dropToken() {
  token = undefined;
}

interface Series {
  labels: Record<string, string>;
  /** HOURS buckets, oldest first, ending at the current hour; undefined where no point was reported. */
  values: Array<number | undefined>;
}

/** One Cloud Monitoring timeSeries.list call, bucketed hourly over the last 24h. */
async function metric(
  project: string,
  filter: string,
  aligner: string,
  opts: { reducer?: string; groupBy?: string[] } = {},
): Promise<Series[]> {
  const end = new Date();
  const start = new Date(end.getTime() - HOURS * 3600_000);
  const q = new URLSearchParams({
    filter,
    "interval.startTime": start.toISOString(),
    "interval.endTime": end.toISOString(),
    "aggregation.alignmentPeriod": "3600s",
    "aggregation.perSeriesAligner": aligner,
  });
  if (opts.reducer) q.set("aggregation.crossSeriesReducer", opts.reducer);
  for (const g of opts.groupBy ?? []) q.append("aggregation.groupByFields", g);
  const out: Series[] = [];
  let pageToken: string | undefined;
  do {
    if (pageToken) q.set("pageToken", pageToken);
    const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${q}`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) dropToken();
    if (!res.ok) throw new Error(`monitoring ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const body = (await res.json()) as any;
    const nowHour = Math.floor(end.getTime() / 3600_000);
    for (const ts of body.timeSeries ?? []) {
      const values: Array<number | undefined> = new Array(HOURS).fill(undefined);
      for (const p of ts.points ?? []) {
        const h = Math.floor((Date.parse(p.interval.endTime) - 1) / 3600_000);
        const idx = HOURS - 1 - (nowHour - h);
        const v = p.value.int64Value ?? p.value.doubleValue ?? p.value.boolValue;
        if (idx >= 0 && idx < HOURS && v != null) values[idx] = Number(v);
      }
      out.push({ labels: { ...ts.metric?.labels, ...ts.resource?.labels }, values });
    }
    pageToken = body.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

/** Query Insights per-query latency over the whole last 24h (one bucket), summed across users/clients. */
async function slowQueries(project: string): Promise<{ byTotal: SlowQuery[]; byMean: SlowQuery[] }> {
  const end = new Date();
  const q = new URLSearchParams({
    filter: 'metric.type="cloudsql.googleapis.com/database/postgresql/insights/perquery/latencies"',
    "interval.startTime": new Date(end.getTime() - HOURS * 3600_000).toISOString(),
    "interval.endTime": end.toISOString(),
    "aggregation.alignmentPeriod": `${HOURS * 3600}s`,
    "aggregation.perSeriesAligner": "ALIGN_DELTA",
    "aggregation.crossSeriesReducer": "REDUCE_SUM",
  });
  q.append("aggregation.groupByFields", "metric.label.querystring");
  const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${q}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`query insights ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = (await res.json()) as any;
  const rows: SlowQuery[] = [];
  for (const ts of body.timeSeries ?? []) {
    const d = ts.points?.[0]?.value?.distributionValue;
    const calls = Number(d?.count ?? 0);
    if (!calls) continue;
    const meanMs = Number(d.mean ?? 0) / 1000; // latencies are in microseconds
    rows.push({ query: String(ts.metric?.labels?.querystring ?? "").replace(/\s+/g, " ").slice(0, 600), calls, meanMs, totalS: (meanMs * calls) / 1000 });
  }
  return {
    byTotal: [...rows].sort((a, b) => b.totalS - a.totalS).slice(0, 10),
    byMean: [...rows].sort((a, b) => b.meanMs - a.meanMs).slice(0, 10),
  };
}

const filled = (v: Array<number | undefined>) => v.map((x) => x ?? 0);
const sum = (v: Array<number | undefined>) => v.reduce<number>((n, x) => n + (x ?? 0), 0);
const latest = (v: Array<number | undefined>) => [...v].reverse().find((x) => x != null);
const addInto = (a: number[], b: Array<number | undefined>) => b.forEach((x, i) => (a[i] += x ?? 0));

/** Run a section; on failure record why and return the fallback so the rest of the dashboard still renders. */
async function section<T>(failures: Record<string, string>, name: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    failures[name] = reason(err);
    return fallback;
  }
}

const consoleUrl = (path: string, project: string) => `https://console.cloud.google.com/${path}${path.includes("?") ? "&" : "?"}project=${project}`;

async function services(project: string, failures: Record<string, string>): Promise<CloudService[]> {
  const list = await section(failures, "cloud run", [] as any[], () => gjson(["run", "services", "list", `--project=${project}`]));
  if (!list.length) return [];
  const [req, p95, inst] = await Promise.all([
    section(failures, "run metrics", [] as Series[], () =>
      metric(project, 'metric.type="run.googleapis.com/request_count"', "ALIGN_SUM", {
        reducer: "REDUCE_SUM",
        groupBy: ["resource.label.service_name", "metric.label.response_code_class"],
      }),
    ),
    section(failures, "run metrics", [] as Series[], () =>
      metric(project, 'metric.type="run.googleapis.com/request_latencies"', "ALIGN_PERCENTILE_95", { reducer: "REDUCE_MAX", groupBy: ["resource.label.service_name"] }),
    ),
    section(failures, "run metrics", [] as Series[], () =>
      metric(project, 'metric.type="run.googleapis.com/container/instance_count"', "ALIGN_MAX", { reducer: "REDUCE_SUM", groupBy: ["resource.label.service_name"] }),
    ),
  ]);
  return list.map((s: any): CloudService => {
    const name = s.metadata.name as string;
    const region = s.metadata.labels?.["cloud.googleapis.com/location"] ?? "";
    const ready = s.status?.conditions?.find((c: any) => c.type === "Ready");
    const mine = req.filter((r) => r.labels.service_name === name);
    const hourly = new Array(HOURS).fill(0);
    const hourly5xx = new Array(HOURS).fill(0);
    let err4xx = 0;
    for (const r of mine) {
      addInto(hourly, r.values);
      if (r.labels.response_code_class === "5xx") addInto(hourly5xx, r.values);
      if (r.labels.response_code_class === "4xx") err4xx += sum(r.values);
    }
    return {
      name,
      region,
      url: s.status?.url,
      ready: ready?.status === "True",
      revision: s.status?.latestReadyRevisionName,
      deployedAt: ready?.lastTransitionTime ? Date.parse(ready.lastTransitionTime) : undefined,
      deployedBy: s.metadata.annotations?.["serving.knative.dev/lastModifier"],
      requests: sum(hourly),
      err5xx: sum(hourly5xx),
      err4xx,
      p95: latest(p95.find((r) => r.labels.service_name === name)?.values ?? []),
      instances: latest(inst.find((r) => r.labels.service_name === name)?.values ?? []),
      hourly,
      hourly5xx,
      link: consoleUrl(`run/detail/${region}/${name}/metrics`, project),
    };
  });
}

async function jobs(project: string, failures: Record<string, string>): Promise<CloudJob[]> {
  const list = await section(failures, "run jobs", [] as any[], () => gjson(["run", "jobs", "list", `--project=${project}`]));
  return list.map((j: any): CloudJob => {
    const name = j.metadata.name as string;
    const region = j.metadata.labels?.["cloud.googleapis.com/location"] ?? "";
    const ex = j.status?.latestCreatedExecution;
    const started = ex?.creationTimestamp ? Date.parse(ex.creationTimestamp) : undefined;
    const done = ex?.completionTimestamp ? Date.parse(ex.completionTimestamp) : undefined;
    const cs = String(ex?.completionStatus ?? "");
    const status: CloudJob["status"] = !ex?.name
      ? "never"
      : !done
        ? "running"
        : /FAILED/.test(cs)
          ? "failed"
          : /CANCELLED/.test(cs)
            ? "cancelled"
            : "succeeded";
    return { name, status, lastRun: started, durationS: started && done ? Math.round((done - started) / 1000) : undefined, link: consoleUrl(`run/jobs/details/${region}/${name}/executions`, project) };
  });
}

async function schedules(project: string, region: string | undefined, failures: Record<string, string>): Promise<CloudSchedule[]> {
  if (!region) return [];
  const list = await section(failures, "scheduler", [] as any[], () => gjson(["scheduler", "jobs", "list", `--project=${project}`, `--location=${region}`]));
  return list.map((s: any): CloudSchedule => {
    const paused = s.state !== "ENABLED";
    const code = s.status?.code;
    const target = s.httpTarget?.uri ? new URL(s.httpTarget.uri).pathname : undefined;
    return {
      name: String(s.name).split("/").pop()!,
      schedule: s.schedule,
      timeZone: s.timeZone,
      paused,
      lastAttempt: s.lastAttemptTime ? Date.parse(s.lastAttemptTime) : undefined,
      failed: !paused && code != null && code !== 0,
      code,
      target,
    };
  });
}

async function queues(project: string, region: string | undefined, failures: Record<string, string>): Promise<CloudQueue[]> {
  if (!region) return [];
  const [list, depth] = await Promise.all([
    section(failures, "cloud tasks", [] as any[], () => gjson(["tasks", "queues", "list", `--project=${project}`, `--location=${region}`])),
    section(failures, "tasks metrics", [] as Series[], () =>
      metric(project, 'metric.type="cloudtasks.googleapis.com/queue/depth"', "ALIGN_MAX", { reducer: "REDUCE_SUM", groupBy: ["resource.label.queue_id"] }),
    ),
  ]);
  return list.map((q: any): CloudQueue => {
    const name = String(q.name).split("/").pop()!;
    const d = depth.find((s) => s.labels.queue_id === name)?.values ?? [];
    return { name, running: q.state === "RUNNING", depth: latest(d), hourly: filled(d.length ? d : new Array(HOURS).fill(0)), link: consoleUrl(`cloudtasks/queue/${region}/${name}/tasks`, project) };
  });
}

async function sql(project: string, failures: Record<string, string>): Promise<CloudSql[]> {
  const list = await section(failures, "cloud sql", [] as any[], () => gjson(["sql", "instances", "list", `--project=${project}`]));
  if (!list.length) return [];
  const m = (type: string, aligner: string, reducer?: string) =>
    section(failures, "sql metrics", [] as Series[], () =>
      metric(project, `metric.type="cloudsql.googleapis.com/database/${type}"`, aligner, { reducer: reducer ?? "REDUCE_MEAN", groupBy: ["resource.label.database_id"] }),
    );
  const [cpu, mem, disk, conns, slow] = await Promise.all([
    m("cpu/utilization", "ALIGN_MEAN"),
    m("memory/utilization", "ALIGN_MEAN"),
    m("disk/utilization", "ALIGN_MEAN"),
    m("postgresql/num_backends", "ALIGN_MAX", "REDUCE_SUM"),
    // One instance per tenant project; Query Insights is project-wide.
    section(failures, "query insights", undefined as Awaited<ReturnType<typeof slowQueries>> | undefined, () => slowQueries(project)),
  ]);
  return list.map((s: any): CloudSql => {
    const id = `${project}:${s.name}`;
    const pick = (ss: Series[]) => ss.find((x) => x.labels.database_id === id)?.values ?? [];
    return {
      name: s.name,
      state: s.state,
      version: s.databaseVersion,
      tier: s.settings?.tier ?? "",
      cpu: latest(pick(cpu)),
      mem: latest(pick(mem)),
      disk: latest(pick(disk)),
      connections: latest(pick(conns)),
      cpuHourly: filled(pick(cpu).length ? pick(cpu) : new Array(HOURS).fill(0)),
      slow: list.length === 1 ? slow : undefined,
      link: consoleUrl(`sql/instances/${s.name}/overview`, project),
    };
  });
}

/** Firebase Auth health: Identity Toolkit + Secure Token API calls in the Firebase project, by response class. */
async function auth(firebaseProject: string | undefined, failures: Record<string, string>): Promise<CloudAuth | undefined> {
  if (!firebaseProject) return undefined;
  const rows = await section(failures, "firebase auth", null as Series[] | null, () =>
    metric(
      firebaseProject,
      'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.type="consumed_api" AND (resource.label.service="identitytoolkit.googleapis.com" OR resource.label.service="securetoken.googleapis.com")',
      "ALIGN_SUM",
      { reducer: "REDUCE_SUM", groupBy: ["metric.label.response_code_class"] },
    ),
  );
  if (!rows) return undefined;
  const hourly = new Array(HOURS).fill(0);
  const hourlyErr = new Array(HOURS).fill(0);
  let ok = 0;
  let err4xx = 0;
  let err5xx = 0;
  for (const r of rows) {
    const cls = r.labels.response_code_class;
    addInto(hourly, r.values);
    if (cls === "4xx" || cls === "5xx") addInto(hourlyErr, r.values);
    if (cls === "2xx") ok += sum(r.values);
    else if (cls === "4xx") err4xx += sum(r.values);
    else if (cls === "5xx") err5xx += sum(r.values);
  }
  return { firebaseProject, ok, err4xx, err5xx, hourly, hourlyErr, link: `https://console.firebase.google.com/project/${firebaseProject}/authentication/users` };
}

const ago = (ts?: number) => {
  if (!ts) return "never";
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const hoursAgo = (idx: number) => (idx === HOURS - 1 ? "this hour" : `${HOURS - 1 - idx}h ago`);
const secs = (n: number) => (n >= 3600 ? `${(n / 3600).toFixed(1)}h` : n >= 60 ? `${Math.round(n / 60)}m` : `${Math.round(n)}s`);

/** First/last/peak hour of a 24h series, as facts. */
function shape(series: number[], unit: string): string[] {
  const first = series.findIndex((v) => v > 0);
  if (first < 0) return [];
  const last = series.length - 1 - [...series].reverse().findIndex((v) => v > 0);
  const peak = series.indexOf(Math.max(...series));
  return [`first ${hoursAgo(first)}`, `last ${hoursAgo(last)}`, `peak ${series[peak]}${unit} ${hoursAgo(peak)}`];
}

/** What deserves attention, worst first, with enough detail to act on without opening the console. */
function findIssues(t: Omit<TenantCloud, "issues" | "health">): CloudIssue[] {
  const out: CloudIssue[] = [];
  const add = (i: Omit<CloudIssue, "tenant">) => out.push({ tenant: t.tenant, ...i });
  const logGroups = t.errors?.groups ?? [];
  const topLogFor = (service: string) => logGroups.filter((g) => g.service === service).sort((a, b) => b.count - a.count)[0];

  for (const s of t.services) {
    if (!s.ready) add({ severity: "bad", area: "service", text: `${s.name} isn't serving (not ready)`, facts: [`revision ${s.revision ?? "?"}`, `changed ${ago(s.deployedAt)}`], link: s.link });
    if (s.err5xx < 5) continue;
    const rate = s.requests ? s.err5xx / s.requests : 0;
    const now = s.hourly5xx[HOURS - 1];
    const log = topLogFor(s.name);
    add({
      // Bad while it's still happening; a burst that stopped hours ago is a warning.
      severity: now >= 5 || (rate >= 0.02 && s.hourly5xx.slice(-6).some((v) => v > 0)) ? "bad" : "warn",
      area: "service",
      text: `${s.name} returned ${num(s.err5xx)} server errors (5xx) in 24h`,
      facts: [`${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}% of ${s.requests} requests`, ...shape(s.hourly5xx, "/h"), ...(now ? [`${now} this hour`] : [])],
      detail: log ? `×${log.count}  ${log.signature}` : undefined,
      series: s.hourly5xx,
      link: s.link,
    });
  }
  for (const j of t.jobs)
    if (j.status === "failed")
      add({ severity: "warn", area: "job", text: `job ${j.name} failed its last run`, facts: [`ran ${ago(j.lastRun)}`, ...(j.durationS != null ? [`after ${secs(j.durationS)}`] : [])], link: j.link });
  const sched = consoleUrl("cloudscheduler", t.project);
  for (const s of t.schedules)
    if (s.failed)
      add({ severity: "bad", area: "cron", text: `cron ${s.name} failed its last run`, facts: [s.schedule, `attempted ${ago(s.lastAttempt)}`, `code ${s.code}`], detail: s.target, link: sched });
  for (const q of t.queues) {
    if (!q.running) add({ severity: "warn", area: "queue", text: `queue ${q.name} is paused`, facts: [`${num(q.depth)} waiting`], link: q.link });
    else if ((q.depth ?? 0) >= 500) add({ severity: "warn", area: "queue", text: `queue ${q.name} has ${num(q.depth)} tasks waiting`, facts: shape(q.hourly, ""), series: q.hourly, link: q.link });
  }
  for (const d of t.sql) {
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const facts = [`${d.tier}`, `CPU ${pct(d.cpu ?? 0)}`, `memory ${pct(d.mem ?? 0)}`, `disk ${pct(d.disk ?? 0)}`, `${d.connections ?? "?"} connections`];
    if (d.state !== "RUNNABLE") add({ severity: "bad", area: "sql", text: `database ${d.name} is ${d.state.toLowerCase()}`, facts, link: d.link });
    if ((d.cpu ?? 0) >= 0.7)
      add({ severity: (d.cpu ?? 0) >= 0.85 ? "bad" : "warn", area: "sql", text: `database CPU at ${pct(d.cpu!)}`, facts, series: d.cpuHourly.map((v) => Math.round(v * 100)), link: d.link });
    if ((d.disk ?? 0) >= 0.8) add({ severity: (d.disk ?? 0) >= 0.9 ? "bad" : "warn", area: "sql", text: `database disk ${pct(d.disk!)} full`, facts, link: d.link });
    if ((d.mem ?? 0) >= 0.92) add({ severity: "warn", area: "sql", text: `database memory at ${pct(d.mem!)}`, facts, link: d.link });
    const hot = d.slow?.byMean.find((q) => q.calls >= 20 && q.meanMs >= 1000);
    if (hot)
      add({
        severity: hot.meanMs >= 10_000 ? "bad" : "warn",
        area: "sql",
        text: `a database query averages ${(hot.meanMs / 1000).toFixed(1)}s and ran ${num(hot.calls)}× in 24h`,
        facts: [`${secs(hot.totalS)} of DB time`, `${hot.calls} calls`],
        detail: hot.query,
        link: d.link.replace("/overview", "/insights"),
      });
  }
  if (t.auth) {
    const total = t.auth.ok + t.auth.err4xx + t.auth.err5xx;
    const facts = [`${total} calls`, `${t.auth.err4xx} rejected`, `${t.auth.err5xx} server errors`, ...shape(t.auth.hourlyErr, "/h")];
    if (t.auth.err5xx > 0) add({ severity: "bad", area: "auth", text: `Firebase sign-in had ${num(t.auth.err5xx)} server errors`, facts, series: t.auth.hourlyErr, link: t.auth.link });
    else if (total >= 20 && t.auth.err4xx / total >= 0.25)
      add({ severity: "warn", area: "auth", text: `Firebase rejected ${Math.round((t.auth.err4xx / total) * 100)}% of sign-in calls`, facts, series: t.auth.hourlyErr, link: t.auth.link });
  }
  if (t.errors && t.errors.total >= 50) {
    const byService = new Map<string, number>();
    for (const g of logGroups) byService.set(g.service, (byService.get(g.service) ?? 0) + g.count);
    const top = [...byService.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const g = [...logGroups].sort((a, b) => b.count - a.count)[0];
    add({
      severity: "warn",
      area: "logs",
      text: `${num(t.errors.total)} error log entries in 24h`,
      facts: [`${logGroups.length} kinds`, ...top.map(([svc, n]) => `${svc} ${n}`), ...shape(t.errors.hourly, "/h").slice(2)],
      detail: g ? `×${g.count}  ${g.service}: ${g.signature}` : undefined,
      series: t.errors.hourly,
      link: t.links.logs,
    });
  }
  for (const [k, v] of Object.entries(t.failures)) add({ severity: "warn", area: "fetch", text: `couldn't read ${k}`, detail: v });
  return out.sort((a, b) => Number(a.severity === "warn") - Number(b.severity === "warn"));
}

/** Everything for one tenant project, fetched in parallel. Each section fails independently. */
export async function tenantCloud(
  t: { tenant: string; project: string; region?: string; firebaseProject?: string },
  errors?: TenantErrors,
): Promise<TenantCloud> {
  const failures: Record<string, string> = {};
  const [svc, jb, sch, qs, db, au] = await Promise.all([
    services(t.project, failures),
    jobs(t.project, failures),
    schedules(t.project, t.region, failures),
    queues(t.project, t.region, failures),
    sql(t.project, failures),
    auth(t.firebaseProject, failures),
  ]);
  const base = {
    tenant: t.tenant,
    project: t.project,
    region: t.region,
    fetchedAt: Date.now(),
    failures,
    services: svc,
    jobs: jb.sort((a, b) => (b.lastRun ?? 0) - (a.lastRun ?? 0)),
    schedules: sch,
    queues: qs,
    sql: db,
    auth: au,
    errors,
    links: { console: consoleUrl("home/dashboard", t.project), logs: consoleUrl("logs/query", t.project) },
  };
  const issues = findIssues(base);
  const health: Health = issues.some((i) => i.severity === "bad") ? "bad" : issues.length ? "warn" : "ok";
  return { ...base, issues, health };
}

// ── Cloud chat ─────────────────────────────────────────────────

const READ_VERBS = new Set(["list", "describe", "read", "get-iam-policy", "tail"]);
const WRITE_WORDS = /\b(delete|update|create|deploy|set|add|remove|patch|run|execute|cancel|pause|resume|enable|disable|import|export|restart|promote|failover|reset|login|revoke|activate|ssh|scp|connect)\b/;

/**
 * A single read-only gcloud command: `gcloud … list|describe|read …` with no shell chaining, redirection or
 * substitution outside quotes, and no mutating verb. Everything else asks you first.
 */
export function isReadOnlyGcloud(command: string): boolean {
  const cmd = command.trim();
  if (!/^gcloud\s/.test(cmd)) return false;
  const bare = cmd.replace(/'[^']*'|"[^"\\]*(?:\\.[^"\\]*)*"/g, "''");
  if (/[;&|`<>\n]|\$\(/.test(bare)) return false;
  // "gcloud run …" is the Cloud Run command group, not a verb.
  const words = bare
    .split(/\s+/)
    .filter((w) => !w.startsWith("-") && w !== "''")
    .filter((w, i) => !(i === 1 && w === "run"));
  if (words.some((w) => WRITE_WORDS.test(w) && !READ_VERBS.has(w))) return false;
  return words.some((w) => READ_VERBS.has(w));
}

const n = (v?: number) => (v == null ? "?" : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
const pc = (v?: number) => (v == null ? "?" : `${Math.round(v * 100)}%`);
const msf = (v?: number) => (v == null ? "?" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

function issueLines(issues: CloudIssue[]): string[] {
  return issues.map(
    (i) => `${i.ref ?? "-"} [${i.severity}] ${i.tenant} ${i.area}: ${i.text}${i.facts?.length ? ` (${i.facts.join("; ")})` : ""}${i.detail ? `\n    ${i.detail.slice(0, 300)}` : ""}`,
  );
}

function tenantSummary(t: TenantCloud): string {
  const req = t.services.reduce((a, s) => a + s.requests, 0);
  const e5 = t.services.reduce((a, s) => a + s.err5xx, 0);
  const db = t.sql[0];
  return `${t.tenant} = GCP project ${t.project} (${t.region ?? "?"}), Firebase ${t.auth?.firebaseProject ?? "?"}: health ${t.health}; ${n(req)} requests, ${e5} 5xx, ${n(t.errors?.total)} error logs in 24h; DB CPU ${pc(db?.cpu)} disk ${pc(db?.disk)}`;
}

function tenantDetail(t: TenantCloud): string {
  const out: string[] = [tenantSummary(t), "", "Cloud Run services (24h): name | ready | requests | 5xx | 4xx | p95 | instances | deployed"];
  for (const s of t.services) out.push(`  ${s.name} | ${s.ready ? "ready" : "NOT READY"} | ${s.requests} | ${s.err5xx} | ${s.err4xx} | ${msf(s.p95)} | ${s.instances ?? "?"} | ${ago(s.deployedAt)} (${s.revision ?? "?"})`);
  for (const d of t.sql) {
    out.push("", `Cloud SQL ${d.name} ${d.version} ${d.tier}: ${d.state}, CPU ${pc(d.cpu)}, memory ${pc(d.mem)}, disk ${pc(d.disk)}, ${d.connections ?? "?"} connections`);
    if (d.slow) {
      out.push("  Heaviest queries by total time (avg | calls | total):");
      for (const q of d.slow.byTotal.slice(0, 5)) out.push(`    ${msf(q.meanMs)} | ${q.calls} | ${secs(q.totalS)} | ${q.query.slice(0, 240)}`);
      out.push("  Slowest per call:");
      for (const q of d.slow.byMean.slice(0, 5)) out.push(`    ${msf(q.meanMs)} | ${q.calls} | ${secs(q.totalS)} | ${q.query.slice(0, 240)}`);
    }
  }
  if (t.auth) out.push("", `Firebase auth (${t.auth.firebaseProject}) 24h: ${t.auth.ok} ok, ${t.auth.err4xx} rejected, ${t.auth.err5xx} server errors`);
  out.push("", "Crons: name | schedule | last attempt | result");
  for (const s of t.schedules) out.push(`  ${s.name} | ${s.schedule} | ${s.paused ? "paused" : ago(s.lastAttempt)} | ${s.failed ? `FAILED code ${s.code}` : s.paused ? "-" : "ok"}${s.target ? ` | ${s.target}` : ""}`);
  out.push("", "Cloud Run jobs: name | last run | result");
  for (const j of t.jobs) out.push(`  ${j.name} | ${ago(j.lastRun)} | ${j.status}`);
  out.push("", "Task queues: name | state | waiting");
  for (const q of t.queues) out.push(`  ${q.name} | ${q.running ? "running" : "paused"} | ${q.depth ?? 0}`);
  if (t.errors?.groups.length) {
    out.push("", `Top error log groups (${t.errors.total} entries in 24h):`);
    for (const g of t.errors.groups.slice(0, 8)) out.push(`  ×${g.count} ${g.service}: ${g.signature}`);
  }
  return out.join("\n");
}

/** The board the user is looking at, as text for the Cloud chat. */
export function boardContext(snap: CloudSnapshot | undefined, board: string): string {
  if (!snap || !snap.tenants.length) return "<board>No cloud data loaded yet.</board>";
  const head = `Board: ${board === "all" ? "all tenants" : board} · data from ${ago(snap.fetchedAt)}${snap.authOk ? "" : " · gcloud login expired, data may be stale"}`;
  const t = snap.tenants.find((x) => x.tenant === board);
  const issues = t ? t.issues : snap.tenants.flatMap((x) => x.issues);
  const body = t
    ? tenantDetail(t)
    : snap.tenants.map(tenantSummary).join("\n");
  return `<board>\n${head}\n\nNeeds attention:\n${issueLines(issues).join("\n") || "  nothing"}\n\n${body}\n</board>`;
}
