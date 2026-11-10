import { settings } from "./settings.js";
import { projectConfig } from "./projectConfig.js";
import { listSessions, query } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptItem } from "../shared/types.js";

/** Title Claude Code generated for a session (its summary/custom title), if any. */
export async function claudeTitle(sessionId: string, cwd: string): Promise<string | undefined> {
  try {
    const list = await listSessions({ dir: cwd, limit: 200 });
    const s = list.find((x) => x.sessionId === sessionId);
    const t = s?.customTitle || s?.summary;
    if (!t || t === s?.firstPrompt) return undefined;
    return t.trim();
  } catch {
    return undefined;
  }
}

/** Thread name Codex itself recorded (written when a thread is opened in the Codex app). */
export async function codexIndexTitle(threadId: string): Promise<string | undefined> {
  try {
    const lines = (await readFile(join(homedir(), ".codex", "session_index.jsonl"), "utf8")).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes(threadId)) continue;
      const row = JSON.parse(lines[i]);
      if (row.id === threadId && row.thread_name) return String(row.thread_name).trim();
    }
  } catch {}
  return undefined;
}

/** Board refs (C1, M2, E3…) mean nothing outside the board; keep them out of what Haiku sees. */
/** Short codes → names: the project's environment names plus its glossary (from .happy/config.json). */
function glossary(): Record<string, string> {
  const cfg = projectConfig(settings().repo);
  return { ...Object.fromEntries((cfg.environments ?? []).filter((e) => e.name).map((e) => [e.id, e.name!])), ...cfg.glossary };
}
const stripRefs = (t: string) => {
  const g = glossary();
  const codes = Object.keys(g).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const out = t.replace(/\s*\(([ACDEM]\d{1,2})\)/g, "").replace(/\b[ACDEM]\d{1,2}\b:?\s*/g, "");
  // Environment codes as Cloud writes them ("ber:", "nov (GCP project …)") → their names.
  return codes.length ? out.replace(new RegExp(`\\b(${codes.join("|")})\\b(?=\\s*[:(]|\\s+\\d)`, "g"), (c) => g[c] ?? c) : out;
};

/** One tiny Haiku call: a 3–6 word title from the first exchange (used for Codex threads Codex didn't name). */
export async function generateTitle(items: TranscriptItem[]): Promise<string | undefined> {
  const user = items.find((i) => i.kind === "user")?.text ?? "";
  const reply = items.find((i) => i.kind === "assistant")?.text ?? "";
  if (!user.trim()) return undefined;
  try {
    const q = query({
      prompt: [
        "Write a title for this work session: 3-7 words, sentence case, specific enough to recognize later in a list.",
        "Name the concrete subject (the customer or environment, the service, table, feature, file or error) and what's being done (fix, investigate, add, review).",
        "Never use board references like C1, M2, E3, D4, A1, or words like \"session\", \"task\" or \"issue\" on their own.",
        "Reply with the title only, no quotes, no trailing punctuation.",
        `\nRequest:\n${stripRefs(user).slice(0, 2500)}`,
        reply ? `\nFirst reply:\n${stripRefs(reply).slice(0, 800)}` : "",
      ].join("\n"),
      // Neutral working directory: otherwise Claude Code tells Haiku which folder it's in and titles pick it up.
      options: { model: "claude-haiku-5-5", maxTurns: 1, tools: [], settingSources: [], persistSession: false, permissionMode: "dontAsk", cwd: homedir() },
    });
    for await (const m of q) {
      if (m.type === "result" && m.subtype === "success") {
        const t = m.result.trim().split("\n")[0].replace(/^["'#\s]+|["'.\s]+$/g, "");
        return t && t.length <= 80 ? t : undefined;
      }
    }
  } catch {}
  return undefined;
}

/** Fast title from just the first prompt (Haiku, ~1s); undefined after 8s or on failure. Used to name new worktrees. */
export async function titleFromPrompt(prompt: string, details?: string, waitMs = 15_000): Promise<string | undefined> {
  const t = generateTitle([{ id: "u", kind: "user", text: details ? `${details}\n\n${prompt}` : prompt, ts: 0 }]);
  // A cold Haiku call takes ~5s, longer when the machine is busy; worktree setup waits at most waitMs for it.
  return Promise.race([t, new Promise<undefined>((r) => setTimeout(() => r(undefined), waitMs))]);
}

/** Rewrite an agent reply for a busy reader: much shorter, plain language, answer first. Display-only. */
export async function simplifyText(text: string): Promise<string | undefined> {
  try {
    const q = query({
      prompt: `Rewrite this message from a coding agent for a busy founder. Much shorter, plain language, no jargon. Lead with the answer or what they need to do. Use at most 5 short bullets if it helps. Keep exact numbers, names, file paths, links and anything they must act on. Skip background. Output only the rewrite in markdown.\n\n---\n${text.slice(0, 12000)}`,
      options: { model: settings().helperModel, maxTurns: 1, tools: [], settingSources: [], persistSession: false, permissionMode: "dontAsk" },
    });
    for await (const m of q) if (m.type === "result" && m.subtype === "success") return m.result.trim() || undefined;
  } catch {}
  return undefined;
}
