import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexModelInfo, LimitWindow } from "../shared/types.js";

const CODEX_SESSIONS = join(homedir(), ".codex", "sessions");
const TAIL_BYTES = 256 * 1024;

/** Newest rollout files under ~/.codex/sessions/YYYY/MM/DD/*.jsonl, newest first. */
async function newestRollouts(limit: number): Promise<string[]> {
  const out: Array<{ path: string; mtime: number }> = [];
  const desc = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse();
  for (const y of await desc(CODEX_SESSIONS)) {
    for (const m of await desc(join(CODEX_SESSIONS, y))) {
      for (const d of await desc(join(CODEX_SESSIONS, y, m))) {
        const dir = join(CODEX_SESSIONS, y, m, d);
        for (const f of await desc(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          const p = join(dir, f);
          out.push({ path: p, mtime: (await stat(p)).mtimeMs });
        }
        if (out.length >= limit * 3) break;
      }
      if (out.length >= limit * 3) break;
    }
    if (out.length >= limit * 3) break;
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((x) => x.path);
}

async function tail(path: string): Promise<string> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

function findKey(obj: unknown, key: string): any {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in (obj as any)) return (obj as any)[key];
  for (const v of Object.values(obj as any)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const windowLabel = (minutes?: number) =>
  !minutes ? "window" : minutes <= 300 ? `${Math.round(minutes / 60)}h` : minutes >= 10080 ? "week" : `${Math.round(minutes / 1440)}d`;

/** Latest Codex plan limits, from the rate_limits snapshot Codex writes into its session logs. */
export async function readCodexLimits(): Promise<{ windows: LimitWindow[]; plan?: string; at: number } | null> {
  for (const file of await newestRollouts(5)) {
    const lines = (await tail(file).catch(() => "")).split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const rl = findKey(JSON.parse(line), "rate_limits");
        if (!rl) continue;
        const ts = findKey(JSON.parse(line), "timestamp");
        const windows: LimitWindow[] = [];
        for (const w of [rl.primary, rl.secondary]) {
          if (!w || typeof w.used_percent !== "number") continue;
          windows.push({
            label: windowLabel(w.window_minutes),
            usedPct: w.used_percent,
            resetsAt: typeof w.resets_at === "number" ? w.resets_at * 1000 : undefined,
          });
        }
        if (windows.length) {
          return { windows, plan: rl.plan_type ?? undefined, at: ts ? Date.parse(ts) || (await stat(file)).mtimeMs : (await stat(file)).mtimeMs };
        }
      } catch {
        /* partial line at the tail cut */
      }
    }
  }
  return null;
}

/** Claude rate_limit_event → a window. utilization may be a 0–1 fraction or a percentage. */
export function claudeWindow(info: { rateLimitType?: string; utilization?: number; resetsAt?: number; status?: string }): LimitWindow | null {
  if (!info.rateLimitType) return null;
  const label =
    { five_hour: "5h", seven_day: "week", seven_day_opus: "week opus", seven_day_sonnet: "week sonnet" }[info.rateLimitType] ?? info.rateLimitType;
  const u = info.utilization;
  const usedPct = u == null ? null : u <= 1 ? u * 100 : u;
  return {
    label,
    usedPct,
    resetsAt: info.resetsAt ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : undefined,
    status: info.status,
  };
}

/** Codex's own model list (~/.codex/models_cache.json) and the defaults from ~/.codex/config.toml. */
export async function readCodexModels(): Promise<CodexModelInfo> {
  const info: CodexModelInfo = { models: [] };
  try {
    const cache = JSON.parse(await readFile(join(homedir(), ".codex", "models_cache.json"), "utf8"));
    for (const m of cache.models ?? []) {
      if (m.visibility === "hide") continue;
      info.models.push({
        slug: m.slug,
        name: m.display_name ?? m.slug,
        description: m.description,
        efforts: (m.supported_reasoning_levels ?? []).map((r: any) => r.effort),
        defaultEffort: m.default_reasoning_level,
      });
    }
  } catch {}
  try {
    const toml = await readFile(join(homedir(), ".codex", "config.toml"), "utf8");
    // Top-level keys only (before the first [table]).
    const top = toml.split(/^\s*\[/m)[0];
    info.defaultModel = top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
    info.defaultEffort = top.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
  } catch {}
  return info;
}

/** Models Cursor's CLI offers (`agent --list-models`): "slug - Name" lines. */
export async function readCursorModels(): Promise<Array<{ id: string; name: string }>> {
  const { execFile } = await import("node:child_process");
  const { cursorBinary } = await import("./cursorSession.js");
  return new Promise((resolve) => {
    execFile(cursorBinary(), ["--list-models"], { timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve([]);
      const out: Array<{ id: string; name: string }> = [];
      for (const line of String(stdout).split("\n")) {
        const m = line.match(/^([a-z0-9][\w.\-\[\]=,]*) - (.+)$/i);
        if (m) out.push({ id: m[1], name: m[2].trim() });
      }
      resolve(out);
    });
  });
}

/** Cursor plan tier from `agent about` (e.g. "Pro+"). */
export async function readCursorTier(): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
  const { cursorBinary } = await import("./cursorSession.js");
  return new Promise((resolve) => {
    execFile(cursorBinary(), ["about"], { timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      resolve(String(stdout).match(/Subscription Tier\s+(.+)/)?.[1]?.trim());
    });
  });
}
