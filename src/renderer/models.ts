import type { ClaudePermissionMode, Engine } from "../shared/types";

/** Claude models for the pickers: Claude Code's own list for your account once known (see useClaudeModels), else these. */
export const CLAUDE_MODELS: Array<{ id: string | null; label: string }> = [
  { id: null, label: "Default" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
];

/** Swap in the live list (in place, so every picker sees it). */
export function setClaudeModels(live: Array<{ id: string; label: string }>) {
  if (!live.length) return;
  CLAUDE_MODELS.splice(0, CLAUDE_MODELS.length, { id: null, label: "Default" }, ...live);
}

export function modelLabel(engine: Engine, model?: string | null): string {
  if (!model) return "Default";
  if (engine === "claude") return CLAUDE_MODELS.find((m) => m.id === model)?.label ?? model;
  return model;
}

export const PERMISSION_MODES: Array<{ value: ClaudePermissionMode; label: string; short: string }> = [
  { value: "default", label: "Ask before actions", short: "Ask" },
  { value: "acceptEdits", label: "Auto-accept edits", short: "Accept edits" },
  { value: "plan", label: "Plan only", short: "Plan" },
  { value: "bypassPermissions", label: "Bypass permissions", short: "Bypass" },
];

export const permissionShort = (m?: ClaudePermissionMode) => PERMISSION_MODES.find((p) => p.value === (m ?? "default"))!.short;

const TAG_HUES = [24, 200, 140, 280, 340, 50, 170, 230];
export function tagHue(tag: string): number {
  if (tag === "backfill") return 24;
  let h = 0;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TAG_HUES[h % TAG_HUES.length];
}

export function relTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const engineCode = (engine: Engine, isManager?: boolean) => (isManager ? "manager" : engine);

/** A number for display, with thousands separators ("12,345"). */
export const num = (n?: number | null) => (n == null ? "" : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function fmtTokens(n?: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${num(Math.round(n / 100_000_000) / 10)}B`;
}

export function fmtDuration(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const fmtClock = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const fmtCost = (usd?: number) => (usd ? `~$${usd < 10 ? usd.toFixed(2) : num(Math.round(usd))}` : "");

/** Short model label for dense chrome: claude-opus-5-5 → opus-5.5 */
export function modelShort(engine: Engine, model?: string | null): string {
  if (!model) return "default";
  if (engine === "claude") return model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2");
  return model;
}

/** When the last message (yours or the agent's) was sent; falls back to when the chat was created. Sidebars sort by it. */
export function lastMessageAt(s: { items: Array<{ kind: string; ts: number }>; createdAt: number }): number {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === "user" || it.kind === "assistant") return it.ts;
  }
  return s.createdAt;
}
