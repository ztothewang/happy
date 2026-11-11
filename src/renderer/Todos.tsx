import { Bell, Check, ListChecks, Plus, X } from "lucide-react";
import { num } from "./models";
import { useState } from "react";
import type { SessionState, SessionTodo } from "../shared/types";
import { hub } from "./App";

const DAY = 24 * 3600_000;

/** "in 2h", "today 6:00 PM", "tomorrow 9:00 AM", "Mon 9:00 AM", "overdue 3h". */
export function dueLabel(due: number, now = Date.now()): string {
  const d = new Date(due);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const diff = due - now;
  if (diff < 0) {
    const m = Math.round(-diff / 60_000);
    return `overdue ${m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`}`;
  }
  if (diff < 60 * 60_000) return `in ${Math.max(1, Math.round(diff / 60_000))}m`;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = Math.floor((due - start.getTime()) / DAY);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

const at = (daysAhead: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};
/** Quick due times for a new reminder. */
const PRESETS: Array<[string, () => number | undefined]> = [
  ["no time", () => undefined],
  ["in 1 hour", () => Date.now() + 3600_000],
  ["in 3 hours", () => Date.now() + 3 * 3600_000],
  ["this evening", () => (new Date().getHours() < 18 ? at(0, 18) : at(1, 18))],
  ["tomorrow 9am", () => at(1, 9)],
  ["next Monday 9am", () => at(((8 - new Date().getDay()) % 7) || 7, 9)],
];

export const openTodos = (s: SessionState) => (s.todos ?? []).filter((t) => !t.done);
export const isOverdue = (t: SessionTodo) => !!t.due && !t.done && t.due <= Date.now();

function TodoRow({ s, t }: { s: SessionState; t: SessionTodo }) {
  return (
    <div className={`td-row ${t.done ? "done" : ""} ${isOverdue(t) ? "overdue" : ""}`}>
      <button className="td-check" aria-label={t.done ? "Mark not done" : "Mark done"} onClick={() => void hub().updateTodo(s.id, t.id, { done: !t.done })}>
        {t.done && <Check size={11} strokeWidth={3} />}
      </button>
      <span className="td-text">
        {t.text}
        {t.due && !t.done && <span className="td-due">{dueLabel(t.due)}</span>}
      </span>
      <button className="td-x" aria-label="Remove" onClick={() => void hub().removeTodo(s.id, t.id)}>
        <X size={12} />
      </button>
    </div>
  );
}

/** Quick add: text, reminder or follow-up, and (for reminders) when. */
function AddTodo({ s, autoFocus }: { s: SessionState; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<SessionTodo["kind"]>("reminder");
  const [preset, setPreset] = useState(4);
  const [custom, setCustom] = useState("");
  const add = () => {
    if (!text.trim()) return;
    const due = kind !== "reminder" ? undefined : custom ? new Date(custom).getTime() : PRESETS[preset][1]();
    void hub().addTodo(s.id, { kind, text, due });
    setText("");
    setCustom("");
  };
  return (
    <div className="td-add">
      <input
        value={text}
        autoFocus={autoFocus}
        placeholder={kind === "reminder" ? "Remind me to…" : "Follow up on…"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && add()}
      />
      <div className="td-add-row">
        <div className="td-seg">
          <button className={kind === "reminder" ? "on" : ""} onClick={() => setKind("reminder")}>
            reminder
          </button>
          <button className={kind === "followup" ? "on" : ""} onClick={() => setKind("followup")}>
            follow-up
          </button>
        </div>
        {kind === "reminder" && (
          <select
            value={custom ? "custom" : String(preset)}
            onChange={(e) => {
              if (e.target.value === "custom") {
                const d = new Date(Date.now() + 3600_000);
                d.setMinutes(0, 0, 0);
                setCustom(new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
              } else {
                setCustom("");
                setPreset(Number(e.target.value));
              }
            }}
          >
            {PRESETS.map(([l], i) => (
              <option key={l} value={i}>
                {l}
              </option>
            ))}
            <option value="custom">pick a time…</option>
          </select>
        )}
        <button className="td-go" disabled={!text.trim()} onClick={add} aria-label="Add">
          <Plus size={14} />
        </button>
      </div>
      {kind === "reminder" && custom && <input type="datetime-local" className="td-when" value={custom} onChange={(e) => setCustom(e.target.value)} />}
    </div>
  );
}

/** Reminders, follow-ups and the agent's own task list for one chat (desktop card and phone sheet). */
export function TodoList({ s, autoFocus }: { s: SessionState; autoFocus?: boolean }) {
  const [showDone, setShowDone] = useState(false);
  const todos = s.todos ?? [];
  const reminders = todos.filter((t) => t.kind === "reminder" && !t.done).sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));
  const followups = todos.filter((t) => t.kind === "followup" && !t.done);
  const done = todos.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const agent = s.agentTodos ?? [];
  const agentOpen = agent.some((t) => t.status !== "completed");
  return (
    <div className="td-list">
      {reminders.length > 0 && (
        <div className="td-sec">
          <div className="td-h">Reminders</div>
          {reminders.map((t) => (
            <TodoRow key={t.id} s={s} t={t} />
          ))}
        </div>
      )}
      {followups.length > 0 && (
        <div className="td-sec">
          <div className="td-h">Follow-ups</div>
          {followups.map((t) => (
            <TodoRow key={t.id} s={s} t={t} />
          ))}
        </div>
      )}
      {agent.length > 0 && (agentOpen || !todos.length) && (
        <div className="td-sec">
          <div className="td-h">{s.engine === "codex" ? "Codex" : s.engine === "cursor" ? "Cursor" : "Claude"}'s tasks</div>
          {agent.map((t, i) => (
            <div key={i} className={`td-row agent ${t.status}`}>
              <span className="td-check ro">{t.status === "completed" ? <Check size={11} strokeWidth={3} /> : t.status === "in_progress" ? <span className="td-dot" /> : null}</span>
              <span className="td-text">{t.text}</span>
            </div>
          ))}
        </div>
      )}
      <AddTodo s={s} autoFocus={autoFocus} />
      {done.length > 0 && (
        <button className="td-more" onClick={() => setShowDone(!showDone)}>
          {showDone ? "hide" : "show"} {num(done.length)} done
        </button>
      )}
      {showDone && done.map((t) => <TodoRow key={t.id} s={s} t={t} />)}
    </div>
  );
}

const OPEN_KEY = "happy.todos.open";

/** Desktop: top-right of the chat. A pill with counts; open, the full list with quick add. */
export function TodoFloat({ s }: { s: SessionState }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [adding, setAdding] = useState(false);
  const toggle = () => {
    setAdding(false);
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {}
  };
  const mine = openTodos(s);
  const agentOpen = (s.agentTodos ?? []).filter((t) => t.status !== "completed").length;
  const overdue = mine.filter(isOverdue).length;
  const has = mine.length > 0 || agentOpen > 0;
  if (!adding && (!has || !open))
    return (
      <button className={`td-pill ${overdue ? "overdue" : ""} ${has ? "" : "empty"}`} onClick={() => (has ? toggle() : setAdding(true))} title="Reminders and follow-ups">
        <Bell size={12} />
        {has ? (
          <>
            {mine.length > 0 && <span>{num(mine.length)}</span>}
            {agentOpen > 0 && (
              <span className="muted">
                <ListChecks size={12} /> {agentOpen}
              </span>
            )}
          </>
        ) : (
          <Plus size={11} />
        )}
      </button>
    );
  return (
    <div className="td-float">
      <div className="td-float-h">
        <Bell size={12} /> Reminders and follow-ups
        <button className="td-x" onClick={() => (adding && !has ? setAdding(false) : toggle())} aria-label="Collapse">
          <X size={12} />
        </button>
      </div>
      <TodoList s={s} autoFocus={adding} />
    </div>
  );
}

/** Messages sent while the agent works: wait for the turn to end; edit, take back, or send now. */
export function QueuedMessages({ s, mobile }: { s: SessionState; mobile?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const q = s.queued ?? [];
  if (!q.length) return null;
  const nowLabel = s.engine === "claude" ? "send now" : "stop & send";
  const nowTitle = s.engine === "claude" ? "Deliver now: Claude reads it mid-turn" : "Stop the current turn and send this now";
  return (
    <div className={mobile ? "mx-queued" : "queued"}>
      {q.map((m) => (
        <div key={m.id} className="q-row">
          <span className="q-tag">queued</span>
          {editing === m.id ? (
            <textarea
              className="q-edit"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (draft.trim()) void hub().editQueued(s.id, m.id, draft.trim());
                  setEditing(null);
                }
                if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <span className="q-text">{m.text}</span>
          )}
          <span className="q-acts">
            {editing === m.id ? (
              <button
                onClick={() => {
                  if (draft.trim()) void hub().editQueued(s.id, m.id, draft.trim());
                  setEditing(null);
                }}
              >
                save
              </button>
            ) : (
              <button
                onClick={() => {
                  setDraft(m.text);
                  setEditing(m.id);
                }}
              >
                edit
              </button>
            )}
            <button className="q-now" title={nowTitle} onClick={() => void hub().sendQueuedNow(s.id, m.id)}>
              {nowLabel}
            </button>
            <button className="q-del" title="Take back" onClick={() => void hub().removeQueued(s.id, m.id)}>
              <X size={13} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
