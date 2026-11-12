import { SheetView, isSheetPath } from "./SheetView";
import { num } from "./models";
import { TerminalPane } from "./TerminalView";
import { useMenu, type MenuItem } from "./Menu";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense, Fragment } from "react";
import type { BrowserMenu, BrowserState, DirEntry, FileContent, GitChange, TranscriptItem } from "../shared/types";
import { hub } from "./App";
import { diffLines, parseUnified, withContext, type DiffOp } from "./diff";
import { Markdown, highlight } from "./Markdown";
import { baseName, fileUrl, usePane, type PaneTab, isImagePath } from "./pane";

function tabLabel(t: PaneTab) {
  switch (t.kind) {
    case "browser":
      return "browser";
    case "changes":
      return "changes";
    case "dir":
      return `${baseName(t.path)}/`;
    case "diff":
      return `Δ ${baseName(t.path)}`;
    case "gitdiff":
      return `git Δ ${baseName(t.path)}`;
    case "pins":
      return "pinned";
    case "terminal":
      return "terminal";
    case "files":
      return "files";
    default:
      return baseName(t.path);
  }
}

/** The editor (CodeMirror) loads on first use, so it doesn't slow down startup. */
const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

const TAB_ICON: Record<PaneTab["kind"], string> = { browser: "◎", changes: "±", file: "", diff: "", gitdiff: "", image: "", dir: "", pins: "⚑", terminal: "›", files: "▤" };

