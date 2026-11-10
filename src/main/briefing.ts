import { settings } from "./settings.js";
import { isDeployed } from "../shared/types.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Overview } from "../shared/types.js";

export interface Annotations {
  headline?: string;
  items: Record<string, string>; // ref → one-line summary
}

/** Compact, ref-keyed view of the board for the model. */
function digest(o: Overview) {
  return {
    active: o.active.map((r) => ({ ref: r.ref, title: r.title, status: r.status, last_reply: r.lastReply })),
    done_24h: o.recent.map((r) => ({
      ref: r.ref,
      title: r.title,
      merged: r.git?.merged,
      unmerged_commits: r.git?.ahead,
      uncommitted: r.git?.dirty,
      deployed_to: r.git?.merged ? r.git?.deploys?.filter(isDeployed).map((d) => d.tenant) : undefined,
      last_reply: r.lastReply,
    })),
    needs_merging: o.unfinished.map((u) => ({
      ref: u.ref,
      branch: u.branch,
      folder: u.path.split("/").pop(),
      unmerged_commits: u.ahead,
      uncommitted: u.dirty,
      last_commit: u.lastSubject,
      has_session: !!u.sessionId,
    })),
    errors: o.gcp?.groups.map((g) => ({ ref: g.ref, service: g.service, message: g.signature, total: g.total, by_tenant: g.byTenant })),
  };
}

/**
 * One Sonnet call: a one-line plain-English summary per board item (keyed by ref) plus a headline.
 * Returns undefined on any failure; the board still renders from raw data.
 */
export async function annotate(o: Overview): Promise<Annotations | undefined> {
  const prompt = `You annotate an engineering status board for a busy founder. For EVERY item below, write one short plain-English line (max ~14 words), no markdown:
- active / done_24h: what the session did or is doing, outcome first (e.g. "Added preferred names to people; merged and deployed to deb, ber, nov").
- needs_merging: what the branch is and what's left (e.g. "Memo PDF layout fix, 1 commit waiting to merge").
- errors: what is actually broken in human terms and the likely cause, not the raw log (e.g. "Microsoft logins expiring for one customer; token refresh failing for several users").
Also write "headline": one sentence on what most needs attention.
Reply with ONLY JSON: {"headline": "...", "items": {"<ref>": "<line>", ...}}

Board:
${JSON.stringify(digest(o))}`;
  try {
    const q = query({
      prompt,
      options: { model: settings().helperModel, maxTurns: 1, tools: [], settingSources: [], persistSession: false, permissionMode: "dontAsk" },
    });
    for await (const m of q) {
      if (m.type !== "result" || m.subtype !== "success") continue;
      const json = m.result.slice(m.result.indexOf("{"), m.result.lastIndexOf("}") + 1);
      const parsed = JSON.parse(json);
      return { headline: typeof parsed.headline === "string" ? parsed.headline : undefined, items: parsed.items ?? {} };
    }
  } catch {}
  return undefined;
}
