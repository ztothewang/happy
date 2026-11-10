import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectConfig, ProjectEnvironment } from "../shared/types.js";

/**
 * Per-repo settings in `.happy/config.json` (checked into the repo, shared by everyone who uses Happy on it):
 * the environments you deploy to, how deploys are tagged and run, packages you publish, and a glossary for chat
 * titles. Everything is optional; a repo without the file gets the generic features only (chats, worktrees,
 * merged/ahead state, stats). See docs/project-config.md.
 */
export const CONFIG_PATH = ".happy/config.json";

const cache = new Map<string, { mtime: number; cfg: ProjectConfig }>();

/** Your own configs, for repos you'd rather not commit one to: <userData>/projects/<repo folder name>.json. */
let userDir = "";
export const setUserConfigDir = (dir: string) => void (userDir = dir);

/** A worktree's main checkout (its .git is a file pointing into <main>/.git/worktrees/<name>). */
function mainCheckout(root: string): string {
  try {
    const git = join(root, ".git");
    if (statSync(git).isFile()) {
      const dir = readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      const m = dir?.match(/^(.*)\/\.git\/worktrees\/[^/]+$/);
      if (m) return m[1];
    }
  } catch {}
  return root;
}

/** First match: the checkout's own .happy/config.json, the main checkout's, then yours in Happy's data folder. */
export function configFile(repo: string): string | undefined {
  const main = mainCheckout(repo);
  const candidates = [join(repo, CONFIG_PATH), join(main, CONFIG_PATH), userDir && join(userDir, "projects", `${basename(main)}.json`)];
  return candidates.find((f) => f && existsSync(f)) || undefined;
}

export function projectConfig(repo: string | undefined): ProjectConfig {
  if (!repo) return {};
  const file = configFile(repo);
  if (!file) return {};
  try {
    const mtime = statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.cfg;
    const cfg = JSON.parse(readFileSync(file, "utf8")) as ProjectConfig;
    cache.set(file, { mtime, cfg });
    return cfg;
  } catch (e) {
    console.warn(`[happy] couldn't read ${file}: ${(e as Error).message}`);
    return {};
  }
}

/** The environment a deploy tag's environment segment refers to ("" = the default environment). */
export function envForTag(cfg: ProjectConfig, segment: string): ProjectEnvironment | undefined {
  const envs = cfg.environments ?? [];
  return envs.find((e) => (e.tag ?? e.id) === segment || e.aliases?.includes(segment)) ?? (segment === "" ? envs.find((e) => e.tag === "") ?? envs[0] : undefined);
}

/** Environment ids in configured order (for sorting). */
export const envOrder = (cfg: ProjectConfig) => (id: string) => {
  const i = (cfg.environments ?? []).findIndex((e) => e.id === id);
  return i < 0 ? 99 : i;
};

/** "Production (prod), Europe (eu)": for prompts that need to know the environment names. */
export const envNames = (cfg: ProjectConfig) => (cfg.environments ?? []).map((e) => (e.name && e.name !== e.id ? `${e.name} (${e.id})` : e.id)).join(", ");
