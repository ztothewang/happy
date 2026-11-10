import type { Engine } from "../shared/types.js";

const NAME: Record<Engine, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

/**
 * Plain-language version of an engine error: a one-line title and what to do next. The raw text is kept separately
 * and shown on demand.
 */
export function explainError(raw: string, engine: Engine): { title: string; hint?: string } {
  const n = NAME[engine];
  const r = raw.toLowerCase();
  const again = "Send a message (for example “continue”) to pick up where it left off.";
  if (/ede_diagnostic|error_during_execution|turn ended: (user|null)|stop_reason=null/.test(r))
    return { title: `${n} stopped partway through this turn.`, hint: again };
  if (/error_max_turns|max.?turns/.test(r)) return { title: `${n} reached its step limit for this request.`, hint: again };
  if (/max_budget|budget/.test(r)) return { title: `${n} reached the spending limit for this request.`, hint: again };
  if (/authentication|unauthori[sz]ed|401|not logged in|login expired|invalid api key|oauth/.test(r))
    return { title: `${n} isn't signed in, or the sign-in expired.`, hint: engine === "claude" ? "Run `claude` in a terminal and use /login; Happy uses the same login." : engine === "codex" ? "Run `codex login` in a terminal." : "Run `~/.local/bin/agent login` in a terminal." };
  if (/usage limit|you've hit your|plan limit|quota|insufficient_quota|out of credits/.test(r))
    return { title: `You've hit your ${n} plan limit for now.`, hint: "The top bar shows when it resets. Switch this session's model or engine, or wait." };
  if (/rate.?limit|429|too many requests/.test(r)) return { title: `${n} is rate-limiting requests right now.`, hint: "Wait a minute and send again." };
  if (/overloaded|529|503|server error|internal error|500\b|bad gateway|502/.test(r)) return { title: `${n}'s servers are having trouble.`, hint: "Try again in a moment." };
  if (/context.{0,20}(length|window|too long)|prompt is too long|maximum context/.test(r))
    return { title: "This conversation is too long for the model.", hint: engine === "claude" ? "Type /compact, or start a new session." : "Start a new session and summarize where you were." };
  if (/stream disconnected|reconnect|econnreset|etimedout|socket hang up|fetch failed|network/.test(r))
    return { title: `${n} lost its connection.`, hint: "Send again to retry." };
  if (/aborted|interrupted|cancel/.test(r)) return { title: "Stopped." };
  if (/already has an active writer|thread-store conflict/.test(r))
    return { title: "This Codex thread is open in the Codex (ChatGPT) app, which locks it.", hint: "Quit the ChatGPT app (or switch it to another thread), then send again. Happy resumes it even if you archive it there." };
  if (/crashed|exited with code|spawn/.test(r)) return { title: `${n}'s process stopped unexpectedly.`, hint: "Send a message to restart it; the conversation is kept." };
  return { title: `${n} ran into an error.`, hint: again };
}
