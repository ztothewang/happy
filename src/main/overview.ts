import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { projectConfig } from "./projectConfig.js";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ErrorGroup, GcpErrorGroup, TenantErrors } from "../shared/types.js";

const run = promisify(execFile);

/**
 * Cloud projects per environment, from the project config: an environment's cloudProject / region / firebaseProject,
 * else PROJECT_ID / REGION / FIREBASE_PROJECT_ID read from its envFile (only those lines). Only when the config turns
 * on a cloud provider.
 */
export function tenantProjects(repo: string): Array<{ tenant: string; project: string; region?: string; firebaseProject?: string }> {
  const cfg = projectConfig(repo);
  if (cfg.cloud?.provider !== "gcp") return [];
  const out: Array<{ tenant: string; project: string; region?: string; firebaseProject?: string }> = [];
  for (const e of cfg.environments ?? []) {
    let lines: string[] = [];
    try {
      if (e.envFile) lines = readFileSync(join(repo, e.envFile), "utf8").split("\n");
    } catch {}
    const get = (key: string) =>
      lines
        .find((l) => new RegExp(`^(export\\s+)?${key}=`).test(l))
        ?.split("=")[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, "") || undefined;
    const project = e.cloudProject ?? get("PROJECT_ID");
    if (!project || out.some((x) => x.project === project)) continue;
    out.push({ tenant: e.id, project, region: e.region ?? get("REGION"), firebaseProject: e.firebaseProject ?? get("FIREBASE_PROJECT_ID") });
  }
  return out;
}

/** Collapse an error message to a signature: drop timestamps, ids, numbers, quoted values. */
function signature(msg: string): string {
  return msg
    .replace(/\d{4}-\d{2}-\d{2}[ T][\d:.]+( ?UTC|Z)?/g, "")
    .replace(/\[\d+\](: \[[\d-]+\])?/g, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/"[^"]{0,120}"|'[^']{0,120}'/g, "<v>")
    .replace(/\b\d+(\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Last-24h ERROR+ log entries for one project, grouped by service + message signature. */
export async function projectErrors(tenant: string, project: string): Promise<TenantErrors> {
  try {
    const { stdout } = await run(
      "gcloud",
      ["logging", "read", "severity>=ERROR", `--project=${project}`, "--freshness=24h", "--limit=1000", "--format=json"],
      { timeout: 90_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const rows = JSON.parse(stdout || "[]") as any[];
    const groups = new Map<string, GcpErrorGroup>();
    const hourly = new Array(24).fill(0);
    const nowHour = Math.floor(Date.now() / 3600_000);
    for (const r of rows) {
      const labels = r.resource?.labels ?? {};
      const service = labels.service_name || labels.job_name || labels.database_id?.split(":").pop() || r.resource?.type || "unknown";
      const hr = r.httpRequest;
      const fallback = hr
        ? `${hr.requestMethod ?? ""} ${String(hr.requestUrl ?? "").replace(/^https?:\/\/[^/]+/, "").split("?")[0]} → ${hr.status ?? "?"}`.trim()
        : `(no message) ${decodeURIComponent(String(r.logName ?? "").split("/logs/").pop() ?? "")}`;
      const raw: string =
        r.textPayload ||
        r.jsonPayload?.message ||
        r.jsonPayload?.error ||
        r.jsonPayload?.msg ||
        r.protoPayload?.status?.message ||
        (r.jsonPayload && Object.keys(r.jsonPayload).length ? JSON.stringify(r.jsonPayload).slice(0, 300) : "");
      const msg = raw && raw.trim() !== "{}" ? raw : fallback;
      const sig = signature(msg);
      const key = `${service}|${sig}`;
      const t = Date.parse(r.timestamp) || 0;
      const idx = 23 - (nowHour - Math.floor(t / 3600_000));
      if (idx >= 0 && idx < 24) hourly[idx]++;
      const g = groups.get(key);
      if (g) {
        g.count++;
        if (t > g.lastSeen) {
          g.lastSeen = t;
          g.sample = msg.slice(0, 600);
        }
      } else groups.set(key, { service, signature: sig, sample: msg.slice(0, 600), count: 1, lastSeen: t });
    }
    return {
      tenant,
      project,
      total: rows.length,
      groups: [...groups.values()].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen).slice(0, 40),
      hourly,
    };
  } catch (e) {
    return { tenant, project, total: 0, groups: [], hourly: new Array(24).fill(0), error: String((e as any).stderr || (e as Error).message).split("\n")[0].slice(0, 200) };
  }
}

/** Merge per-tenant groups into cross-tenant groups (same service + signature), biggest first. */
export function crossTenantGroups(tenants: TenantErrors[]): ErrorGroup[] {
  const map = new Map<string, ErrorGroup>();
  for (const t of tenants) {
    for (const g of t.groups) {
      const key = `${g.service}|${g.signature}`;
      const e = map.get(key) ?? { key, service: g.service, signature: g.signature, sample: g.sample, total: 0, byTenant: {}, lastSeen: 0 };
      e.total += g.count;
      e.byTenant[t.tenant] = (e.byTenant[t.tenant] ?? 0) + g.count;
      if (g.lastSeen > e.lastSeen) {
        e.lastSeen = g.lastSeen;
        e.sample = g.sample;
      }
      map.set(key, e);
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total).slice(0, 20);
}

export async function lastCommitSubject(path: string): Promise<string | undefined> {
  try {
    return (await run("git", ["log", "-1", "--format=%s"], { cwd: path, timeout: 5000 })).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** First-parent commits that landed on the main branch in the last 24h. */
export async function landedOnMain(repo: string, mainRef: string): Promise<Array<{ sha: string; subject: string; author: string; time: number }>> {
  try {
    const { stdout } = await run("git", ["log", mainRef, "--first-parent", "--since=24.hours", "--format=%h%x09%an%x09%ct%x09%s"], {
      cwd: repo,
      timeout: 15_000,
    });
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, author, ct, ...subj] = l.split("\t");
        return { sha, author, time: Number(ct) * 1000, subject: subj.join("\t") };
      });
  } catch {
    return [];
  }
}
