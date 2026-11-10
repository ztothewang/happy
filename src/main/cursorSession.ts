import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Session, clip, promptWithFiles, summarizeArgs, type SessionHost } from "./session.js";
import type { SessionMeta, TranscriptItem } from "../shared/types.js";

/** Cursor's CLI ("agent" / "cursor-agent"), installed to ~/.local/bin by Cursor's installer. */
export function cursorBinary(): string {
  for (const p of [join(homedir(), ".local", "bin", "cursor-agent"), join(homedir(), ".local", "bin", "agent")]) if (existsSync(p)) return p;
  return "cursor-agent";
}

/** Map Cursor's `<name>ToolCall` payloads to transcript rows. */
function describeTool(kind: string, call: any): { tool: string; text: string; path?: string; result?: string; failed?: boolean; detail?: string } {
  const name = kind.replace(/ToolCall$/, "");
  const args = call?.args ?? {};
  const res = call?.result ?? {};
  const ok = res.success;
  const err = res.error ?? res.failure ?? res.rejected;
  const path = typeof args.path === "string" ? args.path : typeof args.filePath === "string" ? args.filePath : undefined;
  let result: string | undefined;
  let detail: string | undefined;
  if (name === "shell") {
    result = ok ? `exit ${ok.exitCode}` : err ? "error" : undefined;
    detail = ok ? clip(ok.interleavedOutput ?? `${ok.stdout ?? ""}${ok.stderr ?? ""}`) : err ? clip(JSON.stringify(err)) : undefined;
  } else if (name === "read") {
    result = ok ? `${ok.totalLines ?? "?"} lines` : err ? "error" : undefined;
  } else if (ok) {
    const added = ok.linesAdded ?? ok.addedLines;
    const removed = ok.linesRemoved ?? ok.removedLines;
    result = added != null || removed != null ? `+${added ?? 0} −${removed ?? 0}` : ok.totalMatches != null ? `${ok.totalMatches} hits` : undefined;
    detail = ok.diffString ? clip(ok.diffString) : undefined;
  } else if (err) {
    result = "error";
    detail = clip(JSON.stringify(err));
  }
  return { tool: name === "shell" ? "shell" : name, text: name === "shell" ? String(args.command ?? "") : summarizeArgs(args), path, result, failed: !!err, detail };
}

/**
 * Cursor sessions: one `agent -p --output-format stream-json` process per turn, resumed by chat id.
 * Like Codex, messages sent mid-turn are queued; Stop kills the process.
 */
export class CursorSession extends Session {
  private queue: Array<{ text: string; images?: string[]; files?: string[] }> = [];
  private child?: ChildProcess;
  private runId = 0;
  private running = false;

  constructor(meta: SessionMeta, items: TranscriptItem[], host: SessionHost) {
    super(meta, items, host);
  }

  private args(prompt: string): string[] {
    const a = ["-p", "--output-format", "stream-json", "--trust", "--workspace", this.meta.cwd];
    const mode = this.meta.cursorMode ?? "full";
    if (mode === "full") a.push("--force");
    else if (mode === "plan") a.push("--mode", "plan");
    else if (mode === "ask") a.push("--mode", "ask");
    if (this.meta.model) a.push("--model", this.meta.model);
    if (this.meta.engineSessionId) a.push("--resume", this.meta.engineSessionId);
    a.push(prompt);
    return a;
  }

  private async runLoop() {
    const myRun = ++this.runId;
    this.running = true;
    this.setStatus("running");
    const live = () => this.runId === myRun;
    while (live() && this.queue.length) {
      const { text, images, files } = this.queue.shift()!;
      // Cursor's CLI has no image flag; attachments are passed as paths for the agent to open.
      const prompt = promptWithFiles(text, [...(images ?? []), ...(files ?? [])]);
      const ok = await this.runTurn(prompt, live);
      if (!ok) return;
    }
    if (!live()) return;
    this.running = false;
    for (const it of this.items) if (it.status === "running") it.status = "failed";
    this.setStatus("idle");
  }

  /** Run one turn; false if it failed hard (status already set). */
  private runTurn(prompt: string, live: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(cursorBinary(), this.args(prompt), { cwd: this.meta.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      let stderr = "";
      let sawResult = false;
      child.stderr!.on("data", (d) => (stderr = (stderr + String(d)).slice(-4000)));
      const rl = createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        if (!live() || !line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        this.handle(ev);
        if (ev.type === "result") sawResult = true;
      });
      child.on("error", (err) => {
        if (!live()) return resolve(false);
        this.running = false;
        this.fail(`Couldn't start Cursor's agent: ${err.message}. Install it with Cursor's installer and run \`agent login\`.`);
        resolve(false);
      });
      child.on("close", (code) => {
        rl.close();
        if (this.child === child) this.child = undefined;
        if (!live()) return resolve(false);
        if (code !== 0 && !sawResult) {
          this.running = false;
          const msg = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit code ${code}`;
          this.fail(/not logged in|login/i.test(msg) ? "Cursor's agent isn't logged in. Run `~/.local/bin/agent login` in a terminal." : `Cursor error: ${msg}`);
          return resolve(false);
        }
        resolve(true);
      });
    });
  }

  private handle(ev: any) {
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init" && ev.session_id && ev.session_id !== this.meta.engineSessionId) {
          this.meta.engineSessionId = ev.session_id;
          this.touch();
        }
        return;
      case "thinking":
        return; // streamed deltas of short reasoning; skipped to keep the transcript clean
      case "assistant": {
        const text = (ev.message?.content ?? [])
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("");
        if (text.trim()) this.addItem({ kind: "assistant", text });
        return;
      }
      case "tool_call": {
        const tc = ev.tool_call ?? {};
        const kind = Object.keys(tc).find((k) => k.endsWith("ToolCall"));
        if (!kind) return;
        const d = describeTool(kind, tc[kind]);
        const id = `cursor:${ev.call_id}`;
        const started = Number(tc.startedAtMs) || undefined;
        this.upsertItem(id, {
          kind: "tool",
          tool: d.tool,
          text: d.text,
          path: d.path,
          detail: d.detail,
          result: ev.subtype === "completed" ? d.result : undefined,
          status: ev.subtype === "completed" ? (d.failed ? "failed" : "done") : "running",
          durationMs: ev.subtype === "completed" && started ? Date.now() - started : undefined,
        });
        return;
      }
      case "result": {
        const u = ev.usage;
        if (u) {
          const d = (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheWriteTokens ?? 0);
          this.tokens = (this.tokens ?? 0) + d;
          this.host.recordUsage(d, 0, "cursor");
        }
        if (ev.is_error) this.engineError(String(ev.result ?? "Cursor reported an error").slice(0, 2000));
        return;
      }
    }
  }

  async send(text: string, images?: string[], files?: string[], echo = true) {
    if (echo) this.userItem(text, images, files);
    this.lastError = undefined;
    this.queue.push({ text, images, files });
    if (!this.running) void this.runLoop();
  }

  async setModel(model: string | undefined) {
    this.meta.model = model;
    this.touch();
  }

  async interrupt() {
    if (!this.running) return;
    this.runId++;
    this.running = false;
    this.queue = [];
    this.child?.kill("SIGTERM");
    for (const it of this.items) if (it.status === "running") it.status = "failed";
    this.addItem({ kind: "system", text: "Interrupted" });
    this.setStatus("idle");
  }

  dispose() {
    this.runId++;
    this.running = false;
    this.queue = [];
    this.child?.kill("SIGTERM");
  }
}
