import type { SessionState } from "../shared/types";
import { hub } from "./App";

/** The agent's suggested next messages for its latest reply: pick one to send it, or just type your own. */
export function NextSteps({ s, mobile }: { s: SessionState; mobile?: boolean }) {
  if (!s.nextSteps?.length || s.status !== "idle") return null;
  return (
    <div className={mobile ? "mx-next" : "next-steps"}>
      {s.nextSteps.map((n) => (
        <button key={n.label} className="next-step" title={n.message} onClick={() => void hub().send(s.id, n.message)}>
          {n.label}
        </button>
      ))}
    </div>
  );
}
