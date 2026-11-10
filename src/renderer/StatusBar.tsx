import { inBackground, type SessionState, type UsageTotals } from "../shared/types";
import { fmtCost, fmtTokens } from "./models";
import { useDeployJobs } from "./TerminalView";

export function StatusBar(props: {
  sessions: SessionState[];
  usage: UsageTotals;
  onFilter(q: string): void;
  onNew(): void;
  onPalette(): void;
}) {
  const live = props.sessions.filter((s) => !s.archived);
  const count = (st: string) => live.filter((s) => s.status === st).length;
  const running = count("running");
  const waiting = count("needs_permission");
  const failed = count("error");
  const background = live.filter((s) => inBackground(s)).length;
  const deploying = useDeployJobs().filter((j) => j.status === "running");
  return (
    <div className="statusbar">
      <button onClick={() => props.onFilter("is:running")} title="Show running sessions">
        <span className="sb-dot running" style={{ background: running ? "var(--run)" : "var(--dim2)" }} />
        {running} running
      </button>
      <button onClick={() => props.onFilter("is:waiting")} title="Show sessions waiting on you">
        <span className="sb-dot" style={{ background: waiting ? "var(--warn)" : "var(--dim2)" }} />
        {waiting} waiting
      </button>
      {background > 0 && (
        <button onClick={() => props.onFilter("is:background")} title="Idle chats whose background tasks or processes are still going">
          <span className="sb-dot" style={{ background: "var(--accent)" }} />
          {background} in background
        </button>
      )}
      {failed > 0 && (
        <button onClick={() => props.onFilter("is:error")}>
          <span className="sb-dot" style={{ background: "var(--bad)" }} />
          {failed} failed
        </button>
      )}
      {deploying.map((j) => (
        <button key={j.id} className="sb-deploy" onClick={() => window.dispatchEvent(new CustomEvent("happy:open-terminal"))} title={j.command}>
          <span className="sb-dot" style={{ background: "var(--warn)" }} />
          deploying {j.tenant} {j.kind}…
        </button>
      ))}
      <span className="sp" />
      <span title="Tokens and estimated cost across all sessions today">
        today {fmtTokens(props.usage.tokens)} tok{props.usage.costUsd ? ` · ${fmtCost(props.usage.costUsd)}` : ""}
      </span>
      <button onClick={props.onNew}>⌘N new</button>
      <button onClick={props.onPalette}>⌘K commands</button>
    </div>
  );
}
