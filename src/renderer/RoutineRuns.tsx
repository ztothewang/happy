import { History, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RoutineRun, SessionState } from "../shared/types";
import { hub } from "./App";
import { useToast } from "./toast";

const when = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return today ? `today ${time}` : `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
};

/** A routine chat's runs: the pill says which run is shown (the latest by default); open it to pick an older one. */
export function RoutineRunsFloat({ s }: { s: SessionState }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (open) void hub().routineRuns(s.id).then(setRuns).catch(() => setRuns([]));
  }, [open, s.id]);
  const shown = runs?.find((r) => r.id === s.engineSessionId);
  const label = !s.routineRunId ? "latest run" : shown ? when(shown.startedAt) : "older run";
  const pick = (r: RoutineRun, i: number) => {
    setOpen(false);
    if (r.id === s.engineSessionId) return;
    void hub().showRoutineRun(s.id, i === 0 ? null : r.id).catch((e) => toast(String(e?.message ?? e)));
  };
  if (!open)
    return (
      <button className={`td-pill ${s.routineRunId ? "" : "empty"}`} onClick={() => setOpen(true)} title="This routine's runs">
        <History size={12} /> <span>{label}</span>
      </button>
    );
  return (
    <div className="td-float rr-float">
      <div className="td-float-h">
        <History size={12} /> Runs
        <button className="td-x" onClick={() => setOpen(false)} aria-label="Close">
          <X size={12} />
        </button>
      </div>
      {!runs && <div className="muted small pad">loading…</div>}
      {runs?.length === 0 && <div className="muted small pad">no runs found</div>}
      {runs?.map((r, i) => (
        <button key={r.id} className={`rr-row ${r.id === s.engineSessionId ? "on" : ""}`} onClick={() => pick(r, i)}>
          <span>{when(r.startedAt)}</span>
          {i === 0 && <span className="muted mono small">latest</span>}
        </button>
      ))}
    </div>
  );
}
