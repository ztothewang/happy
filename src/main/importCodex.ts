import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CodexThreadInfo, TranscriptItem } from "../shared/types.js";
import { clip, summarizeArgs } from "./session.js";

/** How much of an imported thread's history Happy shows (the agent itself resumes with its full context). */
const KEEP_ITEMS = 600;

const sqlite = (sql: string) =>
  new Promise<any[]>((resolve, reject) =>
    execFile("sqlite3", ["-json", "-readonly", join(homedir(), ".codex", "state_5.sqlite"), sql], { maxBuffer: 16 * 1024 * 1024 }, (err, out) =>
      err ? reject(new Error(`Couldn't read Codex's thread list: ${err.message}`)) : resolve(out.trim() ? JSON.parse(out) : []),
    ),
  );

type Row = { id: string; name: string | null; title: string | null; cwd: string; model: string | null; reasoning_effort: string | null; updated_at_ms: number; rollout_path: string };

/** Codex's own (non-archived, top-level) threads, newest first. */
export async function listCodexThreads(): Promise<Array<CodexThreadInfo & { rolloutPath: string; effort?: string }>> {
  const rows: Row[] = await sqlite(
    "select id, name, title, cwd, model, reasoning_effort, updated_at_ms, rollout_path from threads where archived = 0 and coalesce(agent_role, '') = '' order by updated_at_ms desc limit 200",
  );
  return rows.map((r) => ({
    id: r.id,
    title: (r.name || r.title || "Codex chat").split("\n")[0].slice(0, 120),
    cwd: r.cwd,
    model: r.model ?? undefined,
    effort: r.reasoning_effort ?? undefined,
    updatedAt: r.updated_at_ms,
    rolloutPath: r.rollout_path,
  }));
}

const text = (content: any[] | undefined) =>
  (content ?? [])
    .filter((c) => typeof c?.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();

/** One rollout item (Codex's `item_completed` event) as a Happy transcript row; undefined for noise. */
function toItem(it: any, ts: number, durationMs: number | undefined): Omit<TranscriptItem, "id"> | undefined {
  switch (it.type) {
    case "UserMessage": {
      const t = text(it.content);
      return t ? { kind: "user", text: t, ts } : undefined;
    }
    case "AgentMessage": {
      const t = text(it.content);
      return t ? { kind: "assistant", text: t, ts } : undefined;
    }
    case "Reasoning": {
      const t = (it.summary_text ?? []).join("\n").trim();
      return t ? { kind: "thinking", text: t, ts } : undefined;
    }
    case "CommandExecution": {
      const cmd: string[] = Array.isArray(it.command) ? it.command : [String(it.command ?? "")];
      // ["/bin/zsh", "-lc", "<script>"] → the script.
      const shown = cmd.length >= 3 && /-l?c$/.test(cmd[1]) ? cmd.slice(2).join(" ") : cmd.join(" ");
      return {
        kind: "tool",
        tool: "shell",
        text: shown,
        detail: clip(String(it.aggregated_output ?? "")),
        result: it.exit_code != null ? `exit ${it.exit_code}` : undefined,
        status: it.status === "failed" || (it.exit_code ?? 0) !== 0 ? "failed" : "done",
        durationMs,
        ts,
      };
    }
    case "FileChange": {
      const paths = Object.keys(it.changes ?? {});
      return {
        kind: "tool",
        tool: "patch",
        text: paths.map((p) => `${it.changes[p]?.type ?? "update"} ${p}`).join(", "),
        path: paths[0],
        status: it.status === "failed" ? "failed" : "done",
        durationMs,
        ts,
      };
    }
    case "McpToolCall": {
      const out = (it.result?.content as any[] | undefined)?.map((c) => (c?.type === "text" ? c.text : `[${c?.type}]`)).join("\n");
      return {
        kind: "tool",
        tool: `${it.appName || it.server}.${it.tool}`,
        text: summarizeArgs(it.arguments),
        detail: it.error ? String(it.error.message ?? it.error) : out ? clip(out) : undefined,
        result: it.error ? "error" : out ? out.split("\n").find((l: string) => l.trim())?.slice(0, 80) : undefined,
        status: it.status === "failed" || it.error ? "failed" : "done",
        durationMs,
        ts,
      };
    }
    case "Extension":
      return it.kind === "web.search" ? { kind: "tool", tool: "web_search", text: String(it.query ?? ""), status: "done", ts } : undefined;
    case "ImageView":
      return { kind: "tool", tool: "view_image", text: String(it.path ?? "").replace(/^file:\/\//, ""), status: "done", ts };
    case "ContextCompaction":
      return { kind: "system", text: "Context compacted", ts };
  }
  return undefined;
}

/** The last KEEP_ITEMS rows of a Codex thread's history, streamed from its rollout file (they can be hundreds of MB). */
export async function readCodexHistory(rolloutPath: string): Promise<{ items: TranscriptItem[]; dropped: number }> {
  if (!existsSync(rolloutPath)) return { items: [], dropped: 0 };
  const ring: TranscriptItem[] = [];
  let total = 0;
  const rl = createInterface({ input: createReadStream(rolloutPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"item_completed"')) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const p = d.payload;
    if (d.type !== "event_msg" || p?.type !== "item_completed" || !p.item) continue;
    const ts = p.completed_at_ms ?? Date.parse(d.timestamp) ?? Date.now();
    const dur = p.started_at_ms && p.completed_at_ms ? p.completed_at_ms - p.started_at_ms : undefined;
    const row = toItem(p.item, ts, dur);
    if (!row) continue;
    total++;
    ring.push({ id: `imp:${p.item.id ?? total}`, ...row });
    if (ring.length > KEEP_ITEMS) ring.shift();
  }
  return { items: ring, dropped: total - ring.length };
}
