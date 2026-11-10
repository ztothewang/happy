import { useEffect, useState } from "react";
import type { SessionState } from "../shared/types";
import { hub } from "./App";
import { fmtDuration, num } from "./models";

/** Collapsed strip above the composer: background tasks + processes running in this session's folders. */
export function ProcessStrip({ s }: { s: SessionState }) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open]);
  const procs = s.processes ?? [];
  if (!procs.length) return null;
  const tasks = procs.filter((p) => p.source === "task").length;
  return (
    <div className="procs">
      <button className="procs-head" onClick={() => setOpen(!open)}>
        <span className={`caret-icon ${open ? "open" : ""}`}>›</span>
        <span className="procs-dot" />
        {num(procs.length)} running
        <span className="muted">
          {tasks ? ` · ${tasks} background task${tasks === 1 ? "" : "s"}` : ""}
          {procs.length - tasks ? ` · ${procs.length - tasks} process${procs.length - tasks === 1 ? "" : "es"} in this folder` : ""}
        </span>
      </button>
      {open && procs.length > 1 && (
        <button
          className="kb procs-stopall"
          onClick={() => {
            if (!confirm(`Stop all ${num(procs.length)} processes and tasks for this session?\n\n${procs.map((p) => `• ${p.label.slice(0, 90)}`).slice(0, 12).join("\n")}${procs.length > 12 ? "\n…" : ""}`)) return;
            for (const p of procs) void hub().stopProcess(s.id, { source: p.source, id: p.id }).catch(() => {});
          }}
        >
          stop all
        </button>
      )}
      {open && (
        <div className="procs-list">
          {procs.map((p) => (
            <div key={`${p.source}:${p.id}`} className="proc">
              <span className={`proc-kind ${p.source}`}>{p.source === "task" ? (p.kind ?? "task").replace(/_/g, " ") : `pid ${p.pid}`}</span>
              <span className="proc-label" title={p.cwd ? `${p.label}\n${p.cwd}` : p.label}>
                {p.label}
              </span>
              <span className="proc-time">{p.startedAt ? fmtDuration(Date.now() - p.startedAt) : ""}</span>
              <button
                className="kb"
                onClick={() => {
                  if (p.source === "os" && !confirm(`Stop process ${p.pid}?\n\n${p.label}`)) return;
                  void hub().stopProcess(s.id, { source: p.source, id: p.id });
                }}
              >
                stop
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
