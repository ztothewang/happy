import { useState } from "react";
import type { AutoItem, AutoStage, SessionState } from "../shared/types";
import { hub } from "./App";
import { useAuto } from "./auto";
import { useMenu } from "./Menu";
import { fmtClock } from "./models";
import { useToast } from "./toast";

const STAGES: Array<{ id: AutoStage; label: string }> = [
  { id: "working", label: "working" },
  { id: "queued", label: "queued for CI" },
  { id: "ci", label: "in CI" },
  { id: "merge", label: "merge?" },
  { id: "deploy", label: "deploy?" },
  { id: "qa", label: "QA" },
  { id: "done", label: "done" },
];
const label = (st: AutoStage) => STAGES.find((x) => x.id === st)?.label ?? st;
const tone = (i: AutoItem) => (i.back ? "bad" : i.stage === "working" ? "dim" : i.stage === "merge" || i.stage === "deploy" ? "you" : i.stage === "done" ? "ok" : "acc");

/** What the card says when nothing more specific was noted: the chat's branch and code state. */
function line(i: AutoItem, s: SessionState): { text: string; warn?: boolean } {
  if (i.note) return { text: i.note };
  if (!s.worktree || s.worktree.removed) return { text: "works in the main checkout: needs its own branch for CI", warn: true };
  const g = s.git;
  const bits = [s.worktree.branch, g?.dirty ? `${g.dirty} uncommitted` : "", g?.ahead ? `${g.ahead} commit${g.ahead === 1 ? "" : "s"}` : "", g?.merged ? "merged" : ""].filter(Boolean);
  return { text: bits.join(" · ") };
}

/**
 * The Auto page: chats you've put in the pipeline (left) and the three stages after them, CI/CD, Deploy and QA.
 * Stage 1: you move chats along by hand; the pipeline agents come next and will do it themselves.
 */
