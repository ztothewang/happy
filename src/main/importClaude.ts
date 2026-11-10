import { createReadStream, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { TranscriptItem } from "../shared/types.js";
import { clip, summarizeArgs } from "./session.js";

/** How much of a Claude session's history Happy shows. */
const KEEP_ITEMS = 600;

/** A Claude Code session's transcript file (~/.claude/projects/<folder>/<id>.jsonl), whichever folder it's under. */
export function claudeTranscriptPath(sessionId: string): string | undefined {
  const base = join(homedir(), ".claude", "projects");
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base)) {
    const f = join(base, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}

/** A Claude routine run's first message wraps the task in <scheduled-task> with a standard preamble: show just the task. */
const routinePrompt = (t: string) =>
  t.startsWith("<scheduled-task")
    ? t
        .replace(/^<scheduled-task[^>]*>\s*/, "")
        .replace(/\s*<\/scheduled-task>\s*$/, "")
        .replace(/^This is an automated run of a scheduled task\.[\s\S]*?\n\s*\n/, "")
        .trim()
    : t;

const blocks = (content: unknown): any[] => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []);

/** A Claude Code session's history as Happy transcript rows (main thread only; tool results fold into their call). */
export async function readClaudeHistory(sessionId: string): Promise<{ items: TranscriptItem[]; dropped: number }> {
  const file = claudeTranscriptPath(sessionId);
  if (!file) return { items: [], dropped: 0 };
  const items: TranscriptItem[] = [];
  const tools = new Map<string, TranscriptItem>();
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.type !== "user" && e.type !== "assistant") || e.isSidechain || e.isMeta || !e.message) continue;
    const ts = Date.parse(e.timestamp) || Date.now();
    const add = (it: Omit<TranscriptItem, "id">) => {
      const row = { id: `cl:${sessionId}:${n++}`, ...it } as TranscriptItem;
      items.push(row);
      return row;
    };
    for (const b of blocks(e.message.content)) {
      if (e.type === "user") {
        if (b.type === "tool_result") {
          const t = tools.get(b.tool_use_id);
          if (!t) continue;
          const out = blocks(b.content)
            .map((c) => (c?.type === "text" ? c.text : `[${c?.type}]`))
            .join("\n");
          t.status = b.is_error ? "failed" : "done";
          if (out) (t.detail = clip(out)), (t.result = out.split("\n").find((l: string) => l.trim())?.slice(0, 80));
        } else if (b.type === "text" && b.text?.trim() && !/^<(command|local-command|system-reminder)/.test(b.text.trim())) add({ kind: "user", text: routinePrompt(b.text.trim()), ts });
      } else if (b.type === "text" && b.text?.trim()) add({ kind: "assistant", text: b.text.trim(), ts });
      else if (b.type === "thinking" && b.thinking?.trim()) add({ kind: "thinking", text: b.thinking.trim(), ts });
      else if (b.type === "tool_use") {
        const input = b.input ?? {};
        tools.set(b.id, add({ kind: "tool", tool: b.name, text: summarizeArgs(input), path: typeof input.file_path === "string" ? input.file_path : undefined, status: "done", ts }));
      }
    }
  }
  const dropped = Math.max(0, items.length - KEEP_ITEMS);
  return { items: items.slice(dropped), dropped };
}
