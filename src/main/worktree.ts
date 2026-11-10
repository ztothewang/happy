import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await run("git", args, { cwd, timeout: 60_000 })).stdout.trim();

export interface WorktreeInfo {
  path: string;
  branch: string;
  repo: string; // main checkout root
  /** Commit the branch started at; the branch "has work" only once HEAD moves past it. */
  baseSha?: string;
}

/** "Fix login 500 on staging!" → "fix-login-500-on-staging" */
export function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "session";
}

async function mainRoot(cwd: string): Promise<string> {
  const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return dirname(common);
}

async function branchExists(repo: string, branch: string) {
  try {
    await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a fresh branch + worktree for a session. Uses the repo's own scripts/new-worktree.sh when present
 * (it clones node_modules copy-on-write), otherwise plain `git worktree add` next to the repo.
 */
export async function createWorktree(cwd: string, title: string): Promise<WorktreeInfo> {
  const repo = await mainRoot(cwd);
  const base = branchSlug(title);
  let branch = base;
  for (let i = 2; (await branchExists(repo, branch)) || existsSync(defaultPath(repo, branch)); i++) branch = `${base}-${i}`;
  const path = defaultPath(repo, branch);

  const script = join(repo, "scripts", "new-worktree.sh");
  if (existsSync(script)) {
    await run("bash", [script, branch, path], { cwd: repo, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  } else {
    await git(repo, ["worktree", "add", path, "-b", branch]);
  }
  if (!existsSync(path)) throw new Error(`Worktree was not created at ${path}`);
  const baseSha = await git(path, ["rev-parse", "HEAD"]).catch(() => undefined);
  return { path, branch, repo, baseSha };
}

/** Matches scripts/new-worktree.sh's default: <repo-parent>/<prefix>-<branch> */
function defaultPath(repo: string, branch: string) {
  const prefix = basename(repo).replace(/\.ai$|\.git$/, "");
  return join(dirname(repo), `${prefix}-${branch.replace(/\//g, "-")}`);
}

/**
 * Remove a session's worktree and its branch — safely: git refuses if the worktree has uncommitted
 * changes, and `branch -d` refuses if the branch isn't merged. Never forces.
 */
export async function removeWorktree(wt: WorktreeInfo): Promise<{ branchDeleted: boolean }> {
  await git(wt.repo, ["worktree", "remove", wt.path]);
  try {
    await git(wt.repo, ["branch", "-d", wt.branch]);
    return { branchDeleted: true };
  } catch {
    return { branchDeleted: false };
  }
}

/** Files already dirty in a folder (porcelain paths), used as a baseline for sessions without their own worktree. */
export async function dirtyPaths(cwd: string): Promise<string[]> {
  try {
    return (await git(cwd, ["status", "--porcelain"]))
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3));
  } catch {
    return [];
  }
}
