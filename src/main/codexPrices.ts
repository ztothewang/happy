import { query } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { saveSettings, settings } from "./settings.js";

/** USD per 1M tokens. */
export interface Price {
  input: number;
  cached: number;
  output: number;
}

/**
 * OpenAI API list prices (standard, short context), looked up Oct 26 2026 from third-party price guides;
 * gpt-6.1-terra is from OpenAI's own announcement. Refreshed daily (refreshCodexPrices) and editable in Settings.
 */
export const DEFAULT_CODEX_PRICES: Record<string, Price> = {
  "gpt-6-astra": { input: 10, cached: 1, output: 50 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
  "gpt-6-sol": { input: 2, cached: 0.2, output: 10 },
  "gpt-6.1-terra": { input: 1, cached: 0.05, output: 5 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cached: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
};

export const codexPrices = (): Record<string, Price> => ({ ...DEFAULT_CODEX_PRICES, ...settings().codexPrices });

/** API-equivalent cost of one Codex turn (Codex on a ChatGPT plan isn't billed per token; this is for comparison). */
export function codexCost(model: string | undefined, u: { input_tokens: number; cached_input_tokens?: number; output_tokens: number }): number {
  const p = codexPrices()[model ?? ""] ?? codexPrices()["gpt-6-astra"];
  const cached = u.cached_input_tokens ?? 0;
  return ((u.input_tokens - cached) * p.input + cached * p.cached + u.output_tokens * p.output) / 1e6;
}

const ok = (n: unknown) => typeof n === "number" && isFinite(n) && n >= 0 && n < 1000;

/** Once a day: ask Claude (with web search) for current OpenAI prices of these models; keep old prices on any doubt. */
export async function refreshCodexPrices(models: string[]): Promise<boolean> {
  const last = settings().codexPricesAt ?? 0;
  if (Date.now() - last < 23 * 3600_000 || !models.length) return false;
  saveSettings({ codexPricesAt: Date.now() }); // one try per day, even if it fails
  try {
    const q = query({
      prompt: `Look up the current OpenAI API list prices (standard tier, short context, USD per 1M tokens) for these models: ${models.join(", ")}.
Prefer openai.com; otherwise reputable price guides updated in the last month. Skip any model you can't find a price for.
Reply with ONLY a JSON object like {"model-slug": {"input": 1.25, "cached": 0.125, "output": 10}}.`,
      options: { model: "claude-sonnet-5-5", maxTurns: 8, allowedTools: ["WebSearch", "WebFetch"], settingSources: [], persistSession: false, permissionMode: "dontAsk", cwd: homedir() },
    });
    let text = "";
    for await (const m of q) if (m.type === "result" && m.subtype === "success") text = m.result;
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, Partial<Price>>;
    const next: Record<string, Price> = { ...settings().codexPrices };
    let n = 0;
    for (const [slug, p] of Object.entries(json)) {
      if (!models.includes(slug) || !ok(p.input) || !ok(p.output)) continue;
      next[slug] = { input: p.input!, cached: ok(p.cached) ? p.cached! : p.input! / 10, output: p.output! };
      n++;
    }
    if (n) saveSettings({ codexPrices: next });
    return n > 0;
  } catch {
    return false;
  }
}