export function PreviewPane(props: {
  sessionId: string;
  cwd: string;
  /** The session's transcript (for the Pinned tab). */
  items?: TranscriptItem[];
  tabs: PaneTab[];
  active?: string;
  browser?: BrowserState;
  hideNative: boolean;
  onActivate(key: string): void;
  onCloseTab(key: string): void;
  onClosePane(): void;
  onCloseAll(): void;
  /** Every checkout the chat works in: its folder and the worktrees it tracks. */
  checkouts?: Array<{ path: string; label: string }>;
}) {
  const active = props.tabs.find((t) => t.key === props.active) ?? props.tabs[0];
  const pane = usePane();
  const menu = useMenu();

  return (
    <div className="pane">
      <div className="pane-tabs">
        {props.tabs.map((t) => (
          <div
            key={t.key}
            className={`pane-tab ${t.key === active?.key ? "on" : ""}`}
            data-tab-kind={t.kind}
            onClick={() => props.onActivate(t.key)}
            onAuxClick={(e) => e.button === 1 && props.onCloseTab(t.key)}
            onContextMenu={(e) =>
              menu.atMouse(e, [
                { label: "Close", onSelect: () => props.onCloseTab(t.key) },
                { label: "Close others", onSelect: () => props.tabs.filter((x) => x.key !== t.key).forEach((x) => props.onCloseTab(x.key)) },
                { label: "Close all", onSelect: props.onCloseAll },
              ])
            }
            title={"path" in t ? t.path : props.browser?.url}
          >
            {TAB_ICON[t.kind] && <span className="tab-icon">{TAB_ICON[t.kind]}</span>}
            <span className="tab-label">{tabLabel(t)}</span>
            <button
              className="tab-x"
              onClick={(e) => {
                e.stopPropagation();
                props.onCloseTab(t.key);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <div className="pane-tab-actions">
          {!props.tabs.some((t) => t.kind === "changes") && (
            <button className="icon-btn" title="Uncommitted changes" onClick={() => pane.open({ kind: "changes" })}>
              ±
            </button>
          )}
          {!props.tabs.some((t) => t.kind === "files") && (
            <button className="icon-btn" title="Files in this chat's folder" onClick={() => pane.open({ kind: "files" })}>
              ▤
            </button>
          )}
          {!props.tabs.some((t) => t.kind === "terminal") && (
            <button className="icon-btn" title="Terminal in this chat's folder" onClick={() => pane.open({ kind: "terminal" })}>
              ›_
            </button>
          )}
          {!props.tabs.some((t) => t.kind === "browser") && (
            <button className="icon-btn" title="Open browser" onClick={() => pane.open({ kind: "browser" })}>
              ◎
            </button>
          )}
          <button
            className="icon-btn"
            title="Open file…"
            onClick={async () => {
              const p = await hub().pickFile(props.cwd);
              if (p) pane.openLink(p);
            }}
          >
            ＋
          </button>
          <button className="icon-btn" title="Close pane (⌘\)" onClick={props.onClosePane}>
            ⇥
          </button>
        </div>
      </div>
      <div className="pane-body">
        {!active && <div className="muted pad center">Click a file, image or link in the transcript to preview it here.</div>}
        {active?.kind === "browser" && (
          <BrowserView sessionId={props.sessionId} state={props.browser} hidden={props.hideNative} />
        )}
        {active?.kind === "file" && <FileView key={active.key} path={active.path} line={active.line} cwd={props.cwd} sessionId={props.sessionId} />}
        {active?.kind === "files" && <FilesView root={props.cwd} />}
        {active?.kind === "image" && <ImageView path={active.path} />}
        {active?.kind === "diff" && (
          <DiffView key={active.key} path={active.path} ops={diffLines(active.before, active.after)} isNew={active.before === ""} />
        )}
        {active?.kind === "gitdiff" && <GitDiffView key={active.key} path={active.path} cwd={active.cwd} />}
        {active?.kind === "changes" && <ChangesView roots={props.checkouts?.length ? props.checkouts : [{ path: props.cwd, label: "this folder" }]} />}
        {active?.kind === "terminal" && <TerminalPane key={props.sessionId} id={`s-${props.sessionId}`} cwd={props.cwd} />}
        {active?.kind === "pins" && <PinsView sessionId={props.sessionId} items={props.items ?? []} />}
        {active?.kind === "dir" && <DirView key={active.key} path={active.path} />}
      </div>
    </div>
  );
}

// ── browser ─────────────────────────────────────────────────────────
function BrowserView({ sessionId, state, hidden }: { sessionId: string; state?: BrowserState; hidden: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState(state?.url ?? "");
  const [editing, setEditing] = useState(false);
  const menu = useMenu();
  /** While a menu is open over the pane: a picture of the page, standing in for the native view (which would cover the menu). */
  const [shot, setShot] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setUrl(state?.url ?? "");
  }, [state?.url, editing]);

  useEffect(() => {
    let gen = 0;
    const on = (e: Event) => {
      const open = (e as CustomEvent<boolean>).detail;
      const my = ++gen;
      if (!open) return setShot(null);
      void hub()
        .browserSnapshot(sessionId)
        .then((url) => my === gen && setShot(url ?? "blank"));
    };
    window.addEventListener("happy:overlay", on);
    return () => window.removeEventListener("happy:overlay", on);
  }, [sessionId]);

  // Right-click in the page: Happy's own menu.
  useEffect(
    () =>
      hub().onBrowserMenu((m: BrowserMenu) => {
        if (m.sessionId !== sessionId) return;
        const edit = (a: Parameters<ReturnType<typeof hub>["browserEdit"]>[1]) => () => void hub().browserEdit(sessionId, a, m.pageX, m.pageY);
        const copy = (t: string) => () => void navigator.clipboard.writeText(t);
        const items: MenuItem[] = [];
        if (m.linkURL)
          items.push(
            { label: "Open link here", onSelect: () => void hub().browserNavigate(sessionId, m.linkURL) },
            { label: "Open link in Chrome", onSelect: () => void hub().openInChrome(m.linkURL) },
            { label: "Copy link", onSelect: copy(m.linkURL) },
            { type: "separator" },
          );
        if (m.mediaType === "image" && m.srcURL) items.push({ label: "Copy image address", onSelect: copy(m.srcURL) }, { type: "separator" });
        if (m.isEditable)
          items.push({ label: "Cut", onSelect: edit("cut") }, { label: "Copy", onSelect: edit("copy") }, { label: "Paste", onSelect: edit("paste") }, { label: "Select all", onSelect: edit("selectAll") }, { type: "separator" });
        else if (m.selectionText.trim()) items.push({ label: "Copy", onSelect: edit("copy") }, { type: "separator" });
        if (m.canGoBack) items.push({ label: "Back", onSelect: () => void hub().browserNav(sessionId, "back") });
        if (m.canGoForward) items.push({ label: "Forward", onSelect: () => void hub().browserNav(sessionId, "forward") });
        items.push(
          { label: "Reload", onSelect: () => void hub().browserNav(sessionId, "reload") },
          { type: "separator" },
          { label: "Copy page address", onSelect: copy(state?.url ?? "") },
          { label: "Open page in Chrome", onSelect: () => state?.url && void hub().openInChrome(state.url) },
          { label: "Inspect element", onSelect: edit("inspect") },
        );
        menu.at(m.x, m.y, items);
      }),
    [sessionId, state?.url],
  );

  useLayoutEffect(() => {
    const el = slot.current!;
    let last = "";
    const push = (force = true) => {
      if (hidden || shot) return void hub().browserSetBounds(sessionId, null);
      const r = el.getBoundingClientRect();
      const key = `${r.left},${r.top},${r.width},${r.height},${window.devicePixelRatio}`;
      if (!force && key === last) return;
      last = key;
      void hub().browserSetBounds(sessionId, { x: r.left, y: r.top, width: r.width, height: r.height });
    };
    push();
    const ro = new ResizeObserver(() => push());
    ro.observe(el);
    const onResize = () => push();
    window.addEventListener("resize", onResize);
    // The native view doesn't follow the page: catch moves that don't resize the slot (sidebar, panes, zoom).
    const poll = setInterval(() => push(false), 400);
    return () => {
      clearInterval(poll);
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      void hub().browserSetBounds(sessionId, null);
    };
  }, [sessionId, hidden, shot]);

  const go = () => {
    setEditing(false);
    if (url.trim()) void hub().browserNavigate(sessionId, url.trim());
  };

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="icon-btn" disabled={!state?.canGoBack} onClick={() => hub().browserNav(sessionId, "back")}>
          ‹
        </button>
        <button className="icon-btn" disabled={!state?.canGoForward} onClick={() => hub().browserNav(sessionId, "forward")}>
          ›
        </button>
        <button className="icon-btn" onClick={() => hub().browserNav(sessionId, state?.loading ? "stop" : "reload")}>
          {state?.loading ? "×" : "↻"}
        </button>
        <input
          className="url"
          value={url}
          placeholder="Enter a URL — the agent sees this same tab"
          onFocus={(e) => {
            setEditing(true);
            e.target.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
      </div>
      <div className="browser-slot" ref={slot}>
        {shot && shot !== "blank" && <img className="browser-shot" src={shot} alt="" />}
        {!state?.url && <div className="muted pad center">Blank tab. Type a URL, or ask the agent to open one.</div>}
      </div>
    </div>
  );
}

// ── files ───────────────────────────────────────────────────────────
function useFile(path: string, reloadKey = 0) {
  const [content, setContent] = useState<FileContent | null>(null);
  useEffect(() => {
    let live = true;
    setContent(null);
    hub()
      .readFile(path)
      .then((c) => live && setContent(c));
    return () => {
      live = false;
    };
  }, [path, reloadKey]);
  return content;
}

function FileHeader({ path, cwd, children, onReload }: { path: string; cwd?: string; children?: React.ReactNode; onReload?: () => void }) {
  const pane = usePane();
  const rel = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  return (
    <div className="file-head">
      <span className="file-path" title={path}>
        {rel}
      </span>
      <span className="file-actions">
        {children}
        {cwd && (
          <button className="link-btn" onClick={() => pane.open({ kind: "gitdiff", path, cwd })}>
            git diff
          </button>
        )}
        {onReload && (
          <button className="link-btn" onClick={onReload}>
            reload
          </button>
        )}
        <button className="link-btn" onClick={() => hub().revealFile(path)}>
          reveal
        </button>
      </span>
    </div>
  );
}

function FileView({ path, line, cwd, sessionId }: { path: string; line?: number; cwd: string; sessionId?: string }) {
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const c = useFile(path, reload);
  const isMd = /\.(md|markdown|mdx)$/i.test(path);
  const [rendered, setRendered] = useState(isMd);
  const isHtml = /\.html?$/i.test(path);
  const [htmlLive, setHtmlLive] = useState(true);
  const isSheet = isSheetPath(path);
  const isCsv = /\.(csv|tsv)$/i.test(path);
  const [asTable, setAsTable] = useState(true);
  const body = useRef<HTMLDivElement>(null);

  const html = useMemo(() => (c?.kind === "text" ? highlight(c.text, path) : null), [c, path]);

  useEffect(() => {
    if (!line || !body.current) return;
    body.current.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
  }, [c, line]);

  const header = (
    <FileHeader path={path} cwd={cwd} onReload={() => setReload((n) => n + 1)}>
      {c?.kind === "text" && sessionId && (
        <button className="link-btn" onClick={() => setEditing(!editing)} title={editing ? "Back to the read-only view" : "Edit this file here (⌘S saves)"}>
          {editing ? "done" : "edit"}
        </button>
      )}
      {isMd && c?.kind === "text" && (
        <button className="link-btn" onClick={() => setRendered(!rendered)}>
          {rendered ? "source" : "preview"}
        </button>
      )}
      {isHtml && c?.kind === "text" && (
        <button className="link-btn" onClick={() => setHtmlLive(!htmlLive)}>
          {htmlLive ? "source" : "preview"}
        </button>
      )}
      {isCsv && c?.kind === "text" && (
        <button className="link-btn" onClick={() => setAsTable(!asTable)}>
          {asTable ? "source" : "table"}
        </button>
      )}
      {c?.kind === "pdf" && (
        <button className="link-btn" onClick={() => void hub().openFile(path)} title="Open in Preview (zoom, print, save)">
          open
        </button>
      )}
    </FileHeader>
  );

  if (!c) return <div className="file">{header}</div>;
  if (editing && c.kind === "text")
    return (
      <div className="file">
        {header}
        <Suspense fallback={<div className="muted pad">loading editor…</div>}>
          <CodeEditor key={path} path={path} rel={cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path} initial={c.text} sessionId={sessionId} onSaved={() => setReload((n) => n + 1)} />
        </Suspense>
      </div>
    );
  if (c.kind === "image") return <ImageView path={path} />;
  // HTML (e.g. Codex's visualize previews): rendered in a sandboxed frame, with a source toggle.
  if (isHtml && htmlLive && c.kind === "text")
    return (
      <div className="file">
        {header}
        <iframe className="pdf html-frame" sandbox="allow-scripts" src={fileUrl(path)} title={path} />
      </div>
    );
  if (isSheet && (asTable || !isCsv || c.kind !== "text"))
    return (
      <div className="file">
        {header}
        <SheetView path={path} />
      </div>
    );
  if (c.kind === "pdf")
    return (
      <div className="file">
        {header}
        <iframe className="pdf" src={`${fileUrl(path)}#toolbar=0&navpanes=0&view=FitH`} title={path} />
      </div>
    );
  if (c.kind !== "text")
    return (
      <div className="file">
        {header}
        <div className="muted pad">
          {c.kind === "missing" ? "File not found." : c.kind === "too_large" ? `File too large to preview (${fmtSize(c.size)}).` : "Binary file."}
        </div>
      </div>
    );

  if (isMd && rendered)
    return (
      <div className="file">
        {header}
        <div className="file-body md-doc" ref={body}>
          <Markdown text={c.text} />
        </div>
      </div>
    );

  const lines = html ? splitHighlighted(html) : escape(c.text).split("\n");
  return (
    <div className="file">
      {header}
      <div className="file-body" ref={body}>
        <table className="code-table">
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} data-line={i + 1} className={line === i + 1 ? "hl" : ""}>
                <td className="ln">{i + 1}</td>
                <td className="lc hljs" dangerouslySetInnerHTML={{ __html: l || " " }} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ImageView({ path }: { path: string }) {
  const [fit, setFit] = useState(true);
  return (
    <div className="file">
      <FileHeader path={path}>
        <button className="link-btn" onClick={() => setFit(!fit)}>
          {fit ? "actual size" : "fit"}
        </button>
      </FileHeader>
      <div className={`image-body ${fit ? "fit" : ""}`}>
        <img src={fileUrl(path)} alt={path} />
      </div>
    </div>
  );
}

function DiffRows({ ops }: { ops: DiffOp[] }) {
  const rows = withContext(ops);
  if (!ops.some((o) => o.type !== "same")) return <div className="muted pad">No changes.</div>;
  return (
    <table className="code-table diff">
      <tbody>
        {rows.map((r, i) =>
          r.type === "gap" ? (
            <tr key={i} className="gap">
              <td className="ln" />
              <td className="ln" />
              <td className="lc">⋯ {num(r.count)} unchanged lines</td>
            </tr>
          ) : (
            <tr key={i} className={r.type}>
              <td className="ln">{r.a ?? ""}</td>
              <td className="ln">{r.b ?? ""}</td>
              <td className="lc">
                <span className="sign">{r.type === "add" ? "+" : r.type === "del" ? "−" : " "}</span>
                {r.text || " "}
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

function DiffView({ path, ops, isNew }: { path: string; ops: DiffOp[]; isNew: boolean }) {
  const pane = usePane();
  return (
    <div className="file">
      <FileHeader path={path}>
        {isNew && <span className="badge">new file</span>}
        <button className="link-btn" onClick={() => pane.open({ kind: "file", path })}>
          open file
        </button>
      </FileHeader>
      <div className="file-body">
        <DiffRows ops={ops} />
      </div>
    </div>
  );
}

/** Folder listing; click a folder to open it, a file to preview it. */
interface TreeNode {
  name: string;
  path: string;
  children?: Map<string, TreeNode>;
}

/** The chat's folder as a tree (what git sees: tracked + untracked, minus .gitignore), with a filter. */
function FilesView({ root }: { root: string }) {
  const pane = usePane();
  const [files, setFiles] = useState<string[] | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    setFiles(null);
    void hub().listFiles(root).then(setFiles);
  }, [root]);
  const tree = useMemo(() => {
    const top: TreeNode = { name: "", path: "", children: new Map() };
    for (const f of files ?? []) {
      let node = top;
      const parts = f.split("/");
      parts.forEach((p, i) => {
        const path = parts.slice(0, i + 1).join("/");
        if (i === parts.length - 1) node.children!.set(p, { name: p, path });
        else {
          if (!node.children!.has(p)) node.children!.set(p, { name: p, path, children: new Map() });
          node = node.children!.get(p)!;
        }
      });
    }
    return top;
  }, [files]);
  const openFile = (rel: string) => pane.open({ kind: "file", path: `${root}/${rel}` });
  const toggle = (p: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });
  const rows: React.ReactNode[] = [];
  const walk = (node: TreeNode, depth: number) => {
    const kids = [...node.children!.values()].sort((a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name));
    for (const k of kids) {
      const isDir = !!k.children;
      rows.push(
        <button key={k.path} className="dir-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => (isDir ? toggle(k.path) : openFile(k.path))}>
          <span className="dir-icon">{isDir ? (open.has(k.path) ? "▾" : "▸") : ""}</span>
          <span className={isDir ? "dir-name" : ""}>{k.name}</span>
        </button>,
      );
      if (isDir && open.has(k.path)) walk(k, depth + 1);
    }
  };
  const needle = q.trim().toLowerCase();
  const matches = needle && files ? files.filter((f) => f.toLowerCase().includes(needle)).slice(0, 300) : [];
  if (!needle && files) walk(tree, 0);
  return (
    <div className="file">
      <div className="file-head">
        <input className="files-filter" placeholder={files ? `filter ${num(files.length)} files` : "loading…"} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
      </div>
      <div className="file-body">
        <div className="dir-list">
          {needle
            ? matches.map((f) => (
                <button key={f} className="dir-row" onClick={() => openFile(f)}>
                  <span className="dir-icon" />
                  <span>{f}</span>
                </button>
              ))
            : rows}
          {files && !files.length && <div className="muted pad">No files (not a git checkout?).</div>}
        </div>
      </div>
    </div>
  );
}

function DirView({ path }: { path: string }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const pane = usePane();
  useEffect(() => {
    hub().readDir(path).then(setEntries);
  }, [path]);
  return (
    <div className="file">
      <FileHeader path={path} />
      <div className="file-body">
        {entries == null ? null : entries.length === 0 ? (
          <div className="muted pad">Empty folder (or it doesn't exist).</div>
        ) : (
          <div className="dir-list">
            {entries.map((e) => (
              <button key={e.path} className="dir-row" onClick={() => pane.open(e.dir ? { kind: "dir", path: e.path } : { kind: "file", path: e.path })}>
                <span className="dir-icon">{e.dir ? "▸" : ""}</span>
                <span className={e.dir ? "dir-name" : ""}>{e.name}{e.dir ? "/" : ""}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Changed-files list (git status + numstat) over the selected file's diff. Refreshes every few seconds. */
/** Uncommitted changes in every checkout the chat works in (its folder plus worktrees it tracks), with the selected file's diff. */
function ChangesView({ roots }: { roots: Array<{ path: string; label: string }> }) {
  const [all, setAll] = useState<Record<string, GitChange[]> | null>(null);
  const [sel, setSel] = useState<{ root: string; path: string } | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const key = roots.map((r) => r.path).join("|");

  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all(roots.map((r) => hub().gitChanges(r.path).catch(() => [] as GitChange[]))).then((lists) => live && setAll(Object.fromEntries(roots.map((r, i) => [r.path, lists[i]]))));
    load();
    const t = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key]);

  const groups = roots.map((r) => ({ ...r, changes: all?.[r.path] ?? [] })).filter((g) => g.changes.length || roots.length === 1);
  const first = groups.find((g) => g.changes.length);
  const current = sel ?? (first ? { root: first.path, path: first.changes[0].path } : null);
  useEffect(() => {
    if (!current) return setDiff(null);
    hub().gitDiff(current.root, current.path).then(setDiff);
  }, [current?.root, current?.path, all]);

  const flat = groups.flatMap((g) => g.changes);
  const add = flat.reduce((n, c) => n + c.add, 0);
  const del = flat.reduce((n, c) => n + c.del, 0);
  return (
    <div className="file">
      <div className="changes">
        <div className="hd">
          <span>{all == null ? "loading…" : `${num(flat.length)} file${flat.length === 1 ? "" : "s"} changed`}</span>
          <span>
            <span className="add">+{add}</span> <span className="del">−{del}</span>
          </span>
        </div>
        {groups.map((g) => (
          <Fragment key={g.path}>
            {roots.length > 1 && (
              <div className="changes-root" title={g.path}>
                ⎇ {g.label}
              </div>
            )}
            {g.changes.map((c) => (
              <div key={c.path} className={`f ${current?.root === g.path && c.path === current.path ? "on" : ""}`} onClick={() => setSel({ root: g.path, path: c.path })} title={c.path}>
                <span>{c.status === "?" ? "A" : c.status}</span>
                <span>{c.rel}</span>
                <span className="add">{c.add ? `+${c.add}` : ""}</span>
                <span className="del">{c.del ? `−${c.del}` : ""}</span>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
      <div className="file-body">
        {all && flat.length === 0 && <div className="muted pad">No uncommitted changes{roots.length > 1 ? ` in this chat's ${roots.length} checkouts` : ""}.</div>}
        {diff && !diff.startsWith("(git diff unavailable") && <DiffRows ops={parseUnified(diff)} />}
      </div>
    </div>
  );
}

function GitDiffView({ path, cwd }: { path: string; cwd: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    hub().gitDiff(cwd, path).then(setDiff);
  }, [cwd, path, n]);
  return (
    <div className="file">
      <FileHeader path={path} onReload={() => setN(n + 1)} />
      <div className="file-body">
        {diff == null ? null : diff.startsWith("(git diff unavailable") ? (
          <div className="muted pad">{diff}</div>
        ) : diff.trim() ? (
          <DiffRows ops={parseUnified(diff)} />
        ) : (
          <div className="muted pad">No uncommitted changes.</div>
        )}
      </div>
    </div>
  );
}

/** Split highlight.js HTML into lines, re-opening spans that cross line breaks so each row is balanced. */
function splitHighlighted(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let cur = "";
  for (const tok of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!tok) continue;
    if (tok === "\n") {
      out.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else if (tok.startsWith("<span")) {
      open.push(tok);
      cur += tok;
    } else if (tok === "</span>") {
      open.pop();
      cur += tok;
    } else cur += tok;
  }
  out.push(cur + "</span>".repeat(open.length));
  return out;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

/** Pinned replies for this chat: read them here, jump to one in the chat, or unpin. */
function PinsView({ sessionId, items }: { sessionId: string; items: TranscriptItem[] }) {
  const pins = items.filter((i) => i.pinned);
  if (!pins.length) return <div className="muted pad center small">Nothing pinned yet. Hover a reply and click “pin”.</div>;
  return (
    <div className="pins">
      {pins.map((it) => (
        <div key={it.id} className="pin-card">
          <div className="pin-h">
            <span className="muted mono small">{new Date(it.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            <button className="link-btn" onClick={() => document.querySelector(`[data-item="${CSS.escape(it.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              jump to
            </button>
            <button className="link-btn" onClick={() => void hub().pinItem(sessionId, it.id, false)}>
              unpin
            </button>
          </div>
          <Markdown text={it.simplified ?? it.text} />
        </div>
      ))}
    </div>
  );
}

/** A single file (PDF, image, spreadsheet, text…) outside the session pane, e.g. an email attachment. */
export function FilePreview({ path }: { path: string }) {
  return isImagePath(path) ? <ImageView path={path} /> : <FileView path={path} cwd={path.replace(/\/[^/]*$/, "")} />;
}
