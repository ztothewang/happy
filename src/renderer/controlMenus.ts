import { useEffect, useState } from "react";
import type { ClaudePermissionMode, CodexModelInfo, CodexSandbox, CursorMode, Engine } from "../shared/types";
import { hub } from "./App";
import type { MenuItem } from "./Menu";
import { CLAUDE_MODELS, PERMISSION_MODES } from "./models";

let codexCache: Promise<CodexModelInfo> | null = null;
/** Codex's model list + defaults (read once per app run). */
export function useCodexModels(): CodexModelInfo | null {
  const [info, setInfo] = useState<CodexModelInfo | null>(null);
  useEffect(() => {
    codexCache ??= hub().codexModels();
    void codexCache.then(setInfo);
  }, []);
  return info;
}

export function codexModelName(info: CodexModelInfo | null, slug?: string | null): string {
  if (!slug) return info?.defaultModel ? `${info.defaultModel}` : "default";
  return info?.models.find((m) => m.slug === slug)?.slug ?? slug;
}

/** Model picker items, shared by the top bar and the composer. */
export function modelMenuItems(
  engine: Engine,
  model: string | null | undefined,
  onModel: (m: string | null) => void,
  codex?: CodexModelInfo | null,
): MenuItem[] {
  const items: MenuItem[] =
    engine === "claude"
      ? CLAUDE_MODELS.map((m) => ({ label: m.label, hint: m.id ?? "", checked: (model ?? null) === m.id, onSelect: () => onModel(m.id) }))
      : [
          { label: `Default${codex?.defaultModel ? ` (${codex.defaultModel})` : ""}`, hint: "from ~/.codex/config.toml", checked: !model, onSelect: () => onModel(null) },
          ...(codex?.models ?? []).map((m) => ({ label: m.name, hint: m.slug, checked: model === m.slug, onSelect: () => onModel(m.slug) })),
        ];
  items.push({ type: "separator" }, { type: "input", placeholder: "Other model id…", onSubmit: (v) => onModel(v) });
  return items;
}

export function permissionMenuItems(mode: ClaudePermissionMode | undefined, onMode: (m: ClaudePermissionMode) => void): MenuItem[] {
  return PERMISSION_MODES.map((m) => ({ label: m.label, checked: (mode ?? "default") === m.value, onSelect: () => onMode(m.value) }));
}

/** Reasoning-effort picker for Codex: the levels the selected (or default) model supports. */
export function effortMenuItems(
  codex: CodexModelInfo | null,
  model: string | null | undefined,
  effort: string | null | undefined,
  onEffort: (e: string | null) => void,
): MenuItem[] {
  const slug = model ?? codex?.defaultModel;
  const m = codex?.models.find((x) => x.slug === slug);
  const levels = m?.efforts.length ? m.efforts : ["low", "medium", "high", "xhigh"];
  return [
    { label: `Default${codex?.defaultEffort ? ` (${codex.defaultEffort})` : m?.defaultEffort ? ` (${m.defaultEffort})` : ""}`, checked: !effort, onSelect: () => onEffort(null) },
    ...levels.map((l) => ({ label: l, checked: effort === l, onSelect: () => onEffort(l) })),
  ];
}

export const effortLabel = (codex: CodexModelInfo | null, effort?: string | null) => effort ?? codex?.defaultEffort ?? "default";

export const SANDBOX_MODES: Array<{ value: CodexSandbox; label: string; short: string }> = [
  { value: "workspace-write", label: "Edit files (git read-only)", short: "write" },
  { value: "danger-full-access", label: "Full access (can commit, merge, push)", short: "full" },
  { value: "read-only", label: "Read only", short: "read" },
];
export const sandboxShort = (m?: CodexSandbox) => SANDBOX_MODES.find((x) => x.value === (m ?? "workspace-write"))!.short;
export function sandboxMenuItems(mode: CodexSandbox | undefined, onMode: (m: CodexSandbox) => void): MenuItem[] {
  return SANDBOX_MODES.map((m) => ({ label: m.label, checked: (mode ?? "workspace-write") === m.value, onSelect: () => onMode(m.value) }));
}

let cursorCache: Promise<Array<{ id: string; name: string }>> | null = null;
/** Cursor's model list (from its CLI), read once per app run. */
export function useCursorModels(): Array<{ id: string; name: string }> | null {
  const [list, setList] = useState<Array<{ id: string; name: string }> | null>(null);
  useEffect(() => {
    cursorCache ??= hub().cursorModels();
    void cursorCache.then(setList);
  }, []);
  return list;
}

export function cursorModelItems(models: Array<{ id: string; name: string }> | null, model: string | null | undefined, onModel: (m: string | null) => void): MenuItem[] {
  return [
    { label: "Auto", hint: "Cursor picks", checked: !model || model === "auto", onSelect: () => onModel(null) },
    ...(models ?? []).filter((m) => m.id !== "auto").map((m) => ({ label: m.name, hint: m.id, checked: model === m.id, onSelect: () => onModel(m.id) })),
    { type: "separator" },
    { type: "input", placeholder: "Other model id…", onSubmit: (v) => onModel(v) },
  ];
}

export const CURSOR_MODES: Array<{ value: CursorMode; label: string; short: string }> = [
  { value: "full", label: "Run everything (--force)", short: "full" },
  { value: "default", label: "Default (risky commands blocked)", short: "default" },
  { value: "plan", label: "Plan only (read-only)", short: "plan" },
  { value: "ask", label: "Ask (read-only Q&A)", short: "ask" },
];
export const cursorModeShort = (m?: CursorMode) => CURSOR_MODES.find((x) => x.value === (m ?? "full"))!.short;
export function cursorModeItems(mode: CursorMode | undefined, onMode: (m: CursorMode) => void): MenuItem[] {
  return CURSOR_MODES.map((m) => ({ label: m.label, checked: (mode ?? "full") === m.value, onSelect: () => onMode(m.value) }));
}
