import { safeStorage } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalyticsEventDetail, AnalyticsQuery, AnalyticsSnapshot, AnalyticsStatus, ProjectConfig } from "../shared/types.js";
import { envForTag } from "./projectConfig.js";

/** PostHog's own bookkeeping events: left out of the feed and the top list. */
const NOISE = ["$web_vitals", "$pageleave", "$set", "$identify", "$feature_flag_called", "$groupidentify", "$opt_in", "survey shown"];
const RANGE_SQL: Record<AnalyticsQuery["range"], string> = { "1h": "1 HOUR", "24h": "24 HOUR", "7d": "7 DAY", "30d": "30 DAY" };
export const POSTHOG_HOSTS = ["https://us.posthog.com", "https://eu.posthog.com"];

interface Creds {
  key: string;
  host: string;
  projectId?: number;
}

const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const clean = (h: string) => h.trim().replace(/\/$/, "") || POSTHOG_HOSTS[0];

/** Which Happy environment a site belongs to: its first subdomain is the environment's tag (berenson.acme.com → "berenson"), the bare domain is the one with no tag. */
function envForHost(cfg: ProjectConfig, host: string) {
  if (!host || !/\.[a-z]{2,}$/i.test(host)) return undefined; // localhost, IPs
  const labels = host.toLowerCase().split(".");
  const sub = labels.length > 2 && labels[0] !== "www" ? labels[0] : "";
  return envForTag(cfg, sub);
}

/**
 * PostHog, read-only: a personal API key (Settings, encrypted with the OS keychain; or POSTHOG_PERSONAL_API_KEY),
 * queried with HogQL. Tabs are your environments, matched from each event's site address.
 */
