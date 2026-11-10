import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import * as pty from "node-pty";

/** Output kept per shell so a reopened Terminal page shows what was there. */
const SCROLLBACK = 256 * 1024;

interface Shell {
  id: string;
  proc: pty.IPty;
  cwd: string;
  buf: string;
  /** Recent output tail, so a finish marker split across chunks is still seen. */
  tail: string;
  /** Bytes of output so far (buf only keeps the end). */
  total: number;
  /** Commands run for a chat: run id → output position when it started. */
  runs: Map<string, number>;
}

/** Invisible OSC sequence printed after a tracked command: ESC ] 1337 ; HappyJob=<id>;<exit code> BEL. */
const MARKER = /\x1b\]1337;HappyJob=([\w-]+);(\d+)\x07/g;
/** Same, for a command a chat ran (its output goes back to the agent). */
const RUN_MARKER = /\x1b\]1337;HappyRun=([\w-]+);(\d+)\x07/g;

/** Terminal output as plain text: no colors or cursor codes, no carriage-return overwrites. */
export function plainText(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Z0-9]|\x1b[=>]/g, "")
    .split("\n")
    .map((l) => l.split("\r").filter(Boolean).pop() ?? "")
    .join("\n");
}

/**
 * Real login shells (zsh by default) for the Terminal page. They live in the main process, so switching pages or
 * reloading the window keeps them running; they end when Happy quits.
 */
export class Terminals {
  private shells = new Map<string, Shell>();

  constructor(
    private emit: {
      data(id: string, data: string): void;
      exit(id: string): void;
      marker?(id: string, job: string, code: number): void;
      /** A command started with run() finished: its exit code and what it printed. */
      ran?(id: string, run: string, code: number, output: string): void;
    },
  ) {}

  has(id: string) {
    return this.shells.has(id);
  }

  /** Type a command into a shell and report its exit code and output when it finishes. */
  run(id: string, run: string, command: string) {
    const s = this.shells.get(id);
    if (!s) return false;
    s.runs.set(run, s.total);
    s.proc.write(`${command}; printf '\\033]1337;HappyRun=${run};%s\\007' $?\r`);
    return true;
  }

  create(id: string, cwd: string, cols: number, rows: number, command?: string) {
    if (this.shells.has(id)) return this.info(id);
    const dir = existsSync(cwd) ? cwd : homedir();
    const shell = process.env.SHELL || "/bin/zsh";
    const proc = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: Math.max(cols, 20),
      rows: Math.max(rows, 5),
      cwd: dir,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Happy" } as Record<string, string>,
    });
    const s: Shell = { id, proc, cwd: dir, buf: "", tail: "", total: 0, runs: new Map() };
    proc.onData((d) => {
      s.buf = (s.buf + d).slice(-SCROLLBACK);
      s.total += d.length;
      this.emit.data(id, d);
      if (d.includes("Happy") || s.tail.includes("\x1b]1337")) {
        const text = s.tail + d;
        for (const m of text.matchAll(MARKER)) this.emit.marker?.(id, m[1], Number(m[2]));
        for (const m of text.matchAll(RUN_MARKER)) {
          const start = s.runs.get(m[1]);
          if (start == null) continue;
          s.runs.delete(m[1]);
          const raw = s.buf.slice(-Math.min(s.buf.length, s.total - start));
          this.emit.ran?.(id, m[1], Number(m[2]), raw.slice(0, Math.max(0, raw.lastIndexOf("\x1b]1337;HappyRun="))));
        }
        s.tail = text.replace(MARKER, "").replace(RUN_MARKER, "").slice(-200);
      } else s.tail = d.slice(-200);
    });
    proc.onExit(() => {
      this.shells.delete(id);
      this.emit.exit(id);
    });
    this.shells.set(id, s);
    // A command to run once the shell is up (e.g. a deploy started from the Manager board), typed as if by you.
    if (command) setTimeout(() => proc.write(`${command}\r`), 400);
    return this.info(id);
  }

  private info(id: string) {
    const s = this.shells.get(id)!;
    return { id, cwd: s.cwd, buffer: s.buf };
  }

  /** Shells still running (with their recent output), e.g. after the window reloads. */
  list() {
    return [...this.shells.keys()].map((id) => this.info(id));
  }

  /** Shells sitting at their prompt (nothing running in the foreground). */
  idle(): string[] {
    return [...this.shells.values()].filter((s) => s.proc.process === basename(process.env.SHELL || "/bin/zsh") || /^-?(zsh|bash|sh|fish)$/.test(s.proc.process)).map((s) => s.id);
  }

  write(id: string, data: string) {
    this.shells.get(id)?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    try {
      this.shells.get(id)?.proc.resize(Math.max(cols, 20), Math.max(rows, 5));
    } catch {}
  }

  kill(id: string) {
    const s = this.shells.get(id);
    if (!s) return;
    this.shells.delete(id);
    try {
      s.proc.kill();
    } catch {}
  }

  killAll() {
    for (const id of [...this.shells.keys()]) this.kill(id);
  }
}
