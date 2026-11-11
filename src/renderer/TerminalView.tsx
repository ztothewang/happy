import "@xterm/xterm/css/xterm.css";
import { num } from "./models";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hub } from "./App";
import type { DeployJob } from "../shared/types";
import { useRepo } from "./settings";

const MAX = 4;

/** Panes survive page switches (the shells keep running in the main process). */
let paneIds: string[] = [];
const listeners = new Set<(ids: string[]) => void>();
const setPanes = (ids: string[]) => {
  paneIds = ids;
  listeners.forEach((l) => l(ids));
};
export const terminalCount = () => paneIds.length;
export function useTerminalCount() {
  const [n, setN] = useState(paneIds.length);
  useEffect(() => {
    const l = (ids: string[]) => setN(ids.length);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return n;
}

const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Commands waiting for their new pane (id → command + label shown in the pane header). */
const pending = new Map<string, { command: string; label: string }>();

/** Labels for panes running something started elsewhere (shown in the pane header). */
const labels = new Map<string, string>();
const labelListeners = new Set<() => void>();

/**
 * Run a command on the Terminal page (e.g. a deploy from the Manager board) and switch to it: in a shell that's
 * idle at its prompt if there is one, else in a new pane. Returns false when all 4 shells are busy.
 */
export async function runInTerminal(command: string, label: string): Promise<string | null> {
  const idle = (await hub().termIdle().catch(() => [] as string[])).filter((id) => paneIds.includes(id));
  if (idle.length) {
    const id = idle[0];
    labels.set(id, label);
    labelListeners.forEach((l) => l());
    void hub().termWrite(id, `${command}\r`);
    window.dispatchEvent(new CustomEvent("happy:open-terminal"));
    return id;
  }
  if (paneIds.length >= MAX) return null;
  const id = newId();
  pending.set(id, { command, label });
  labels.set(id, label);
  setPanes([...paneIds, id]);
  window.dispatchEvent(new CustomEvent("happy:open-terminal"));
  return id;
}

/** Deploy jobs started from the Manager board (live). */
export function useDeployJobs(): DeployJob[] {
  const [jobs, setJobs] = useState<DeployJob[]>([]);
  useEffect(() => {
    void hub().deployJobs().then(setJobs);
    return hub().onDeployJobs((j) => setJobs([...j]));
  }, []);
  return jobs;
}

/** Colors from the app theme so the terminal matches light/dark. */
function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (k: string) => css.getPropertyValue(k).trim();
  return { background: v("--bg"), foreground: v("--fg"), cursor: v("--accent"), selectionBackground: v("--hl-bg") || "#44475a" };
}

/** A chat's own shell, in its side panel (ids "s-<session id>"; they don't show on the Terminal page). */
export function TerminalPane({ id, cwd }: { id: string; cwd: string }) {
  return <Pane id={id} cwd={cwd} closable={false} onClose={() => {}} />;
}

function Pane({ id, cwd, onClose, closable }: { id: string; cwd: string; onClose(): void; closable: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [where, setWhere] = useState(cwd);
  const [label, setLabel] = useState(() => labels.get(id));
  useEffect(() => {
    const l = () => setLabel(labels.get(id));
    labelListeners.add(l);
    return () => void labelListeners.delete(l);
  }, [id]);
  useEffect(() => {
    const term = new Terminal({ fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace", fontSize: 11.5, cursorBlink: true, allowProposedApi: true, theme: theme(), scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    try {
      fit.fit();
    } catch {}
    let alive = true;
    const job = pending.get(id);
    pending.delete(id);
    void hub()
      .termCreate(id, cwd, term.cols, term.rows, job?.command)
      .then((info) => {
        if (!alive) return;
        setWhere(info.cwd);
        if (info.buffer) term.write(info.buffer);
        term.focus();
      });
    const offData = hub().onTermData((e) => e.id === id && term.write(e.data));
    const offExit = hub().onTermExit((x) => x === id && term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n"));
    const sub = term.onData((d) => void hub().termWrite(id, d));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void hub().termResize(id, term.cols, term.rows);
      } catch {}
    });
    ro.observe(host.current!);
    return () => {
      alive = false;
      ro.disconnect();
      sub.dispose();
      offData();
      offExit();
      term.dispose();
    };
  }, [id]);
  return (
    <div className="term-pane">
      <div className="term-pane-h">
        <span className="mono small muted">
          {label && <b className="term-label">{label} · </b>}
          {where.replace(/^\/Users\/[^/]+/, "~")}
        </span>
        {closable && (
          <button className="td-x" title="Close this shell" onClick={onClose}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="term-host" ref={host} onClick={() => host.current?.querySelector("textarea")?.focus()} />
    </div>
  );
}

/**
 * Terminal page: up to 4 shells, all starting in the main repo. Splits go side by side first, then each column
 * splits top/bottom (1 → 2 columns → 3 with the right column split → 2×2).
 */
export function TerminalView() {
  const repo = useRepo();
  const [ids, setIds] = useState<string[]>(paneIds);
  useEffect(() => {
    listeners.add(setIds);
    // Re-attach to shells that are still running (e.g. after a window reload); start one if there are none.
    void hub()
      .termList()
      .then((live) => {
        const known = paneIds.filter((p) => live.some((l) => l.id === p));
        const extra = live.map((l) => l.id).filter((p) => !known.includes(p) && !p.startsWith("s-"));
        const waiting = paneIds.filter((p) => pending.has(p) && !known.includes(p));
        const next = [...known, ...extra, ...waiting].slice(0, MAX);
        setPanes(next.length ? next : [newId()]);
      });
    const off = hub().onTermExit((x) => setPanes(paneIds.filter((p) => p !== x).length ? paneIds.filter((p) => p !== x) : [newId()]));
    return () => {
      listeners.delete(setIds);
      off();
    };
  }, []);
  const split = () => ids.length < MAX && setPanes([...ids, newId()]);
  const close = (id: string) => {
    void hub().termKill(id);
    const rest = ids.filter((x) => x !== id);
    setPanes(rest.length ? rest : [newId()]);
  };
  // Columns: 1 → [a]; 2 → [a][b]; 3 → [a][b/c]; 4 → [a/c][b/d]
  const cols: string[][] = ids.length <= 2 ? ids.map((x) => [x]) : ids.length === 3 ? [[ids[0]], [ids[1], ids[2]]] : [[ids[0], ids[2]], [ids[1], ids[3]]];
  if (!repo) return <div className="muted pad center mono small">loading…</div>;
  return (
    <div className="term">
      <div className="term-bar">
        <b>Terminal</b>
        <span className="muted mono small">
          {num(ids.length)} of {MAX}
        </span>
        <button className="kb" disabled={ids.length >= MAX} onClick={split} title={ids.length < 2 ? "Split side by side" : "Split top/bottom"}>
          split
        </button>
      </div>
      <div className="term-grid">
        {cols.map((col, i) => (
          <div key={i} className="term-col">
            {col.map((id) => (
              <Pane key={id} id={id} cwd={repo} closable={ids.length > 1} onClose={() => close(id)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
