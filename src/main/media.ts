import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { DirEntry, FileContent, GitChange, ResolvedLink } from "../shared/types.js";

const run = promisify(execFile);
const MAX_TEXT = 2 * 1024 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"]);
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** Stores images produced by tools / pasted by the user so transcripts reference small paths, not base64. */
export class MediaStore {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "media");
    mkdirSync(this.dir, { recursive: true });
  }

  save(data: Buffer | string, mime = "image/png"): string {
    const buf = typeof data === "string" ? Buffer.from(data, "base64") : data;
    const path = join(this.dir, `${randomUUID()}${MIME_EXT[mime] ?? ".png"}`);
    writeFileSync(path, buf);
    return path;
  }

  saveDataUrl(dataUrl: string): string {
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
    if (!m) throw new Error("Not a base64 data URL");
    return this.save(m[2], m[1]);
  }
}

export const mimeFor = (path: string) => {
  const e = extname(path).toLowerCase();
  return e === ".jpg" || e === ".jpeg" ? "image/jpeg" : e === ".gif" ? "image/gif" : e === ".webp" ? "image/webp" : "image/png";
};

export async function readFileForPreview(path: string): Promise<FileContent> {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { kind: "missing" };
    size = st.size;
  } catch {
    return { kind: "missing" };
  }
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXT.has(ext)) return { kind: "image", size };
  if (ext === ".pdf") return { kind: "pdf", size };
  if (size > MAX_TEXT) return { kind: "too_large", size };
  const fh = await open(path, "r");
  try {
    const buf = await fh.readFile();
    // Heuristic: NUL bytes in the first 8KB → binary.
    if (buf.subarray(0, 8192).includes(0)) return { kind: "binary", size };
    return { kind: "text", text: buf.toString("utf8"), size };
  } finally {
    await fh.close();
  }
}

/** Working-tree diff for one file (falls back to showing it as new if untracked). */
export async function gitDiff(cwd: string, path: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["diff", "HEAD", "--", path], { cwd, maxBuffer: 8 * 1024 * 1024 });
    if (stdout.trim()) return stdout;
    const { stdout: untracked } = await run("git", ["ls-files", "--others", "--exclude-standard", "--", path], { cwd });
    if (untracked.trim()) {
      const r = await run("git", ["diff", "--no-index", "--", "/dev/null", path], { cwd, maxBuffer: 8 * 1024 * 1024 }).catch(
        (e) => ({ stdout: e.stdout as string }),
      );
      return r.stdout;
    }
    return "";
  } catch (e) {
    return `(git diff unavailable: ${(e as Error).message.split("\n")[0]})`;
  }
}

/** Uncommitted changes in a repo: status + line counts per file. */
export async function gitChanges(cwd: string): Promise<GitChange[]> {
  try {
    const [{ stdout: status }, { stdout: numstat }, { stdout: top }] = await Promise.all([
      run("git", ["status", "--porcelain=v1", "-uall"], { cwd, maxBuffer: 8 * 1024 * 1024 }),
      run("git", ["diff", "--numstat", "HEAD"], { cwd, maxBuffer: 8 * 1024 * 1024 }),
      run("git", ["rev-parse", "--show-toplevel"], { cwd }),
    ]);
    const root = top.trim();
    const counts = new Map<string, [number, number]>();
    for (const line of numstat.split("\n")) {
      const [a, d, ...rest] = line.split("\t");
      if (rest.length) counts.set(rest.join("\t").replace(/^.* => /, ""), [Number(a) || 0, Number(d) || 0]);
    }
    const out: GitChange[] = [];
    for (const line of status.split("\n")) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const rel = line.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "");
      const st: GitChange["status"] = code === "??" ? "?" : code.includes("A") ? "A" : code.includes("D") ? "D" : code.includes("R") ? "R" : "M";
      let [add, del] = counts.get(rel) ?? [0, 0];
      if (st === "?") {
        try {
          const { stdout } = await run("wc", ["-l", rel], { cwd: root });
          add = Number(stdout.trim().split(/\s+/)[0]) || 0;
        } catch {}
      }
      out.push({ path: join(root, rel), rel, status: st, add, del });
    }
    return out.slice(0, 300);
  } catch {
    return [];
  }
}

