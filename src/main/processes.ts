import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface OsProc {
  pid: number;
  cwd: string;
  command: string;
  name: string;
  startedAt?: number;
  /** True when Happy (this app) is an ancestor: the work came from one of its agents. */
  fromHappy: boolean;
}

/** Agent/infra processes that aren't "work" (the agents themselves, shells, this app). */
const IGNORE = /(^|\/)(claude|codex|node_modules\/\.bin\/electron|Electron( Helper.*)?|zsh|bash|sh|fish|login|lsof|ps|git|ssh|ssh-agent|caffeinate)$/;

/** Agent infrastructure that lingers in a folder but isn't work: Cursor's worker, language servers, tsserver. */
const IGNORE_CMD = /cursor-agent\/versions\/|codex-darwin|claude-agent-sdk|language-server|languageserver|\btsserver\b|pyright|gopls|rust-analyzer|eslint_d/;

/** Other agent apps: anything they start is their work, not a Happy session's. */
const FOREIGN = /\/Applications\/(Claude|Cursor|ChatGPT|Codex)\.app\/|\/Application Support\/Claude\/claude-code\/|cursor-agent|anysphere\.cursor/;

/** Happy's own agent processes (Claude SDK, Codex, Cursor). Only work started under one of these is a chat's. */
const AGENT = /claude-agent-sdk|codex-darwin|@openai\/codex|cursor-agent/;

/** Agent plumbing that isn't work: MCP servers (and the npm exec wrappers that start them), polling sleeps. */
const PLUMBING = /\bmcp\b|-mcp(-[\w-]+)?\b|mcp-server|^sleep \d/;

/** Every process's working directory (one lsof call), plus command line + start time (one ps call). */
export async function listProcesses(): Promise<OsProc[]> {
  let out = "";
  try {
    out = (await run("lsof", ["-a", "-d", "cwd", "-Fpcn"], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (e: any) {
    out = e.stdout ?? ""; // lsof exits 1 when some processes are inaccessible; output is still valid
  }
  const procs = new Map<number, { cwd: string; name: string }>();
  let pid = 0;
  let name = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c")) name = line.slice(1);
    else if (line.startsWith("n") && pid) procs.set(pid, { cwd: line.slice(1), name });
  }
  if (!procs.size) return [];
  const self = process.pid;
  const rows: OsProc[] = [];
  try {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,lstart=,command="], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    const all = new Map<number, { ppid: number; start: string; cmd: string }>();
    for (const line of stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
      if (m) all.set(Number(m[1]), { ppid: Number(m[2]), start: m[3], cmd: m[4] });
    }
    // Walk up the parent chain once per process: is it Happy's, or another agent app's? Of Happy's, only what one of
    // its agents started counts; the rest is Happy itself (Terminal page shells, npm/gcloud checks) and belongs to no chat.
    const lineage = (pid: number) => {
      let fromHappy = false;
      let foreign = false;
      let viaAgent = false;
      for (let p = all.get(pid)?.ppid ?? 1, child = pid, n = 0; p > 1 && n < 64; child = p, p = all.get(p)?.ppid ?? 1, n++) {
        if (p === self) {
          fromHappy = true;
          viaAgent = AGENT.test(all.get(child)?.cmd ?? "");
        }
        if (FOREIGN.test(all.get(p)?.cmd ?? "")) foreign = true;
      }
      return { fromHappy, foreign, viaAgent };
    };
    for (const [p, row] of all) {
      const info = procs.get(p);
      if (!info || p === self) continue;
      const cmd = row.cmd;
      const exe = cmd.split(" ")[0];
      if (IGNORE.test(exe) || IGNORE.test(info.name) || IGNORE_CMD.test(cmd) || PLUMBING.test(cmd) || FOREIGN.test(cmd)) continue;
      const { fromHappy, foreign, viaAgent } = lineage(p);
      if (foreign && !fromHappy) continue;
      if (fromHappy && !viaAgent) continue;
      rows.push({ pid: p, cwd: info.cwd, command: cmd, name: info.name, startedAt: Date.parse(row.start) || undefined, fromHappy });
    }
  } catch {}
  return rows;
}

export function within(cwd: string, root: string) {
  const a = cwd.toLowerCase();
  const b = root.toLowerCase().replace(/\/+$/, "");
  return a === b || a.startsWith(b + "/");
}
