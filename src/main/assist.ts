import { settings } from "./settings.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TriageVerdict } from "../shared/types.js";

/** Who Happy writes as: "Name (email, company)". */
export function who(): string {
  const p = settings().profile;
  const extra = [p.email, p.company].filter(Boolean).join(", ");
  return `${p.name || "the user"}${extra ? ` (${extra})` : ""}`;
}
export const me = () => settings().profile.name || "the user";

/** Standing rules for anything written as the user (Settings → You). */
export function style(): string {
  const p = settings().profile;
  return [`Write as ${who()}.`, p.style.trim() || "- Short, clear and friendly. No filler.", p.signoff ? `- Sign off with just "${p.signoff}".` : ""].filter(Boolean).join("\n");
}

async function once(prompt: string, model = settings().helperModel): Promise<string> {
  const q = query({ prompt, options: { model, maxTurns: 1, tools: [], settingSources: [], persistSession: false, permissionMode: "dontAsk" } });
  for await (const m of q) {
    if (m.type === "result") {
      if (m.subtype === "success") return m.result.trim();
      throw new Error("Claude couldn't finish");
    }
  }
  throw new Error("no result");
}

/** A new email from instructions: "Subject: …" on the first line, then the body. */
export function draftNew(instruction: string, to: string[]): Promise<string> {
  return once(
    `${style()}\n\nWrite a new email from ${me()}${to.length ? ` to ${to.join(", ")}` : ""}.\nWhat it should say: ${instruction.trim() || "(not given: write a short, friendly placeholder)"}\nIf something needs a fact ${me()} hasn't given (a date, a number), leave a short [bracketed] placeholder instead of inventing it.\nOutput the first line as "Subject: <subject>", then a blank line, then only the email body.`,
  );
}

/** A reply draft for the thread. Only the body: no subject, no quoted history. */
export function draftReply(threadText: string, instruction?: string): Promise<string> {
  return once(
    `${style()}\n\nDraft ${me()}'s reply to the latest message in this email thread.${instruction?.trim() ? `\n${me()}'s instructions for this reply: ${instruction.trim()}` : ""}\nIf something needs a fact ${me()} hasn't given (a date, a number), leave a short [bracketed] placeholder instead of inventing it.\nOutput only the email body text.\n\n<thread>\n${threadText}\n</thread>`,
  );
}

/**
 * Zero inbox: decide for each open thread whether the user can archive it. Archived threads come back to the inbox when someone
 * replies, so "waiting on them" threads are safe to archive.
 */
export async function triage(digests: Array<{ id: string; text: string }>): Promise<TriageVerdict[]> {
  const list = digests.map((d, i) => `[${i}] ${d.text}`).join("\n\n");
  const out = await once(
    `You're helping ${who()} get to inbox zero. For each thread below decide:
- "archive": nothing for ${me()} to do now. FYIs, notifications, newsletters, receipts, finished conversations, threads where ${me()} replied last and is waiting on the other side (Gmail puts a thread back in the inbox when they reply).
- "reply": someone is waiting on ${me()} (a question, a request, an intro to respond to, a meeting to confirm).
- "keep": ${me()} should keep it visible even though no reply is needed (an upcoming deadline/event to act on, something to read or do soon). STARRED threads are "keep" unless clearly finished.
Return ONLY a JSON array, one object per thread, in order: {"i": <index>, "verdict": "archive"|"reply"|"keep", "reason": "<max 12 words>"}.

${list}`,
  );
  const json = out.slice(out.indexOf("["), out.lastIndexOf("]") + 1);
  const rows = JSON.parse(json) as Array<{ i: number; verdict: TriageVerdict["verdict"]; reason: string }>;
  return rows.filter((r) => digests[r.i]).map((r) => ({ id: digests[r.i].id, verdict: r.verdict, reason: r.reason }));
}

/** Natural language → event form. Claude only fills the form; the user reviews and saves. */
export async function parseEvent(text: string, now: Date, timeZone: string): Promise<import("../shared/types.js").EventInput> {
  const local = now.toLocaleString("en-US", { timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const offsetMin = -now.getTimezoneOffset();
  const off = `${offsetMin >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0")}:${String(Math.abs(offsetMin) % 60).padStart(2, "0")}`;
  const out = await once(
    `Turn this request into a Google Calendar event for ${who()}. It is now ${local} (${timeZone}, UTC${off}).
Rules: default length 30 minutes; "lunch"/"dinner" 1 hour; resolve relative dates ("next Tue") from now; times are in ${timeZone} unless stated.
Attendees only if an email address is given or clearly implied with a full address. addMeet true for calls/video/"meet"/"zoom-like" requests without a physical location.
Return ONLY JSON: {"title": str, "start": ISO 8601 with offset (or YYYY-MM-DD if allDay), "end": same format, "allDay": bool, "location": str|null, "description": str|null, "attendees": [emails], "addMeet": bool}

Request: ${text}`,
    "claude-haiku-5-5",
  );
  const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  return { title: j.title ?? "", start: j.start, end: j.end, allDay: !!j.allDay, location: j.location ?? undefined, description: j.description ?? undefined, attendees: j.attendees ?? [], addMeet: !!j.addMeet };
}

/** Natural language → Linear issue form (ids picked from the workspace's teams/projects/labels). Nothing is created. */
export async function parseIssue(text: string, meta: import("../shared/types.js").LinearMeta): Promise<import("../shared/types.js").LinearIssueInput> {
  const teams = meta.teams.map((t) => `team ${t.key} "${t.name}" id=${t.id}\n  members: ${t.members.map((m) => `${m.name}=${m.id}`).join(", ")}\n  labels: ${t.labels.map((l) => `${l.name}=${l.id}`).join(", ")}`).join("\n");
  const projects = meta.projects.map((p) => `"${p.name}"=${p.id}`).join(", ");
  const out = await once(
    `Turn this request from ${who()} (Linear viewer id ${meta.viewerId}) into a Linear issue.
Workspace:
${teams}
projects: ${projects || "(none)"}

Write a clear imperative title (max ~70 chars) and a concise markdown description (context, what to do, acceptance notes) using only what the request says; don't invent details.
priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low (0 unless the request implies urgency/importance).
Pick teamId (the only team if there's one), projectId/labelIds/assigneeId only when the request clearly matches; "me"/"I" = viewer id.
Return ONLY JSON: {"teamId": str, "title": str, "description": str, "priority": int, "assigneeId": str|null, "projectId": str|null, "labelIds": [str]}

Request: ${text}`,
  );
  const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  const team = meta.teams.find((t) => t.id === j.teamId) ?? meta.teams[0];
  return {
    teamId: team?.id,
    title: j.title ?? "",
    description: j.description ?? "",
    priority: Number.isInteger(j.priority) ? j.priority : 0,
    assigneeId: team?.members.some((m) => m.id === j.assigneeId) ? j.assigneeId : null,
    projectId: meta.projects.some((p) => p.id === j.projectId) ? j.projectId : null,
    labelIds: (j.labelIds ?? []).filter((id: string) => team?.labels.some((l) => l.id === id)),
  };
}
