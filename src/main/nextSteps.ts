import type { NextStep, TagDef } from "../shared/types.js";

export interface CheckResult {
  options?: NextStep[];
  add: string[];
  remove: string[];
}

/**
 * Asked of the same agent after a reply, out of sight: it knows the whole session, not just the last message.
 * Next steps (2–4 messages to offer as buttons) and/or a check of the auto tags against the work so far.
 */
export function checkPrompt(opts: { nextSteps: boolean; tags: TagDef[]; current: string[] }): string | undefined {
  const tags = opts.tags.filter((t) => t.auto && t.description.trim());
  if (!opts.nextSteps && !tags.length) return undefined;
  const parts: string[] = ["A quick check based on everything in this session so far. Don't do any work now and don't use any tools."];
  if (opts.nextSteps)
    parts.push(
      "Next steps: the 2 to 4 most useful things I could ask you to do next, most likely first. For each, a short label (2 to 6 words) and the exact message I would send you, in my voice.",
    );
  if (tags.length)
    parts.push(
      [
        `Tags: this session is tagged ${opts.current.length ? opts.current.map((t) => `"${t}"`).join(", ") : "with nothing"}. Check these tags against the work in this session:`,
        ...tags.map((t) => `- "${t.name}": ${t.description}`),
        "Add a tag when it applies and isn't there. Remove one when it's there but no longer applies (the script was run, the migration applied, the version published, or the work was dropped). Only change tags you're sure about.",
      ].join("\n"),
    );
  parts.push(`Reply with only this JSON and nothing else: {${[opts.nextSteps && '"options":[{"label":"…","message":"…"}]', tags.length && '"tags":{"add":[],"remove":[]}'].filter(Boolean).join(",")}}`);
  return parts.join("\n\n");
}

/** The agent's answer: options, plus tag changes limited to the auto tags (adds only if missing, removes only if set). */
export function parseCheck(raw: string | undefined, tags: TagDef[], current: string[]): CheckResult | undefined {
  const m = raw?.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  let v: { options?: unknown; tags?: { add?: unknown; remove?: unknown } };
  try {
    v = JSON.parse(m[0]);
  } catch {
    return undefined;
  }
  const auto = new Set(tags.filter((t) => t.auto).map((t) => t.name));
  const names = (x: unknown) => (Array.isArray(x) ? x.filter((t): t is string => typeof t === "string").map((t) => t.replace(/^#/, "").trim().toLowerCase()) : []);
  const options = Array.isArray(v.options)
    ? (v.options as NextStep[])
        .filter((o) => !!o && typeof o.label === "string" && typeof o.message === "string" && !!o.label.trim() && !!o.message.trim())
        .slice(0, 4)
        .map((o) => ({ label: o.label.trim().slice(0, 60), message: o.message.trim() }))
    : [];
  return {
    options: options.length ? options : undefined,
    add: [...new Set(names(v.tags?.add))].filter((t) => auto.has(t) && !current.includes(t)),
    remove: [...new Set(names(v.tags?.remove))].filter((t) => auto.has(t) && current.includes(t)),
  };
}

/** A next-steps / tag-check answer (JSON with options or tags), which must never show up as a reply. */
export const isCheckAnswer = (text: string) => /^\s*(```(json)?\s*)?\{\s*"(options|tags)"\s*:/.test(text);