export function AutoView({ sessions, onOpen }: { sessions: Record<string, SessionState>; onOpen(id: string): void }) {
  const auto = useAuto();
  const menu = useMenu();
  const toast = useToast();
  const items = auto.items.filter((i) => sessions[i.sessionId]);
  const [sel, setSel] = useState<string | null>(null);
  const selected = items.find((i) => i.sessionId === sel) ?? items.find((i) => i.events.length > 1);
  const move = (i: AutoItem, stage: AutoStage, note?: string) => void hub().autoMove(i.sessionId, stage, note).catch((e) => toast(String((e as Error).message)));
  const cardMenu = (e: React.MouseEvent, i: AutoItem) =>
    menu.atMouse(e, [
      { label: "Open chat", onSelect: () => onOpen(i.sessionId) },
      { label: "Move to", submenu: STAGES.map((x) => ({ label: x.label, checked: x.id === i.stage, onSelect: () => move(i, x.id) })) },
      { label: "Send back to the worker…", submenu: [{ type: "input" as const, placeholder: "What needs fixing?", onSubmit: (note: string) => move(i, "working", note || "sent back") }] },
      { type: "separator" as const },
      { label: "Remove from Auto", danger: true, onSelect: () => void hub().autoRemove(i.sessionId) },
    ]);
  const inStages = (...st: AutoStage[]) => items.filter((i) => st.includes(i.stage));
  const needs = [
    ...inStages("merge").map((i) => ({ i, text: `${sessions[i.sessionId].title} is ready to merge into main.`, acts: [["Approve merge", () => move(i, "deploy", "merged: waiting to deploy")], ["Send back", (e: React.MouseEvent) => cardMenu(e, i)]] as const })),
    ...inStages("deploy").map((i) => ({ i, text: `${sessions[i.sessionId].title} is waiting to deploy.`, acts: [["Mark deployed", () => move(i, "qa", "deployed: QA on debreu")], ["Send back", (e: React.MouseEvent) => cardMenu(e, i)]] as const })),
  ];
  const sw = (on: boolean, text: string, set: () => void, title: string) => (
    <button className="au-tg" onClick={set} title={title} aria-pressed={on}>
      <span className={`au-sw ${on ? "on" : ""}`} />
      {text}
    </button>
  );
  const agent = (name: string, what: string, stages: AutoStage[]) => {
    const list = inStages(...stages);
    return (
      <div className="au-col">
        <h3>
          <span>{name}</span>
          <span>{list.length || ""}</span>
        </h3>
        <div className="au-agent">
          <div className="au-ah">
            {name}
            <span className="au-chip c-dim">by hand</span>
          </div>
          <div className="au-now">{what}</div>
          {list.length > 0 && (
            <div className="au-q">
              {list.map((i) => (
                <button key={i.sessionId} onClick={() => setSel(i.sessionId)} onContextMenu={(e) => cardMenu(e, i)}>
                  <span className={`au-chip c-${tone(i)}`}>{label(i.stage)}</span>
                  <span className="au-qt">{sessions[i.sessionId].title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="auto">
      <div className="au-bar">
        <b>Auto</b>
        <span className="muted small">
          {items.filter((i) => i.stage !== "done").length} in the pipeline{items.some((i) => i.stage === "done") ? ` · ${items.filter((i) => i.stage === "done").length} done` : ""}
        </span>
        <span className="au-tgs">
          {sw(auto.autoMerge, "Auto merge", () => void hub().autoSet({ autoMerge: !auto.autoMerge }), "Merge a passing CI batch into main without asking")}
          {sw(auto.autoDeploy, "Auto deploy (debreu)", () => void hub().autoSet({ autoDeploy: !auto.autoDeploy }), "Deploy merged work to debreu without asking; other tenants, migrations, backfills and npm publish still ask")}
          <button className="au-btn" onClick={() => void hub().autoSet({ paused: !auto.paused })} title="Nothing new starts while paused; running steps finish">
            {auto.paused ? "Resume" : "Pause"}
          </button>
        </span>
      </div>
      {needs.length > 0 && (
        <div className="au-inbox">
          <span className="au-ih">Needs you</span>
          {needs.map((n) => (
            <div key={n.i.sessionId + n.i.stage} className="au-ask">
              <span className="au-askt">{n.text}</span>
              {n.acts.map(([t, run], k) => (
                <button key={t} className={`au-btn ${k === 0 ? "pri" : ""}`} onClick={(e) => run(e)}>
                  {t}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {auto.paused && <div className="au-paused">Paused: nothing new starts until you resume.</div>}
      <div className="au-scroll">
        {!items.length ? (
          <div className="au-empty">
            <b>Put chats in the pipeline</b>
            <span>Right-click a chat in the List view (or several picked with ⌘-click) and choose Add to Auto. From here they go through CI/CD, Deploy and QA.</span>
          </div>
        ) : (
          <div className="au-board">
            <div className="au-col">
              <h3>
                <span>Workers</span>
                <span>{items.length}</span>
              </h3>
              {items.map((i) => {
                const s = sessions[i.sessionId];
                const l = line(i, s);
                return (
                  <div key={i.sessionId} className={`au-wk ${selected?.sessionId === i.sessionId ? "sel" : ""}`} onClick={() => setSel(i.sessionId)} onDoubleClick={() => onOpen(i.sessionId)} onContextMenu={(e) => cardMenu(e, i)}>
                    <div className="au-wt">
                      <span className={`r-dot ${s.status}`} />
                      <button className="au-title" onClick={(e) => (e.stopPropagation(), onOpen(i.sessionId))} title="Open chat">
                        {s.title}
                      </button>
                      <button className="au-more" onClick={(e) => (e.stopPropagation(), cardMenu(e, i))} aria-label="Actions" title="Move, send back, remove">
                        ⋯
                      </button>
                    </div>
                    <div className="au-ln">
                      <span className={`au-chip c-${l.warn && i.stage === "working" ? "warn" : tone(i)}`}>{l.warn && i.stage === "working" ? "no branch" : label(i.stage)}</span>
                      <span className={l.warn ? "au-warn" : ""}>{l.text}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            {agent("CI/CD", "Merges ready branches onto main in one batch, runs the tests once, sends failures back. Agent coming next; move chats by hand for now.", ["queued", "ci", "merge"])}
            {agent("Deploy", "Asks each chat what its deploy needs, plans it per tenant, waits for you.", ["deploy"])}
            {agent("QA · debreu", "Asks each chat how to check its change on debreu, then tests it.", ["qa"])}
          </div>
        )}
        {selected && (
          <div className="au-tl">
            <h3>Timeline · {sessions[selected.sessionId].title}</h3>
            {[...selected.events].reverse().map((e, k) => (
              <div key={k} className={`au-ev ${e.tone ?? ""}`}>
                <span className="au-tm">{fmtClock(e.at)}</span>
                <span className="au-who">{e.who}</span>
                <span>{e.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
