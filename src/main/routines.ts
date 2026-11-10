import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Routine } from "../shared/types.js";

/** Cron fields → sets of allowed values (supports *, lists, ranges and steps). */
function field(src: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const [range, stepS] = part.split("/");
    const step = Number(stepS) || 1;
    const [a, b] = range === "*" ? [min, max] : range.includes("-") ? range.split("-").map(Number) : [Number(range), stepS ? max : Number(range)];
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** Next local time a 5-field cron fires (searches up to 8 days ahead). */
export function nextCron(expr: string, from = Date.now()): number | undefined {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return undefined;
  const [mi, ho, dom, mo, dow] = [field(f[0], 0, 59), field(f[1], 0, 23), field(f[2], 1, 31), field(f[3], 1, 12), field(f[4].replace(/7/g, "0"), 0, 6)];
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 8 * 24 * 60; i++, d.setMinutes(d.getMinutes() + 1)) {
    const domOk = dom.has(d.getDate()), dowOk = dow.has(d.getDay());
    const dayOk = f[2] === "*" || f[4] === "*" ? domOk && dowOk : domOk || dowOk;
    if (mi.has(d.getMinutes()) && ho.has(d.getHours()) && mo.has(d.getMonth() + 1) && dayOk) return d.getTime();
  }
  return undefined;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RR_DAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Simple RRULEs (Codex automations) as cron: HOURLY / DAILY / WEEKLY with BYHOUR, BYMINUTE, BYDAY. */
function rruleToCron(rrule: string): string | undefined {
  const p = Object.fromEntries(rrule.replace(/^RRULE:/, "").split(";").map((kv) => kv.split("=")));
  const m = p.BYMINUTE ?? "0";
  const h = p.BYHOUR ?? "0";
  if (p.FREQ === "HOURLY") return `${m} * * * *`;
  if (p.FREQ === "DAILY") return `${m} ${h} * * ${p.BYDAY ? p.BYDAY.split(",").map((d: string) => RR_DAYS[d]).join(",") : "*"}`;
  if (p.FREQ === "WEEKLY") return `${m} ${h} * * ${(p.BYDAY ?? "MO").split(",").map((d: string) => RR_DAYS[d]).join(",")}`;
  return undefined;
}

/** "daily 9:17 AM", "Mon 9:00 AM", "hourly at :30", else the raw cron. */
function describe(cron: string): string {
  const [m, h, dom, mo, dow] = cron.split(/\s+/);
  if (!/^\d+$/.test(m) || dom !== "*" || mo !== "*") return cron;
  if (h === "*") return `hourly at :${m.padStart(2, "0")}`;
  if (!/^\d+$/.test(h)) return cron;
  const t = new Date(2000, 0, 1, Number(h), Number(m)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (dow === "*") return `daily ${t}`;
  if (dow === "1-5") return `weekdays ${t}`;
  return `${dow.split(",").map((d) => DAYS[Number(d) % 7] ?? d).join(", ")} ${t}`;
}

function claudeRoutines(): Routine[] {
  const base = join(homedir(), "Library/Application Support/Claude/claude-code-sessions");
  const out: Routine[] = [];
  if (!existsSync(base)) return out;
  for (const a of readdirSync(base))
    for (const b of existsSync(join(base, a)) ? readdirSync(join(base, a)) : []) {
      const file = join(base, a, b, "scheduled-tasks.json");
      if (!existsSync(file)) continue;
      try {
        for (const t of JSON.parse(readFileSync(file, "utf8")).scheduledTasks ?? []) {
          if (out.some((r) => r.id === `claude:${t.id}`)) continue;
          let name = t.id as string;
          let description: string | undefined;
          try {
            const md = readFileSync(t.filePath, "utf8");
            name = md.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? name;
            description = md.match(/^description:\s*(.+)$/m)?.[1]?.trim();
          } catch {}
          out.push({
            id: `claude:${t.id}`,
            engine: "claude",
            name,
            description,
            schedule: t.cronExpression ? describe(t.cronExpression) : "manual",
            enabled: t.enabled !== false,
            nextRun: t.enabled !== false && t.cronExpression ? nextCron(t.cronExpression) : undefined,
            lastRun: t.lastRunAt ? Date.parse(t.lastRunAt) : undefined,
            cwd: t.cwd,
            file: t.filePath,
          });
        }
      } catch {}
    }
  return out;
}

function codexRoutines(): Routine[] {
  const base = join(homedir(), ".codex/automations");
  if (!existsSync(base)) return [];
  const out: Routine[] = [];
  for (const id of readdirSync(base)) {
    const file = join(base, id, "automation.toml");
    if (!existsSync(file)) continue;
    const toml = readFileSync(file, "utf8");
    const get = (k: string) => toml.match(new RegExp(`^${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"))?.[1];
    const rrule = get("rrule");
    const cron = rrule ? rruleToCron(rrule) : undefined;
    const enabled = (get("status") ?? "ACTIVE").toUpperCase() === "ACTIVE";
    // Each run appends a dated entry to memory.md: the newest one is the last run and its result.
    let lastRun: number | undefined;
    let lastResult: string | undefined;
    try {
      const mem = readFileSync(join(base, id, "memory.md"), "utf8");
      const runs = [...mem.matchAll(/^(\d{4}-\d\d-\d\dT[\d:]+Z)\n([\s\S]*?)(?=^\d{4}-\d\d-\d\dT|$(?![\s\S]))/gm)];
      const last = runs.at(-1);
      if (last) {
        lastRun = Date.parse(last[1]);
        lastResult = last[2].trim().slice(0, 600);
      }
    } catch {}
    out.push({
      id: `codex:${id}`,
      engine: "codex",
      name: get("name") ?? id,
      description: get("prompt")?.replace(/\\"/g, '"').slice(0, 300),
      schedule: cron ? describe(cron) : (rrule ?? get("kind") ?? "manual"),
      enabled,
      nextRun: enabled && cron ? nextCron(cron) : undefined,
      lastRun,
      lastResult,
      cwd: toml.match(/^cwds\s*=\s*\["([^"]+)"/m)?.[1],
      file,
    });
  }
  return out;
}

/** Scheduled routines from the Claude desktop app and the Codex app (read from their files; read-only). */
export function listRoutines(): Routine[] {
  return [...claudeRoutines(), ...codexRoutines()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity));
}