const isImg = (p: string) => IMAGE_EXT.has(extname(p).toLowerCase());

function statKind(p: string): "file" | "dir" | null {
  try {
    const st = statSync(p);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a path an agent mentioned: absolute, ~/, or relative to any of the session's folders (its cwd,
 * linked worktrees, the repo root). If still not found, look for a unique tracked file ending in that path.
 */
export async function resolveLink(raw: string, roots: string[], hints: (name: string) => string[] = () => []): Promise<ResolvedLink> {
  let p = raw.trim().replace(/^file:\/\//, "");
  let line: number | undefined;
  const anchor = p.match(/^(.*?)#L(\d+)(?:-L?\d+)?$/);
  if (anchor) {
    p = anchor[1];
    line = Number(anchor[2]);
  }
  const m = p.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (m) {
    p = m[1];
    line = Number(m[2]);
  }
  p = decodeURIComponent(p).replace(/\/+$/, "") || p;
  const home = process.env.HOME ?? "";
  const candidates = p.startsWith("/") ? [p] : p.startsWith("~/") ? [join(home, p.slice(2))] : roots.map((r) => join(r, p.replace(/^\.\//, "")));
  for (const c of candidates) {
    const k = statKind(c);
    if (k === "dir") return { path: c, kind: "dir" };
    if (k === "file") return { path: c, kind: isImg(c) ? "image" : "file", line };
  }
  // Suffix match among tracked files (e.g. "src/App.tsx" written from inside frontend/).
  if (!p.startsWith("/") && roots.length) {
    try {
      const { stdout } = await run("git", ["ls-files", "--full-name", `*${p.replace(/^\.\//, "")}`], { cwd: roots[0], maxBuffer: 8 * 1024 * 1024 });
      const top = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: roots[0] })).stdout.trim();
      const hits = stdout.split("\n").filter((f) => f && (f === p || f.endsWith(`/${p.replace(/^\.\//, "")}`)));
      if (hits.length === 1) {
        const abs = join(top, hits[0]);
        return { path: abs, kind: isImg(abs) ? "image" : "file", line };
      }
    } catch {}
  }
  // A bare or partial name ("Report.pdf") for a file outside git (outputs, downloads): look for it where the agent
  // mentioned its full path, then search the session's folders (skipping dependency dirs); take the newest match.
  if (!p.startsWith("/") && !p.startsWith("~/")) {
    const tail = `/${p.replace(/^\.\//, "")}`;
    const fromChat = hints(basename(p)).filter((h) => h.endsWith(tail) && statKind(h) === "file");
    let found = fromChat.at(-1);
    if (!found) {
      const hits = new Set<string>();
      for (const r of roots)
        try {
          const { stdout } = await run(
            "find",
            [r, "(", ...["node_modules", ".git", ".venv", "venv", "__pycache__", ".next"].flatMap((d, i) => (i ? ["-o", "-name", d] : ["-name", d])), ")", "-prune", "-o", "-type", "f", "-name", basename(p), "-print"],
            { maxBuffer: 4 * 1024 * 1024, timeout: 4000 },
          );
          stdout.split("\n").forEach((f) => f.endsWith(tail) && !f.includes("/node_modules/") && hits.add(f));
        } catch {}
      found = [...hits].filter((f) => statKind(f) === "file").sort((a, b) => mtime(b) - mtime(a))[0];
    }
    if (found) return { path: found, kind: isImg(found) ? "image" : "file", line };
  }
  return { path: candidates[0] ?? p, kind: "missing", line };
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Folder listing for the side pane (folders first, hides .git and node_modules). */
export function readDir(path: string): DirEntry[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.name !== ".git" && d.name !== "node_modules" && d.name !== ".DS_Store")
      .map((d) => ({ name: d.name, path: join(path, d.name), dir: d.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      .slice(0, 500);
  } catch {
    return [];
  }
}

/** Every file in a checkout that git would track (tracked + untracked, minus .gitignore), relative paths. */
export async function listFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
    return [...new Set(stdout.split("\n").filter(Boolean))].sort().slice(0, 50_000);
  } catch {
    return [];
  }
}
