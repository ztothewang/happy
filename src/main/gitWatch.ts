import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeployBoard, DeployComponent, GitInfo, McpPackage, ProjectConfig, TenantDeploy } from "../shared/types.js";
import { envForTag, envOrder, projectConfig } from "./projectConfig.js";

const run = promisify(execFile);
const git = async (cwd: string, args: string[], timeout = 8000) =>
  (await run("git", args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const ok = async (cwd: string, args: string[]) => {
  try {
    await run("git", args, { cwd, timeout: 8000 });
    return true;
  } catch {
    return false;
  }
};

const FETCH_EVERY_MS = 5 * 60_000;
/** npm packages published from folders in the repo (from the project config). */
const packageDirs = (cfg: ProjectConfig) => (cfg.packages ?? []).map((p) => p.dir.replace(/\/+$/, ""));
/** Files that don't change what gets published: tests, docs, Markdown, changelogs. */
const NOT_SHIPPED = /(^|\/)(tests?|__tests__|docs?|examples?)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.md$/i;
/** The same, as git pathspecs under a package folder. */
const notShipped = (dir: string) => [`:!${dir}/**/*.md`, `:!${dir}/*.md`, `:!${dir}/test/**`, `:!${dir}/tests/**`, `:!${dir}/**/__tests__/**`, `:!${dir}/docs/**`, `:!${dir}/**/*.test.*`, `:!${dir}/**/*.spec.*`];
const npmCache = new Map<string, { at: number; version?: string }>();
/** Latest version on npm (cached 10 min; undefined when offline or unknown). */
async function npmVersion(name: string): Promise<string | undefined> {
  const c = npmCache.get(name);
  if (c && Date.now() - c.at < 10 * 60_000) return c.version;
  const v = await run("npm", ["view", name, "version"], { timeout: 15_000 }).then((r) => r.stdout.trim() || undefined, () => c?.version);
  npmCache.set(name, { at: Date.now(), version: v });
  return v;
}
const newer = (a: string, b?: string) => {
  if (!b) return false;
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
/**
 * Deploy tags, from the project config: `<prefix>-[<env tag>-]<component|full>-<YYYYMMDD-HHMMSS>-<sha>`.
 * A full deploy counts for every component. Tags whose environment isn't configured are ignored.
 */
function deployModel(cfg: ProjectConfig) {
  const comps = cfg.deploy?.components ?? [];
  if (!comps.length || !cfg.environments?.length) return undefined;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = cfg.deploy?.tagPrefix ?? "deployed";
  const re = new RegExp(`^${esc(prefix)}-(?:(.+?)-)?(${[...comps.map((c) => c.id), "full"].map(esc).join("|")})-(\\d{8}-\\d{6})-([0-9a-f]+)$`);
  /** Latest sha + timestamp per env id and component (full spread over every component too). */
  const parse = (tags: string[]) => {
    const best = new Map<string, Map<string, { ts: string; sha: string }>>();
    for (const t of tags) {
      const m = t.match(re);
      if (!m) continue;
      const env = envForTag(cfg, m[1] ?? "");
      if (!env) continue;
      const per = best.get(env.id) ?? new Map();
      for (const comp of m[2] === "full" ? [...comps.map((c) => c.id), "full"] : [m[2]]) {
        const prev = per.get(comp);
        if (!prev || m[3] > prev.ts) per.set(comp, { ts: m[3], sha: m[4] });
      }
      best.set(env.id, per);
    }
    return best;
  };
  return { prefix, comps, parse, paths: (id: string) => (id === "full" ? [".", ...(cfg.deploy?.fullIgnore ?? ["docs", "*.md"]).map((p) => `:!${p}`)] : (comps.find((c) => c.id === id)?.paths ?? [])) };
}

interface RepoCache {
  fetchedAt: number;
  fetching?: Promise<void>;
  /** environment id → component id (or "full") → sha of the latest deploy tag */
  latest: Map<string, Record<string, string>>;
  mainRef: string;
}

/**
 * Computes branch + deploy state for session working directories using plain git:
 * uncommitted files, ahead/behind the main branch, merged-ness, and whether HEAD is
 * contained in each tenant's latest deployed-* tag (backend / frontend).
 */
export class GitWatch {
  private repos = new Map<string, RepoCache>();

  private async repo(root: string): Promise<RepoCache> {
    let r = this.repos.get(root);
    if (!r) {
      r = { fetchedAt: 0, latest: new Map(), mainRef: "origin/main" };
      this.repos.set(root, r);
    }
    if (Date.now() - r.fetchedAt > FETCH_EVERY_MS && !r.fetching) {
      r.fetching = this.refreshRepo(root, r).finally(() => (r!.fetching = undefined));
    }
    if (!r.fetchedAt && r.fetching) await r.fetching; // first time: wait so we have tags
    return r;
  }

  private async refreshRepo(root: string, r: RepoCache) {
    try {
      await git(root, ["fetch", "--quiet", "--tags", "origin"], 60_000);
    } catch {
      /* offline: use what we have */
    }
    try {
      const head = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "origin/main");
      r.mainRef = head || "origin/main";
      r.latest = new Map();
      const model = deployModel(projectConfig(root));
      if (model) {
        const tags = (await git(root, ["tag", "-l", `${model.prefix}-*`])).split("\n");
        for (const [env, per] of model.parse(tags)) r.latest.set(env, Object.fromEntries([...per].map(([c, v]) => [c, v.sha])));
      }
    } catch {
      /* not a repo with deploy tags */
    }
    r.fetchedAt = Date.now();
  }

  /** Re-read tags and refs now (after a deploy). */
  async refresh(root: string) {
    const r = this.repos.get(root);
    if (r) {
      r.fetchedAt = 0;
      await this.repo(root);
      await r.fetching;
    }
  }

  /**
   * Per tenant: the latest backend / frontend / db deploy tags and how many commits on main since then touch each
   * (db = Alembic migrations). "full" deploys count for all three.
   */
  async deployBoard(root: string): Promise<DeployBoard | undefined> {
    const cfg = projectConfig(root);
    const model = deployModel(cfg);
    const repo = await this.repo(root);
    const best = new Map<string, Map<string, { ts: string; sha: string }>>();
    if (model) {
      try {
        for (const [k, v] of model.parse((await git(root, ["tag", "-l", `${model.prefix}-*`])).split("\n"))) best.set(k, v);
      } catch {}
    }
    const mcp = await this.packageBoard(root, cfg, repo.mainRef);
    if (!model || (!best.size && !mcp.length)) return mcp.length ? { mainRef: repo.mainRef, components: [], commands: {}, colors: {}, tenants: [], mcp, unpushed: 0 } : undefined;
    const at = (ts: string) => new Date(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`).getTime();
    const behindSince = async (sha: string, comp: string) => {
      const range = `${sha}..${repo.mainRef}`;
      const [count, log] = await Promise.all([
        git(root, ["rev-list", "--count", range, "--", ...model.paths(comp)]).catch(() => "0"),
        git(root, ["log", "--format=%h %s", "-8", range, "--", ...model.paths(comp)]).catch(() => ""),
      ]);
      return { behind: Number(count) || 0, pending: log ? log.split("\n") : [] };
    };
    const byEnv = new Map<string, TenantDeploy>();
    await Promise.all(
      [...best].flatMap(([env, per]) =>
        [...per].map(async ([comp, v]) => {
          const c: DeployComponent = { sha: v.sha, at: at(v.ts), ...(await behindSince(v.sha, comp)) };
          const entry = byEnv.get(env) ?? { tenant: env, parts: {} };
          if (comp === "full") entry.full = c;
          else entry.parts[comp] = c;
          byEnv.set(env, entry);
        }),
      ),
    );
    // A full deploy covers every component: measure each against the full deploy too and keep whichever leaves it
    // less behind, so a ✓ under full always means ✓ for the others.
    await Promise.all(
      [...byEnv.values()].flatMap((t) =>
        !t.full
          ? []
          : model.comps.map(async ({ id }) => {
              const comp = t.parts[id];
              if (comp && comp.sha === t.full!.sha) return;
              const b = await behindSince(t.full!.sha, id);
              if (!comp || b.behind < comp.behind) t.parts[id] = { sha: t.full!.sha, at: t.full!.at, ...b };
            }),
      ),
    );
    const mainName = repo.mainRef.replace(/^origin\//, "");
    const unpushed = Number(await git(root, ["rev-list", "--count", `${repo.mainRef}..${mainName}`]).catch(() => "0")) || 0;
    const order = envOrder(cfg);
    const envs = cfg.environments ?? [];
    const fill = (cmd: string, e: (typeof envs)[number]) => cmd.replace(/\{env\}/g, e.id).replace(/\{envFile\}/g, e.envFile ?? "").replace(/\{tag\}/g, e.tag ?? e.id);
    const commands = Object.fromEntries(envs.map((e) => [e.id, Object.fromEntries(Object.entries({ ...cfg.deploy?.commands, ...e.commands }).map(([k, v]) => [k, fill(v, e)]))]));
    return {
      mainRef: repo.mainRef,
      components: model.comps.map((c) => ({ id: c.id, short: c.short ?? c.id, label: c.label ?? c.id })),
      commands,
      colors: Object.fromEntries(envs.filter((e) => e.color).map((e) => [e.id, e.color!])),
      mcp,
      tenants: [...byEnv.values()].sort((a, b) => order(a.tenant) - order(b.tenant)),
      unpushed,
    };
  }

  /** Published packages: version on main vs npm, and changes since the last version bump. */
  private async packageBoard(root: string, cfg: ProjectConfig, mainRef: string): Promise<McpPackage[]> {
    const out: McpPackage[] = [];
    for (const dir of packageDirs(cfg)) {
      const pkg = await git(root, ["show", `${mainRef}:${dir}/package.json`]).catch(() => "");
      if (!pkg) continue;
      const { name, version } = JSON.parse(pkg) as { name: string; version: string };
      // The last commit that changed the version (not just package.json: a dependency bump doesn't count).
      const bump = (await git(root, ["log", "-1", "--format=%H", "-G", '"version"', mainRef, "--", `${dir}/package.json`]).catch(() => "")) || (await git(root, ["log", "-1", "--format=%H", mainRef, "--", `${dir}/package.json`]).catch(() => ""));
      const unbumped = bump ? Number(await git(root, ["rev-list", "--count", `${bump}..${mainRef}`, "--", dir, `:!${dir}/package.json`, ...notShipped(dir)]).catch(() => "0")) || 0 : 0;
      const npm = await npmVersion(name);
      out.push({ name, dir, main: version, npm, unpublished: newer(version, npm), unbumped });
    }
    return out;
  }

  /** All worktrees of the repo containing cwd (main checkout first). */
  async worktrees(cwd: string): Promise<{ root: string; list: Array<{ path: string; branch?: string; head?: string }> } | null> {
    try {
      const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const root = common.replace(/\/\.git\/?$/, "");
      const out = await git(root, ["worktree", "list", "--porcelain"]);
      const list: Array<{ path: string; branch?: string; head?: string }> = [];
      let cur: { path: string; branch?: string; head?: string } | null = null;
      for (const line of out.split("\n")) {
        if (line.startsWith("worktree ")) list.push((cur = { path: line.slice(9) }));
        else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
        else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
      }
      return { root, list };
    } catch {
      return null;
    }
  }

  /** The remote main ref (e.g. origin/main) for the repo containing cwd. */
  async mainRefFor(cwd: string): Promise<string> {
    try {
      const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
      return (await this.repo(root)).mainRef;
    } catch {
      return "origin/main";
    }
  }

  /** Where a branch forked from main (used as the base for worktrees we didn't create). */
  async forkPoint(cwd: string): Promise<string | undefined> {
    try {
      const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
      const repo = await this.repo(root);
      return await git(cwd, ["merge-base", "HEAD", repo.mainRef]);
    } catch {
      return undefined;
    }
  }

  /**
   * A component is deployed when every commit in HEAD's history that touches its directory is contained in the
   * deploy: `git log ^<deployed> HEAD -- <dir>` is empty. (Commits that only touch the other side don't count.)
   */
  private async componentDeployed(cwd: string, deployedSha: string, paths: string[]): Promise<boolean> {
    try {
      const out = await git(cwd, ["log", "--format=%H", "-1", `^${deployedSha}`, "HEAD", "--", ...paths]);
      return out === "";
    } catch {
      return false;
    }
  }

  async check(cwd: string, prev?: GitInfo, baselineDirty?: string[], baseSha?: string): Promise<GitInfo | undefined> {
    let root: string;
    try {
      root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    } catch {
      return undefined; // not a git repo
    }
    const repo = await this.repo(root);
    const cfg = projectConfig(root);
    const model = deployModel(cfg);
    const [branch, status, head, headTime] = await Promise.all([
      git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      git(cwd, ["status", "--porcelain"]).catch(() => ""),
      git(cwd, ["rev-parse", "HEAD"]).catch(() => ""),
      git(cwd, ["log", "-1", "--format=%ct"]).then((t) => Number(t) * 1000).catch(() => undefined),
    ]);
    const mainName = repo.mainRef.replace(/^origin\//, "");
    const onMain = branch === mainName;

    // Branches compare against local main when it's at least as new as origin's (merged locally but not pushed
    // yet still counts as merged); the main checkout itself compares against origin, so unpushed commits show.
    let ref = repo.mainRef;
    if (!onMain && (await ok(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${mainName}`])) && (await ok(cwd, ["merge-base", "--is-ancestor", repo.mainRef, mainName])))
      ref = mainName;
    let ahead = 0;
    let behind = 0;
    try {
      const [b, a] = (await git(cwd, ["rev-list", "--left-right", "--count", `${ref}...HEAD`])).split(/\s+/).map(Number);
      ahead = a || 0;
      behind = b || 0;
    } catch {}
    // Merged: the branch did its own work and all of it is now in main. "Did work" = HEAD moved past the
    // commit the worktree started at (known for worktrees we created), else seen ahead of main earlier, else
    // (unknown history) main has moved past it.
    const hadWork =
      !onMain &&
      (baseSha ? !!head && !head.startsWith(baseSha) && !baseSha.startsWith(head) : ahead > 0 || (!!prev?.hadWork && prev.branch === branch));
    const base = new Set(baselineDirty ?? []);
    const dirty = status ? status.split("\n").filter((l) => l && !base.has(l.slice(3))).length : 0;
    const merged =
      !onMain && !!head && ahead === 0 && dirty === 0 && (hadWork || (!baseSha && behind > 0)) &&
      (await ok(cwd, ["merge-base", "--is-ancestor", "HEAD", ref]));

    const deploys: GitInfo["deploys"] = [];
    // Only components this branch actually changed count toward its deploy state (a frontend-only branch is
    // never "deployed" on backend just because the backend had nothing of it to deploy). Branch point: the
    // worktree's start commit, else where it forked from main.
    let touched: string[] | undefined;
    let branchBase = "";
    let touchedFiles: string[] | undefined;
    if (head && !onMain) {
      // The commit the branch was created at: Happy's record, else the oldest entry in the branch's own reflog
      // (still right after it's merged, unlike merge-base), else where it forked from main.
      const created = branch ? (await git(cwd, ["reflog", "show", "--format=%H", branch]).catch(() => "")).split("\n").filter(Boolean).pop() : "";
      const base = baseSha || created || (await git(cwd, ["merge-base", "--fork-point", mainName, "HEAD"]).catch(() => ""));
      branchBase = base;
      if (base) {
        const files = (await git(cwd, ["diff", "--name-only", `${base}..HEAD`]).catch(() => "")).split("\n").filter(Boolean);
        touchedFiles = files;
        touched = (model?.comps ?? []).filter((c) => files.some((f) => c.paths.some((p) => f.startsWith(p.replace(/^\.\/?/, ""))))).map((c) => c.id);
      }
    }
    // MCPs this branch changed: is its version bumped, and is that version on npm yet?
    let mcp: GitInfo["mcp"];
    if (head && !onMain && touchedFiles) {
      mcp = [];
      for (const dir of packageDirs(cfg)) {
        // Only changes that ship: tests, docs and Markdown don't need a new version.
        if (!touchedFiles.some((f) => f.startsWith(`${dir}/`) && f !== `${dir}/package.json` && !NOT_SHIPPED.test(f.slice(dir.length + 1)))) continue;
        const pkg = await git(cwd, ["show", `HEAD:${dir}/package.json`]).catch(() => "");
        if (!pkg) continue;
        const { name, version } = JSON.parse(pkg) as { name: string; version: string };
        // Bumped = the version is higher than where the branch started (a dependency change alone isn't a bump).
        const before = await git(cwd, ["show", `${branchBase}:${dir}/package.json`]).then((t) => (JSON.parse(t) as { version?: string }).version, () => undefined);
        const bumped = before ? newer(version, before) : touchedFiles.includes(`${dir}/package.json`);
        const npm = await npmVersion(name);
        mcp.push({ name, state: !bumped ? "unbumped" : newer(version, npm) ? "unpublished" : "published" });
      }
      if (!mcp.length) mcp = undefined;
    }
    if (head && model) {
      const order = envOrder(cfg);
      for (const [tenant, comps] of [...repo.latest.entries()].sort((a, b) => order(a[0]) - order(b[0]))) {
        const d: NonNullable<GitInfo["deploys"]>[number] = { tenant, parts: {}, touched };
        for (const c of touched ?? model.comps.map((x) => x.id)) {
          const sha = comps[c];
          if (sha) d.parts[c] = await this.componentDeployed(cwd, sha, model.paths(c));
        }
        if (comps.full) d.full = await ok(cwd, ["merge-base", "--is-ancestor", "HEAD", comps.full]);
        deploys.push(d);
      }
    }

    return {
      branch: branch || undefined,
      head: head ? head.slice(0, 10) : undefined,
      headTime,
      dirty,
      ahead,
      behind,
      onMain,
      merged,
      hadWork,
      deploys: deploys.length ? deploys : undefined,
      deployComponents: model?.comps.map((c) => ({ id: c.id, short: c.short ?? c.id })),
      mcp,
      checkedAt: Date.now(),
    };
  }
}