export class PostHog {
  private creds?: Creds;
  private projects?: Array<{ id: number; name: string }>;
  private file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "posthog-key.bin");
    const env = process.env.POSTHOG_PERSONAL_API_KEY;
    if (env) this.creds = { key: env, host: clean(process.env.POSTHOG_HOST ?? ""), projectId: Number(process.env.POSTHOG_PROJECT_ID) || undefined };
    else
      try {
        if (existsSync(this.file) && safeStorage.isEncryptionAvailable()) this.creds = JSON.parse(safeStorage.decryptString(readFileSync(this.file)));
      } catch {
        this.creds = undefined;
      }
  }

  private async api<T>(path: string, init: RequestInit = {}, c = this.creds): Promise<T> {
    if (!c) throw new Error("PostHog isn't connected");
    const r = await fetch(`${c.host}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 401 || r.status === 403) throw new Error("PostHog rejected the API key");
    if (!r.ok) throw new Error(`PostHog ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as T;
  }

  private async listProjects(c = this.creds) {
    const d = await this.api<{ results: Array<{ id: number; name: string }> }>("/api/projects/", {}, c);
    return d.results.map((p) => ({ id: p.id, name: p.name }));
  }

  async status(): Promise<AnalyticsStatus> {
    if (!this.creds) return { connected: false };
    try {
      this.projects ??= await this.listProjects();
      return { connected: true, host: this.creds.host, projects: this.projects, projectId: this.projectId(), fromEnv: !!process.env.POSTHOG_PERSONAL_API_KEY };
    } catch (e) {
      return { connected: false, error: (e as Error).message };
    }
  }

  private projectId() {
    const id = this.creds?.projectId;
    return this.projects?.some((p) => p.id === id) ? id! : this.projects?.[0]?.id;
  }

  private save() {
    if (process.env.POSTHOG_PERSONAL_API_KEY) return;
    if (!safeStorage.isEncryptionAvailable()) throw new Error("The OS keychain isn't available to encrypt the key");
    writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.creds)), { mode: 0o600 });
  }

  /** Check the key against PostHog, then store it (encrypted). */
  async connect(key: string, host: string): Promise<AnalyticsStatus> {
    const c: Creds = { key: key.trim(), host: clean(host) };
    this.projects = await this.listProjects(c);
    if (!this.projects.length) throw new Error("That key can't see any PostHog projects (it needs project read access).");
    this.creds = c;
    this.save();
    return this.status();
  }

  disconnect() {
    this.creds = undefined;
    this.projects = undefined;
    rmSync(this.file, { force: true });
  }

  setProject(id: number) {
    if (!this.creds) return;
    this.creds.projectId = id;
    this.save();
  }

  private async hogql(query: string): Promise<unknown[][]> {
    if (!this.projects) await this.status();
    const d = await this.api<{ results?: unknown[][] }>(`/api/projects/${this.projectId()}/query/`, { method: "POST", body: JSON.stringify({ query: { kind: "HogQLQuery", query } }) });
    return d.results ?? [];
  }

  /** Events for the Analytics page: per environment, people, top events, and a feed. */
  async snapshot(cfg: ProjectConfig, opts: AnalyticsQuery): Promise<AnalyticsSnapshot> {
    const empty = { fetchedAt: Date.now(), envs: [], people: [], top: [], feed: [] };
    if (!this.creds) return { connected: false, ...empty };
    const link = `${this.creds.host}/project/${this.projectId() ?? ""}`;
    try {
      const where = [`timestamp > now() - INTERVAL ${RANGE_SQL[opts.range]}`, "person.properties.email IS NOT NULL AND person.properties.email != ''"];
      // Sites seen in this range, each matched to an environment (with none configured, each site is its own tab).
      const sites = (await this.hogql(`SELECT properties.$host h, uniq(person_id), count() c FROM events WHERE ${where.join(" AND ")} GROUP BY h ORDER BY c DESC LIMIT 50`)) as [string, number, number][];
      const configured = !!cfg.environments?.length;
      const envOf = (host: string) => (configured ? envForHost(cfg, host)?.id : host && /\.[a-z]{2,}$/i.test(host) ? host : undefined);
      const hosts = sites.map(([h]) => h).filter((h) => envOf(h));
      const inEnv = opts.env ? hosts.filter((h) => envOf(h) === opts.env) : hosts;
      where.push(inEnv.length ? `properties.$host IN (${inEnv.map(q).join(",")})` : "1 = 0");
      // The people list ignores the people picked (so you can pick more); everything else follows them.
      const everyone = where.join(" AND ");
      if (opts.people?.length) where.push(`person.properties.email IN (${opts.people.map(q).join(",")})`);
      const base = where.join(" AND ");
      const quiet = `event NOT IN (${NOISE.map(q).join(",")})`;
      const [people, top, feed] = await Promise.all([
        this.hogql(`SELECT person.properties.email e, any(properties.$host), count(), max(timestamp) m FROM events WHERE ${everyone} GROUP BY e ORDER BY m DESC LIMIT 300`),
        this.hogql(`SELECT event, count() c, uniq(person_id) FROM events WHERE ${base} AND ${quiet} GROUP BY event ORDER BY c DESC LIMIT 40`),
        this.hogql(`SELECT timestamp, event, person.properties.email, properties.$host, properties.$pathname, properties.$event_type, elements_chain_texts, uuid FROM events WHERE ${base} AND ${quiet} ORDER BY timestamp DESC LIMIT 300`),
      ]);
      const perEnv = new Map<string, { users: number; events: number }>();
      for (const [h, u, c] of sites) {
        const id = envOf(h);
        if (!id) continue;
        const e = perEnv.get(id) ?? { users: 0, events: 0 };
        e.users += u;
        e.events += c;
        perEnv.set(id, e);
      }
      const envs = configured
        ? (cfg.environments ?? []).filter((e) => perEnv.has(e.id)).map((e) => ({ id: e.id, name: e.name ?? e.id, color: e.color, ...perEnv.get(e.id)! }))
        : [...perEnv].map(([id, v]) => ({ id, name: id, ...v }));
      return {
        connected: true,
        fetchedAt: Date.now(),
        link,
        envs,
        people: (people as [string, string, number, string][]).map(([email, host, events, last]) => ({ email, env: envOf(host), events, lastSeen: Date.parse(last) })),
        top: (top as [string, number, number][]).map(([event, count, users]) => ({ event, count, users })),
        feed: (feed as [string, string, string | null, string, string | null, string | null, string[] | null, string][]).map(([ts, event, email, host, path, type, texts, id]) => ({
          id,
          ts: Date.parse(ts),
          event,
          email: email || undefined,
          env: envOf(host),
          path: path || undefined,
          action: event === "$autocapture" ? [type ?? "click", texts?.find((t) => t.trim())].filter(Boolean).join(" ") : undefined,
        })),
      };
    } catch (e) {
      return { connected: true, error: (e as Error).message, link, ...empty };
    }
  }

  /** One event's full record, for the details panel. */
  async event(id: string, ts: number): Promise<AnalyticsEventDetail> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Bad event id.");
    // The timestamp window lets ClickHouse skip straight to the right partition.
    const at = (d: number) => q(new Date(d).toISOString().replace("T", " ").replace("Z", ""));
    const [row] = await this.hogql(
      `SELECT properties, person.properties, elements_chain, distinct_id FROM events WHERE uuid = ${q(id)} AND timestamp >= toDateTime64(${at(ts - 60_000)}, 6, 'UTC') AND timestamp <= toDateTime64(${at(ts + 60_000)}, 6, 'UTC') LIMIT 1`,
    );
    if (!row) throw new Error("Event not found.");
    const parse = (x: unknown) => (typeof x === "string" ? (JSON.parse(x) as Record<string, unknown>) : ((x as Record<string, unknown>) ?? {}));
    return {
      properties: parse(row[0]),
      person: parse(row[1]),
      elements: (row[2] as string) || undefined,
      distinctId: row[3] as string,
      link: `${this.creds!.host}/project/${this.projectId()}/events/${id}/${encodeURIComponent(new Date(ts).toISOString())}`,
    };
  }
}
