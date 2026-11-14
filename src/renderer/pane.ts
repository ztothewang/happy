import { createContext, useContext } from "react";

export type PaneTab =
  | { key: string; kind: "file"; path: string; line?: number }
  | { key: string; kind: "diff"; path: string; before: string; after: string }
  | { key: string; kind: "gitdiff"; path: string; cwd: string }
  | { key: string; kind: "image"; path: string }
  | { key: "browser"; kind: "browser" }
  | { key: "changes"; kind: "changes" }
  | { key: "pins"; kind: "pins" }
  | { key: "terminal"; kind: "terminal" }
  | { key: "files"; kind: "files" }
  | { key: string; kind: "dir"; path: string };

export interface PaneState {
  open: boolean;
  tabs: PaneTab[];
  active?: string;
}

export type TabInput =
  | { kind: "file"; path: string; line?: number }
  | { kind: "diff"; path: string; before: string; after: string; id: string }
  | { kind: "gitdiff"; path: string; cwd: string }
  | { kind: "image"; path: string }
  | { kind: "browser" }
  | { kind: "changes" }
  | { kind: "pins" }
  | { kind: "terminal" }
  | { kind: "files" }
  | { kind: "dir"; path: string };

export function toTab(t: TabInput): PaneTab {
  switch (t.kind) {
    case "browser":
      return { key: "browser", kind: "browser" };
    case "changes":
      return { key: "changes", kind: "changes" };
    case "pins":
      return { key: "pins", kind: "pins" };
    case "terminal":
      return { key: "terminal", kind: "terminal" };
    case "files":
      return { key: "files", kind: "files" };
    case "diff":
      return { key: `diff:${t.id}`, kind: "diff", path: t.path, before: t.before, after: t.after };
    case "gitdiff":
      return { key: `gitdiff:${t.path}`, ...t };
    default:
      return { key: `${t.kind}:${t.path}`, ...t } as PaneTab;
  }
}

export interface PaneApi {
  open(t: TabInput): void;
  /** Open an http(s) URL in Chrome, or a file path in a file tab. */
  openLink(href: string): void;
  /** Open an http(s) URL in the session's browser tab inside Happy. */
  openInHappy?(href: string): void;
  /** Run a shell command in the session's terminal tab; its output goes back to the agent. */
  runCommand?(command: string): void;
}

export const PaneContext = createContext<PaneApi>({ open: () => {}, openLink: () => {} });
export const usePane = () => useContext(PaneContext);

/** Local files: the hubfile:// protocol on the desktop, the remote server's /hubfile/ route on the phone. */
/** A local file's URL; pass `v` (e.g. a reload count) to get a fresh copy instead of the cached one. */
export const fileUrl = (path: string, v?: number) =>
  ((window as { hub?: { isRemote?: boolean } }).hub?.isRemote ? `/hubfile/${encodeURIComponent(path)}` : `hubfile://local/${encodeURIComponent(path)}`) + (v ? `?v=${v}` : "");
export const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
export const isImagePath = (p: string) => IMAGE_RE.test(p);

/** Resolve a possibly-relative path (optionally with :line) against cwd. */
export function resolvePath(raw: string, cwd: string): { path: string; line?: number } {
  let p = raw.trim();
  let line: number | undefined;
  const m = p.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (m) {
    p = m[1];
    line = Number(m[2]);
  }
  if (p.startsWith("file://")) p = decodeURIComponent(p.slice(7));
  if (!p.startsWith("/")) {
    const parts = `${cwd}/${p}`.split("/");
    const out: string[] = [];
    for (const part of parts) {
      if (part === "..") out.pop();
      else if (part && part !== ".") out.push(part);
    }
    p = `/${out.join("/")}`;
  }
  return { path: p, line };
}

/** Does a string look like a file path worth linking (abs path, or relative with an extension)? */
export function looksLikePath(s: string): boolean {
  if (s.length > 300 || /\s/.test(s)) return false;
  // Path segments may include Next.js route chars: (group), [param], [...slug].
  if (/^(\/|~\/|\.\.?\/)[\w.@+()[\]-]/.test(s)) return true;
  if (/^[\w.@+()[\]-]+(\/[\w.@+()[\]-]+)*\/$/.test(s)) return true; // folder like frontend/ or backend/app/
  return /^[\w.@+()[\]-]+(\/[\w.@+()[\]-]+)*\.[a-z0-9]{1,8}((:\d+(:\d+)?)|(#L\d+(-L?\d+)?))?$/i.test(s) && !/^\d+(\.\d+)+$/.test(s);
}
