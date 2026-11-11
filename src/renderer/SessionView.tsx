import { Pin } from "lucide-react";
import { QueuedMessages, TodoFloat } from "./Todos";
import { RoutineRunsFloat } from "./RoutineRuns";
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PermissionDecision, SessionState, TranscriptItem } from "../shared/types";
import { hub } from "./App";
import { Composer, type SlashCommand } from "./Composer";
import { Markdown } from "./Markdown";
import { ProcessStrip } from "./Processes";
import { PlanCard, QuestionCard, isPromptTool } from "./PromptCards";
import { CLAUDE_MODELS, PERMISSION_MODES, engineCode, fmtClock, fmtDuration } from "./models";
import { baseName, fileUrl, isImagePath, usePane } from "./pane";
import { useToast } from "./toast";
import { NextSteps } from "./NextSteps";
import { LinkCards, openLightbox } from "./Lightbox";

/** mcp__browser__navigate → browser.navigate */
const toolLabel = (t?: string) => {
  const m = t?.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1]}.${m[2]}` : (t ?? "");
};

function Thumbs({ images }: { images?: string[] }) {
  if (!images?.length) return null;
  return (
    <div className="thumbs">
      {images.map((p) => (
        <button key={p} className="thumb" onClick={() => openLightbox(fileUrl(p))} title="View full size">
          <img src={fileUrl(p)} alt="" loading="lazy" />
        </button>
      ))}
    </div>
  );
}

function DiffStat({ before, after }: { before: string; after: string }) {
  const b = before ? before.split("\n").length : 0;
  const a = after ? after.split("\n").length : 0;
  return (
    <>
      {a > 0 && <span className="add">+{a}</span>} {b > 0 && <span className="del">−{b}</span>}
    </>
  );
}

function ToolRow({ it, cwd }: { it: TranscriptItem; cwd: string }) {
  const [open, setOpen] = useState(false);
  const pane = usePane();
  const rel = it.path && it.path.startsWith(`${cwd}/`) ? it.path.slice(cwd.length + 1) : it.path;
  const openFile = (e: React.MouseEvent) => {
    if (!it.path) return;
    e.stopPropagation();
    if (it.diff) pane.open({ kind: "diff", path: it.path, before: it.diff.before, after: it.diff.after, id: it.id });
    else pane.open(isImagePath(it.path) ? { kind: "image", path: it.path } : { kind: "file", path: it.path });
  };
  return (
    <>
      <tr className={`t-row ${it.status ?? ""}`} onClick={() => it.detail && setOpen(!open)} title={it.detail ? "Click for details" : undefined}>
        <td className="tn">
          <span className="tdot" />
          {toolLabel(it.tool)}
        </td>
        <td className={`ta ${it.path ? "link" : ""}`} onClick={it.path ? openFile : undefined} title={it.path ?? it.text}>
          {rel ?? it.text}
        </td>
        <td className="tr">{it.diff ? <DiffStat before={it.diff.before} after={it.diff.after} /> : it.status === "running" ? "…" : it.result}</td>
        <td className="td">{fmtDuration(it.durationMs)}</td>
      </tr>
      {(open || !!it.images?.length) && (
        <tr>
          <td className="detail" colSpan={4}>
            {open && it.detail && <pre className="tool-detail">{it.detail}</pre>}
            <Thumbs images={it.images} />
          </td>
        </tr>
      )}
    </>
  );
}

type Block = { kind: "item"; it: TranscriptItem } | { kind: "tools"; items: TranscriptItem[] };

/** Group consecutive tool (and thinking) items into one collapsed table block. */
function toBlocks(items: TranscriptItem[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === "tool" || it.kind === "thinking") {
      if (last?.kind === "tools") last.items.push(it);
      else out.push({ kind: "tools", items: [it] });
    } else out.push({ kind: "item", it });
  }
  return out;
}

const SHOW_TOOLS_KEY = "session-hub:show-tools";
export const readShowTools = () => {
  try {
    return localStorage.getItem(SHOW_TOOLS_KEY) === "1";
  } catch {
    return false;
  }
};
export const writeShowTools = (v: boolean) => {
  try {
    localStorage.setItem(SHOW_TOOLS_KEY, v ? "1" : "0");
  } catch {}
  window.dispatchEvent(new Event("show-tools"));
};

const SHOW_SYS_KEY = "session-hub:show-sys";
export const readShowSys = () => {
  try {
    return localStorage.getItem(SHOW_SYS_KEY) === "1";
  } catch {
    return false;
  }
};
export const writeShowSys = (v: boolean) => {
  try {
    localStorage.setItem(SHOW_SYS_KEY, v ? "1" : "0");
  } catch {}
  window.dispatchEvent(new Event("show-tools"));
};

/** Collapsed tool block: just the step count (plus a live marker while a step runs). */
function ToolSummary({ items }: { items: TranscriptItem[] }) {
  const running = items.some((i) => i.status === "running");
  const failed = items.filter((i) => i.status === "failed").length;
  const steps = items.filter((i) => i.kind === "tool").length;
  return (
    <span className="tsum">
      {steps ? `${steps} step${steps === 1 ? "" : "s"}` : "thinking"}
      {running && <span className="tsum-run"> · running</span>}
      {failed > 0 && <span className="del"> · {failed} failed</span>}
    </span>
  );
}

function ToolBlock({ items, cwd, showAll }: { items: TranscriptItem[]; cwd: string; showAll: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = open || showAll;
  return (
    <div className="ln wide">
      <span className="ts">{fmtClock(items[0].ts)}</span>
      <span className="who">{items.some((i) => i.kind === "tool") ? "tools" : "think"}</span>
      <div className="body">
        <button className={`tsum-btn ${expanded ? "open" : ""}`} onClick={() => setOpen(!open)} title={expanded ? "Hide steps" : "Show steps"}>
          <span className="caret-icon">›</span>
          <ToolSummary items={items} />
        </button>
        {expanded && (
          <div className="tools-wrap">
            <table className="tools">
              <tbody>
                {items.map((it) => (
                  <ToolRow key={it.id} it={it.kind === "thinking" ? { ...it, tool: "think", text: it.text.split("\n")[0].slice(0, 160), detail: it.text } : it} cwd={cwd} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Line({ b, cwd, who, showTools, onSimplify, onPin, onWtf, onStatus }: { b: Block; cwd: string; who: string; showTools: boolean; onSimplify?: () => Promise<void>; onPin?(v: boolean): void; onWtf?(): void; onStatus?(): void }) {
  const pane = usePane();
  if (b.kind === "tools") return <ToolBlock items={b.items} cwd={cwd} showAll={showTools} />;
  return (
    <div data-item={b.it.id} className={b.it.pinned ? "pinned-item" : undefined}>
      <ItemLine it={b.it} who={who} openFile={(f) => pane.open({ kind: "file", path: f })} onSimplify={onSimplify} onPin={onPin} onWtf={onWtf} onStatus={onStatus} />
    </div>
  );
}

/** "wtf" macro: a visible follow-up asking the agent where things stand. */
const WTF_PROMPT =
  "Quick status check. In short plain bullets: what's been done so far, and what remains (including anything you need from me). No background, no code.";

/** "status" macro: just asks. */
const STATUS_PROMPT = "Status?";

/** Copy a reply's original Markdown to the clipboard. */
function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`pin-btn ${done ? "on" : ""}`}
      title="Copy as Markdown"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

/** Assistant reply with an optional plain-language rewrite (shown by default once made) and a toggle. */
function AssistantBody({ it, onSimplify, onPin, onWtf, onStatus }: { it: TranscriptItem; onSimplify?: () => Promise<void>; onPin?(v: boolean): void; onWtf?(): void; onStatus?(): void }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const simple = it.simplified && !showOriginal;
  return (
    <>
      <Markdown text={simple ? it.simplified! : it.text} />
      {it.simplified ? (
        <button className="simplify on" onClick={() => setShowOriginal(!showOriginal)} title="Switch between the simplified and original reply">
          {simple ? "simplified · show original" : "original · show simplified"}
        </button>
      ) : (
        onSimplify && (
          <button
            className="simplify"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr("");
              try {
                await onSimplify();
              } catch (e) {
                setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
              }
              setBusy(false);
            }}
            title="Rewrite this reply shorter and simpler (the agent doesn't see this)"
          >
            {busy ? "simplifying…" : "simplify"}
          </button>
        )
      )}
      {onWtf && (
        <button className="simplify" onClick={onWtf} title="Ask the agent: what's done, what remains">
          wtf?
        </button>
      )}
      {onStatus && (
        <button className="simplify" onClick={onStatus} title={`Send "${STATUS_PROMPT}"`}>
          status
        </button>
      )}
      {onPin && (
        <button className={`pin-btn ${it.pinned ? "on" : ""}`} onClick={() => onPin(!it.pinned)} title={it.pinned ? "Unpin" : "Pin this reply (see it in the Pinned pane)"}>
          {it.pinned ? "pinned" : "pin"}
        </button>
      )}
      <CopyBtn text={it.text} />
      {err && <span className="del small"> {err}</span>}
    </>
  );
}

const ItemLine = memo(function ItemLine({
  it,
  who,
  openFile,
  onSimplify,
  onPin,
  onWtf,
  onStatus,
}: {
  it: TranscriptItem;
  who: string;
  openFile(f: string): void;
  onSimplify?: () => Promise<void>;
  onPin?(v: boolean): void;
  onWtf?(): void;
  onStatus?(): void;
}) {
  const ts = <span className="ts">{fmtClock(it.ts)}</span>;
  switch (it.kind) {
    case "user":
      return (
        <div className="ln you">
          {ts}
          <span className="who">you</span>
          <div className="body">
            {it.files?.map((f) => (
              <button key={f} className="att" title={f} onClick={() => openFile(f)}>
                {baseName(f)}
              </button>
            ))}
            <Thumbs images={it.images} />
            {it.text && <span className="pre user-text">{it.text}</span>}
            <LinkCards text={it.text} />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="ln">
          {ts}
          <span className="who">{who}</span>
          <div className="body">
            <AssistantBody it={it} onSimplify={onSimplify} onPin={onPin} onWtf={onWtf} onStatus={onStatus} />
          </div>
        </div>
      );
    case "thinking":
      return (
        <div className="ln">
          {ts}
          <span className="who">think</span>
          <details className="body think">
            <summary>{it.text.split("\n")[0].slice(0, 120)}…</summary>
            <div className="pre">{it.text}</div>
          </details>
        </div>
      );
    case "system":
      return (
        <div className="ln sys">
          {ts}
          <span className="who">sys</span>
          <div className="body pre">{it.text}</div>
        </div>
      );
    case "tags":
      return (
        <div className="ln tagnote">
          {ts}
          <span className="who">tags</span>
          <div className="body">
            {it.tagsAdded?.map((t) => (
              <span key={`+${t}`} className="tagnote-add">
                + #{t}
              </span>
            ))}
            {it.tagsRemoved?.map((t) => (
              <span key={`-${t}`} className="tagnote-rm">
                − #{t}
              </span>
            ))}
          </div>
        </div>
      );
    case "error":
      return <ErrorLine it={it} ts={ts} />;
    default:
      return null;
  }
});

/** An engine error: plain title + what to do, raw text behind "details". */
function ErrorLine({ it, ts }: { it: TranscriptItem; ts: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [title, ...rest] = it.text.split("\n");
  return (
    <div className="ln err">
      {ts}
      <span className="who">!</span>
      <div className="body err-card">
        <div className="err-title">{title}</div>
        {rest.length > 0 && <div className="err-hint">{rest.join("\n")}</div>}
        {it.detail && it.detail !== it.text && (
          <>
            <button className="link-btn err-more" onClick={() => setOpen(!open)}>
              {open ? "hide details" : "details"}
            </button>
            {open && <pre className="err-raw">{it.detail}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

export function SessionView({
  session: s,
  dropZone,
  onSend,
  placeholder,
}: {
  session: SessionState;
  dropZone: React.RefObject<HTMLElement | null>;
  /** Replaces the normal send (e.g. the Cloud chat attaches the current board). */
  onSend?: (text: string, images?: string[], files?: string[]) => void;
  placeholder?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pane = usePane();
  const toast = useToast();

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.items, s.pending]);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const [showTools, setShowTools] = useState(readShowTools);
  const [showSys, setShowSys] = useState(readShowSys);
  // System notes (worktree created, interrupted, compacted…) are hidden unless turned on; errors always show.
  const blocks = useMemo(() => toBlocks(showSys ? s.items : s.items.filter((i) => i.kind !== "system")), [s.items, showSys]);
  useEffect(() => {
    const on = () => {
      setShowTools(readShowTools());
      setShowSys(readShowSys());
    };
    window.addEventListener("show-tools", on);
    return () => window.removeEventListener("show-tools", on);
  }, []);
  const busy = s.status === "running" || s.status === "needs_permission";
  const who = engineCode(s.engine, s.isManager);
  const lastReplyId = useMemo(() => [...s.items].reverse().find((i) => i.kind === "assistant")?.id, [s.items]);
  /** The latest message from you or the agent — the wtf macro sits under it. */
  const lastMsgId = useMemo(() => [...s.items].reverse().find((i) => i.kind === "assistant" || i.kind === "user")?.id, [s.items]);

  const respond = (d: PermissionDecision) => s.pending && hub().respondPermission(s.pending.requestId, d);
  const permissionKey = (key: string): boolean => {
    if (!s.pending || isPromptTool(s.pending.tool)) return false;
    if (key === "Enter") respond("allow");
    else if (key === "a" || key === "A") respond("allow_always");
    else if (key === "d" || key === "D") respond("deny");
    else return false;
    return true;
  };

  // Permission shortcuts also work when focus isn't in a text field.
  useEffect(() => {
    if (!s.pending) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || (el && /INPUT|TEXTAREA/.test(el.tagName))) return;
      if (permissionKey(e.key)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const commands: SlashCommand[] = [
    {
      name: "model",
      args: "<opus|sonnet|haiku|default|id>",
      help: "switch model",
      run: (a) => {
        const hit = a ? CLAUDE_MODELS.find((m) => m.label.toLowerCase().startsWith(a.toLowerCase())) : undefined;
        void hub().setModel(s.id, !a || a === "default" ? null : s.engine === "claude" ? (hit?.id ?? a) : a);
      },
    },
    ...(s.engine === "claude"
      ? [
          {
            name: "mode",
            args: "<ask|edits|plan|bypass>",
            help: "permission mode",
            run: (a: string) => {
              const m = PERMISSION_MODES.find((p) => p.value === a || (a && p.short.toLowerCase().includes(a.toLowerCase())));
              if (m) void hub().setPermissionMode(s.id, m.value);
            },
          },
        ]
      : []),
    ...(s.engine === "codex"
      ? [
          { name: "effort", args: "<low|medium|high|xhigh|default>", help: "reasoning effort", run: (a: string) => void hub().setEffort(s.id, !a || a === "default" ? null : a) },
          {
            name: "sandbox",
            args: "<write|full|read>",
            help: "codex sandbox (full = can commit/merge)",
            run: (a: string) =>
              void hub().setCodexSandbox(s.id, a.startsWith("f") ? "danger-full-access" : a.startsWith("r") ? "read-only" : "workspace-write"),
          },
        ]
      : []),
    { name: "tag", args: "<name>", help: "add a tag", run: (a) => void (a && hub().setTags(s.id, [...(s.tags ?? []), a])) },
    { name: "untag", args: "<name>", help: "remove a tag", run: (a) => void hub().setTags(s.id, (s.tags ?? []).filter((t) => t !== a)) },
    { name: "rename", args: "<title>", help: "rename session", run: (a) => void (a && hub().rename(s.id, a)) },
    { name: "stop", help: "stop the current turn", run: () => void hub().interrupt(s.id) },
    { name: "tools", help: "always show / hide tool steps", run: () => writeShowTools(!readShowTools()) },
    { name: "sys", help: "show / hide system notes", run: () => writeShowSys(!readShowSys()) },
    { name: "changes", help: "show uncommitted changes", run: () => pane.open({ kind: "changes" }) },
    {
      name: "browser",
      args: "<url>",
      help: "open a url in this session's browser",
      run: (a) => (a ? pane.openLink(a.includes("://") ? a : `https://${a}`) : pane.open({ kind: "browser" })),
    },
    ...(!s.isManager && !s.isCloud && !s.isEmail
      ? [
          {
            name: "archive",
            help: "archive this session",
            run: () => {
              void hub().setArchived(s.id, true);
              toast(`archived “${s.title}”`, { label: "undo", run: () => hub().setArchived(s.id, false) });
            },
          },
        ]
      : []),
  ];

  const pendingArg = s.pending
    ? typeof s.pending.input.command === "string"
      ? s.pending.input.command
      : typeof s.pending.input.file_path === "string"
        ? s.pending.input.file_path
        : JSON.stringify(s.pending.input)
    : "";

  return (
    <>
      <div className="log-wrap">
      <div className="chat-corner">
        {s.items.some((i) => i.pinned) && (
          <button className="td-pill" onClick={() => pane.open({ kind: "pins" })} title="Pinned replies (opens in the side pane)">
            <Pin size={12} /> {s.items.filter((i) => i.pinned).length}
          </button>
        )}
        {s.routineId && <RoutineRunsFloat s={s} />}
        {!s.isManager && !s.isCloud && !s.isEmail && <TodoFloat s={s} />}
      </div>
      <div className={`log ${s.isManager || s.isCloud || s.isEmail ? "no-ts" : ""}`} ref={scroller} onScroll={onScroll}>
        {s.archived && (
          <div className="ln sys">
            <span className="ts" />
            <span className="who">sys</span>
            <div className="body">archived · unarchive from ⋯</div>
          </div>
        )}
        {s.items.length === 0 && (
          <div className="muted pad center mono small">
            {s.isManager
              ? "ask about the board using its refs — “why is E1 happening?”, “start a session to finish M6 and merge it”, “summarize D2”."
              : s.isEmail
                ? "ask about your email — “what's waiting on me?”, “archive the newsletters”, or hit zero inbox"
                : s.isCloud
                ? "ask about the board you're on — “what's causing C1?”, “anything to fix today?”"
                : "send a message to start · drop files to attach · / for commands"}
          </div>
        )}
        {blocks.map((b) => (
          <Fragment key={b.kind === "tools" ? b.items[0].id : b.it.id}>
          <Line
            key={b.kind === "tools" ? b.items[0].id : b.it.id}
            b={b}
            cwd={s.cwd}
            who={who}
            showTools={showTools}
            onSimplify={b.kind === "item" && b.it.kind === "assistant" && (b.it.id === lastReplyId || !!b.it.simplified) ? () => hub().simplify(s.id, b.it.id) : undefined}
            onPin={b.kind === "item" && b.it.kind === "assistant" ? (v) => void hub().pinItem(s.id, b.it.id, v) : undefined}
            onWtf={b.kind === "item" && b.it.kind === "assistant" && b.it.id === lastMsgId ? () => void hub().send(s.id, WTF_PROMPT) : undefined}
            onStatus={b.kind === "item" && b.it.kind === "assistant" && b.it.id === lastMsgId ? () => void hub().send(s.id, STATUS_PROMPT) : undefined}
          />
          {b.kind === "item" && b.it.id === lastMsgId && b.it.kind !== "assistant" && (
            <div className="ln macros">
              <span className="ts" />
              <span className="who" />
              <div className="body">
                <button className="simplify" onClick={() => void hub().send(s.id, WTF_PROMPT)} title="Ask the agent: what's done, what remains">
                  wtf?
                </button>
                <button className="simplify" onClick={() => void hub().send(s.id, STATUS_PROMPT)} title={`Send "${STATUS_PROMPT}"`}>
                  status
                </button>
              </div>
            </div>
          )}
          </Fragment>
        ))}
        {s.pending && isPromptTool(s.pending.tool) && (
          <div className="ln wide">
            <span className="ts">{fmtClock(Date.now())}</span>
            <span className="who" style={{ color: "var(--warn)" }}>
              {s.pending.tool === "ExitPlanMode" ? "plan" : "asks"}
            </span>
            <div className="body">
              {s.pending.tool === "ExitPlanMode" ? <PlanCard p={s.pending} who={who} /> : <QuestionCard p={s.pending} who={who} />}
            </div>
          </div>
        )}
        {s.pending && !isPromptTool(s.pending.tool) && (
          <div className="ln wide">
            <span className="ts">{fmtClock(Date.now())}</span>
            <span className="who" style={{ color: "var(--warn)" }}>
              ask
            </span>
            <div className="body">
              <div className="ask">
                <span className="q">{toolLabel(s.pending.tool)}</span>
                <code title={JSON.stringify(s.pending.input, null, 2)}>{pendingArg}</code>
                <button className="kb pri" onClick={() => respond("allow")}>
                  allow ↵
                </button>
                <button className="kb" onClick={() => respond("allow_always")}>
                  always A
                </button>
                <button className="kb" onClick={() => respond("deny")}>
                  deny D
                </button>
              </div>
              {/* Why it asks (Claude's own reason): bypass still asks for its safety checks, e.g. sensitive files. */}
              {s.pending.reason && <div className="ask-why muted small">{s.pending.reason.replace(/\x1b\[[0-9;]*m/g, "")}</div>}
            </div>
          </div>
        )}
        {s.preparing && (
          <div className="ln">
            <span className="ts" />
            <span className="who" />
            <span className="working">⎇ setting up worktree… your messages will be sent as soon as it's ready</span>
          </div>
        )}
        {s.status === "running" && (
          <div className="ln">
            <span className="ts" />
            <span className="who" />
            <span className="working">working…</span>
          </div>
        )}
        <QueuedMessages s={s} />
        <NextSteps s={s} />
      </div>
      </div>

      <ProcessStrip s={s} />
      <Composer
        draftKey={s.id}
        engine={s.engine}
        model={s.model}
        onModel={(m) => hub().setModel(s.id, m)}
        permissionMode={s.permissionMode}
        onPermission={(m) => hub().setPermissionMode(s.id, m)}
        effort={s.effort}
        onEffort={(e) => hub().setEffort(s.id, e)}
        sandbox={s.codexSandbox}
        onSandbox={(m) => hub().setCodexSandbox(s.id, m)}
        cursorMode={s.cursorMode}
        onCursorMode={(m) => hub().setCursorMode(s.id, m)}
        busy={busy}
        onInterrupt={() => hub().interrupt(s.id)}
        cwd={s.cwd}
        dropZone={dropZone}
        commands={commands}
        onEmptyKey={(k) => k === "Enter" && permissionKey(k)}
        onSend={(text, images, files) => {
          stick.current = true;
          if (onSend) onSend(text, images, files);
          else void hub().send(s.id, text, images, files);
        }}
        placeholder={placeholder ?? (busy ? "queue a message, or / for commands" : "message, or / for commands")}
      />
    </>
  );
}
