import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSettings, TagDef } from "../shared/types.js";

export const DEFAULT_SETTINGS: AppSettings = {
  show: { manager: true, cloud: true, analytics: true, tasks: true, email: true, calendar: true, terminal: true },
  bypass: { sessions: true, tasks: true, manager: false, cloud: false, email: true },
  defaultEngine: "claude",
  models: {},
  helperModel: "claude-sonnet-5-5",
  remote: { enabled: false, keepAwake: true },
  /** Your main repo (Settings → General). Empty until you pick one. */
  repo: "",
  tags: [
    { name: "backfill", description: "The changes include a backfill script that still has to be run.", auto: true },
    { name: "migration", description: "The changes include a database migration that hasn't been applied yet.", auto: true },
    { name: "mcp", description: "The MCP server changed, and the new version still needs publishing to npm.", auto: true },
    { name: "qa", description: "A person needs to review or test this by hand.", auto: false },
  ],
  autoTags: true,
  nextSteps: true,
  profile: { name: "", email: "", company: "", signoff: "", style: "" },
};

let current: AppSettings = DEFAULT_SETTINGS;
let file = "";

function merge(raw: Partial<AppSettings>): AppSettings {
  return {
    show: { ...DEFAULT_SETTINGS.show, ...raw.show },
    bypass: { ...DEFAULT_SETTINGS.bypass, ...raw.bypass },
    defaultEngine: raw.defaultEngine ?? DEFAULT_SETTINGS.defaultEngine,
    models: { ...raw.models },
    helperModel: raw.helperModel || DEFAULT_SETTINGS.helperModel,
    remote: { ...DEFAULT_SETTINGS.remote, ...raw.remote },
    repo: raw.repo || DEFAULT_SETTINGS.repo,
    tags: Array.isArray(raw.tags)
      ? (raw.tags as Array<TagDef | string>).map((t) => (typeof t === "string" ? (DEFAULT_SETTINGS.tags.find((d) => d.name === t) ?? { name: t, description: "", auto: false }) : t))
      : DEFAULT_SETTINGS.tags,
    autoTags: raw.autoTags ?? DEFAULT_SETTINGS.autoTags,
    nextSteps: raw.nextSteps ?? DEFAULT_SETTINGS.nextSteps,
    profile: { ...DEFAULT_SETTINGS.profile, ...raw.profile },
    codexPrices: raw.codexPrices,
    codexPricesAt: raw.codexPricesAt,
    zoom: raw.zoom,
  };
}

export function loadSettings(dataDir: string): AppSettings {
  file = join(dataDir, "settings.json");
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      current = merge(raw);
    }
  } catch {
    current = DEFAULT_SETTINGS;
  }
  return current;
}

/** App-wide settings (sections shown, bypass per area, default engine/models, helper model). */
export const settings = () => current;

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  current = merge({ ...current, ...patch, show: { ...current.show, ...patch.show }, bypass: { ...current.bypass, ...patch.bypass }, models: { ...current.models, ...patch.models }, remote: { ...current.remote, ...patch.remote }, profile: { ...current.profile, ...patch.profile } });
  if (file) {
    writeFileSync(`${file}.tmp`, JSON.stringify(current, null, 2));
    renameSync(`${file}.tmp`, file);
  }
  return current;
}
