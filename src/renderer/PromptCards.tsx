import { useState } from "react";
import type { PermissionRequest } from "../shared/types";
import { hub } from "./App";
import { Markdown } from "./Markdown";

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
}

/** Claude's AskUserQuestion rendered as a form: one block per question, clickable options, "Other" free text. */
export function QuestionCard({ p, who }: { p: PermissionRequest; who: string }) {
  const questions = ((p.input.questions as Question[]) ?? []).filter((q) => q?.question);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const toggle = (q: Question, label: string) =>
    setPicked((all) => {
      const cur = all[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...all, [q.question]: next };
    });

  const submit = () => {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const parts = [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])];
      if (!parts.length) return setError(`Answer “${q.header ?? q.question}” first.`);
      answers[q.question] = parts.join(", ");
    }
    void hub().respondPermission(p.requestId, "allow", { answers });
  };

  return (
    <div className="qcard">
      <div className="qcard-head">{who} is asking</div>
      {questions.map((q) => (
        <div key={q.question} className="qblock">
          {q.header && <span className="qchip">{q.header}</span>}
          <div className="qtext">{q.question}</div>
          <div className="qopts">
            {(q.options ?? []).map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button key={o.label} className={`qopt ${on ? "on" : ""}`} onClick={() => (toggle(q, o.label), setError(""))}>
                  <span className="qmark">{q.multiSelect ? (on ? "☑" : "☐") : on ? "●" : "○"}</span>
                  <span>
                    <b>{o.label}</b>
                    {o.description && <span className="qdesc">{o.description}</span>}
                  </span>
                </button>
              );
            })}
            <input
              className="qother"
              placeholder="Other…"
              value={other[q.question] ?? ""}
              onChange={(e) => (setOther((all) => ({ ...all, [q.question]: e.target.value })), setError(""))}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
        </div>
      ))}
      {error && <div className="qerror">{error}</div>}
      <div className="qactions">
        <button className="kb pri" onClick={submit}>
          {questions.length > 1 ? "submit answers" : "answer"}
        </button>
        <button className="kb" onClick={() => hub().respondPermission(p.requestId, "deny")}>
          skip
        </button>
      </div>
    </div>
  );
}

/** ExitPlanMode: the plan as rendered markdown, approve or send feedback. */
export function PlanCard({ p, who }: { p: PermissionRequest; who: string }) {
  const [feedback, setFeedback] = useState("");
  const plan = typeof p.input.plan === "string" ? p.input.plan : JSON.stringify(p.input, null, 2);
  return (
    <div className="qcard">
      <div className="qcard-head">{who}'s plan</div>
      <div className="qplan">
        <Markdown text={plan} />
      </div>
      <textarea
        className="qother"
        rows={2}
        placeholder="Changes you want (optional)…"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className="qactions">
        <button className="kb pri" onClick={() => hub().respondPermission(p.requestId, "allow")}>
          approve plan
        </button>
        <button className="kb" onClick={() => hub().respondPermission(p.requestId, "deny", { feedback: feedback.trim() || undefined })}>
          {feedback.trim() ? "request changes" : "keep planning"}
        </button>
      </div>
    </div>
  );
}

export const isPromptTool = (tool?: string) => tool === "AskUserQuestion" || tool === "ExitPlanMode";
