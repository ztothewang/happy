import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { AnalyticsQuery, AnalyticsSnapshot, ProjectConfig } from "../shared/types.js";

const run = promisify(execFile);

/** PostHog's own bookkeeping events: left out of the feed and the top list. */
const NOISE = ["$web_vitals", "$pageleave", "$set", "$identify", "$feature_flag_called", "$groupidentify", "$opt_in", "survey shown"];
const RANGE_SQL: Record<AnalyticsQuery["range"], string> = { "1h": "1 HOUR", "24h": "24 HOUR", "7d": "7 DAY", "30d": "30 DAY" };

let cachedKey: { src: string; key: string } | undefined;

/** The personal API key (read-only use): a local file, else a Secret Manager secret via gcloud. */
async function apiKey(cfg: NonNullable<ProjectConfig["analytics"]>): Promise<string> {
  const src = cfg.keyFile ?? (cfg.keySecret ? `${cfg.keySecret.project}/${cfg.keySecret.name}` : "");
  if (cachedKey?.src === src) return cachedKey.key;
  let key = process.env.POSTHOG_PERSONAL_API_KEY ?? "";
  const file = cfg.keyFile?.replace(/^~(?=\/)/, homedir());
  if (!key && file && existsSync(file)) key = readFileSync(file, "utf8").trim();
  if (!key && cfg.keySecret) {
    const { stdout } = await run("gcloud", ["secrets", "versions", "access", "latest", `--secret=${cfg.keySecret.name}`, `--project=${cfg.keySecret.project}`, "--quiet"], { timeout: 20_000 });
    key = stdout.trim();
  }
  if (!key) throw new Error("No PostHog personal API key (set analytics.keyFile or analytics.keySecret in the project config).");
  cachedKey = { src, key };
  return key;
}

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function hogql(cfg: NonNullable<ProjectConfig["analytics"]>, query: string): Promise<unknown[][]> {
  const host = (cfg.host ?? "https://us.posthog.com").replace(/\/$/, "");
  const r = await fetch(`${host}/api/projects/${cfg.projectId}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await apiKey(cfg)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`PostHog ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return ((await r.json()) as { results?: unknown[][] }).results ?? [];
}

/** Events for the Analytics page: per environment, people, top events, and a feed. Read-only HogQL. */
export async function analytics(cfg: ProjectConfig, opts: AnalyticsQuery): Promise<AnalyticsSnapshot> {
  const a = cfg.analytics;
  if (!a) return { configured: false, fetchedAt: Date.now(), envs: [], people: [], top: [], feed: [] };
  const hosts = a.hosts ?? {};
  const envOf = (host: string) => hosts[host];
  const envs = cfg.environments ?? [];
  const allHosts = Object.keys(hosts);
  const where = [`timestamp > now() - INTERVAL ${RANGE_SQL[opts.range]}`];
  const envHosts = opts.env ? allHosts.filter((h) => hosts[h] === opts.env) : allHosts;
  if (envHosts.length) where.push(`properties.$host IN (${envHosts.map(q).join(",")})`);
  if (opts.signedIn) where.push("person.properties.email IS NOT NULL AND person.properties.email != ''");
  if (opts.hideInternal) for (const s of a.internal ?? []) where.push(`NOT (coalesce(person.properties.email, '') ILIKE ${q(`%${s}`)})`);
  if (opts.person) where.push(`person.properties.email = ${q(opts.person)}`);
  const base = where.join(" AND ");
  const quiet = `event NOT IN (${NOISE.map(q).join(",")})`;
  const link = `${(a.host ?? "https://us.posthog.com").replace(/\/$/, "")}/project/${a.projectId}`;
  try {
    const [byHost, people, top, feed] = await Promise.all([
      hogql(a, `SELECT properties.$host h, uniq(person_id), count() FROM events WHERE ${base} GROUP BY h`),
      hogql(a, `SELECT person.properties.email e, any(properties.$host), count(), max(timestamp) m FROM events WHERE ${base} AND e IS NOT NULL AND e != '' GROUP BY e ORDER BY m DESC LIMIT 300`),
      hogql(a, `SELECT event, count() c, uniq(person_id) FROM events WHERE ${base} AND ${quiet} GROUP BY event ORDER BY c DESC LIMIT 40`),
      hogql(a, `SELECT timestamp, event, person.properties.email, properties.$host, properties.$pathname, properties.$event_type, elements_chain_texts FROM events WHERE ${base} AND ${quiet} ORDER BY timestamp DESC LIMIT 300`),
    ]);
    const perEnv = new Map<string, { users: number; events: number }>();
    for (const [h, u, c] of byHost as [string, number, number][]) {
      const id = envOf(h);
      if (!id) continue;
      const e = perEnv.get(id) ?? { users: 0, events: 0 };
      e.users += u;
      e.events += c;
      perEnv.set(id, e);
    }
    return {
      configured: true,
      fetchedAt: Date.now(),
      link,
      envs: envs.filter((e) => allHosts.some((h) => hosts[h] === e.id)).map((e) => ({ id: e.id, name: e.name ?? e.id, color: e.color, ...(perEnv.get(e.id) ?? { users: 0, events: 0 }) })),
      people: (people as [string, string, number, string][]).map(([email, host, events, last]) => ({ email, env: envOf(host), events, lastSeen: Date.parse(last) })),
      top: (top as [string, number, number][]).map(([event, count, users]) => ({ event, count, users })),
      feed: (feed as [string, string, string | null, string, string | null, string | null, string[] | null][]).map(([ts, event, email, host, path, type, texts]) => ({
        ts: Date.parse(ts),
        event,
        email: email || undefined,
        env: envOf(host),
        path: path || undefined,
        action: event === "$autocapture" ? [type ?? "click", texts?.find((t) => t.trim())].filter(Boolean).join(" ") : undefined,
      })),
    };
  } catch (e) {
    return { configured: true, error: (e as Error).message, fetchedAt: Date.now(), link, envs: [], people: [], top: [], feed: [] };
  }
}
