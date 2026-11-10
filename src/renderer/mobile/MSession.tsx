import { PdfView } from "./PdfView";
import { NextSteps } from "../NextSteps";
import { useDraft } from "../drafts";
import { isDeployed } from "../../shared/types";
import { LinkCards, openLightbox } from "../Lightbox";
import { SheetView, isSheetPath } from "../SheetView";
import { ArrowUp, Bell, Copy, Pin, ChevronDown, ChevronRight, Info, SlidersHorizontal, Square } from "lucide-react";
import { QueuedMessages, TodoList, dueLabel, isOverdue, openTodos } from "../Todos";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Engine, SessionState, TranscriptItem } from "../../shared/types";
import { hub } from "../App";
import { Markdown } from "../Markdown";
import { CLAUDE_MODELS, PERMISSION_MODES, num } from "../models";
import { useRepo } from "../settings";
import { PaneContext, baseName, fileUrl, isImagePath, type PaneApi } from "../pane";
import { PlanCard, QuestionCard, isPromptTool } from "../PromptCards";
import { useToast } from "../toast";
import { Actions, IconBtn, KV, Nav, Pill, Seg, Sheet, ago, cleanErr } from "./ui";

const WTF = "Quick status check. In short plain bullets: what's been done so far, and what remains (including anything you need from me). No background, no code.";

type Block = { kind: "item"; it: TranscriptItem } | { kind: "steps"; items: TranscriptItem[] };

/** Consecutive tool calls collapse into one "N steps" block; system/thinking lines are hidden. */
function blocksOf(items: TranscriptItem[]): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    if (it.kind === "system" || it.kind === "thinking") continue;
    if (it.kind === "tool") {
      const last = out[out.length - 1];
      if (last?.kind === "steps") last.items.push(it);
      else out.push({ kind: "steps", items: [it] });
    } else out.push({ kind: "item", it });
  }
  return out;
}

function Steps({ items }: { items: TranscriptItem[] }) {
  const [open, setOpen] = useState(false);
  const failed = items.filter((i) => i.status === "failed").length;
  const running = items.some((i) => i.status === "running");
  return (
    <div className="mx-steps-wrap">
      <button className="mx-steps" onClick={() => setOpen(!open)}>
        <i className={running ? "run" : failed ? "bad" : ""} />
        {num(items.length)} step{items.length > 1 ? "s" : ""}
        {failed > 0 && <span className="bad"> · {failed} failed</span>}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="mx-step-list">
          {items.map((i) => (
            <div key={i.id} className={`mx-step ${i.status ?? ""}`}>
              <b>{(i.tool ?? "").replace(/^mcp__[^_]+__/, "")}</b>
              <span>{i.path ? baseName(i.path) : i.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorCard({ it }: { it: TranscriptItem }) {
  const [title, ...rest] = it.text.split("\n");
  return (
    <div className="mx-err">
      <b>{title}</b>
      {rest.length > 0 && <span>{rest.join(" ")}</span>}
    </div>
  );
}

/** Hand a file to the phone: the share sheet (Save to Files, AirDrop…) when it can take files, else a download. */
export async function saveFile(path: string) {
  try {
    const blob = await fetch(fileUrl(path)).then((r) => r.blob());
    const file = new File([blob], baseName(path), { type: blob.type || "application/octet-stream" });
    if (navigator.canShare?.({ files: [file] })) return void (await navigator.share({ files: [file] }));
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: baseName(path) }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {}
}

/** Files and links tapped in chat open here, over the conversation. */
export function FileSheet({ link, session, onClose }: { link: string; session?: SessionState; onClose(): void }) {
  const [state, setState] = useState<{ path: string; kind: string; text?: string; line?: number; entries?: Array<{ name: string; dir: boolean; path: string }> } | null>(null);
  const [tab, setTab] = useState<"file" | "diff">("file");
  const [diff, setDiff] = useState<string | null>(null);
  const [cur, setCur] = useState(link);
  useEffect(() => {
    setState(null);
    setTab("file");
    setDiff(null);
    void (async () => {
      const r = session ? await hub().resolveLink(session.id, cur) : { path: cur, kind: isImagePath(cur) ? "image" : "file" as const };
      if (r.kind === "dir") {
        const entries = await hub().readDir(r.path).catch(() => []);
        return setState({ path: r.path, kind: "dir", entries: entries.map((e: any) => ({ name: e.name, dir: e.dir ?? e.isDir, path: e.path ?? `${r.path}/${e.name}` })) });
      }
      if (r.kind === "image") return setState({ path: r.path, kind: "image" });
      if (r.kind === "missing") return setState({ path: r.path, kind: "missing" });
      const f = await hub().readFile(r.path);
      setState({ path: r.path, kind: f.kind, text: f.kind === "text" ? f.text : undefined, line: (r as { line?: number }).line });
    })().catch(() => setState({ path: cur, kind: "missing" }));
  }, [cur, session?.id]);
  useEffect(() => {
    if (tab === "diff" && diff === null && state && session) void hub().gitDiff(session.cwd, state.path).then((d) => setDiff(d || "")).catch(() => setDiff(""));
  }, [tab, state?.path]);
  const lines = state?.text?.split("\n") ?? [];
  return (
    <Sheet onClose={onClose} full>
      <div className="mx-file-h">
        <span className="mx-file-dir">{state ? state.path.replace(/\/[^/]*$/, "/").replace(/^\/Users\/[^/]+/, "~") : ""}</span>
        <span className="mx-file-row">
          <b>{state ? baseName(state.path) : baseName(cur)}</b>
          {state && state.kind !== "dir" && state.kind !== "missing" && (
            <button className="mx-file-save" onClick={() => void saveFile(state.path)}>
              Save
            </button>
          )}
        </span>
      </div>
      {state?.kind === "text" && session && (
        <div className="mx-tabs2">
          <button className={tab === "file" ? "on" : ""} onClick={() => setTab("file")}>
            File
          </button>
          <button className={tab === "diff" ? "on" : ""} onClick={() => setTab("diff")}>
            Changes
          </button>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(state.path).catch(() => {});
            }}
          >
            Copy path
          </button>
        </div>
      )}
      <div className="mx-file-body">
        {!state ? (
          <div className="mx-muted">loading…</div>
        ) : state.kind === "missing" ? (
          <div className="mx-muted">Couldn't find this file.</div>
        ) : /\.html?$/i.test(state.path) && state.kind === "text" ? (
          <iframe className="mx-file-pdf html-frame" sandbox="allow-scripts" title="preview" src={fileUrl(state.path)} />
        ) : isSheetPath(state.path) ? (
          <SheetView path={state.path} />
        ) : state.kind === "image" ? (
          <img className="mx-file-img" src={fileUrl(state.path)} alt={baseName(state.path)} />
        ) : state.kind === "pdf" ? (
          <PdfView path={state.path} />
        ) : state.kind === "dir" ? (
          <div className="mx-list">
            {state.entries?.map((e) => (
              <button key={e.path} className="mx-row" onClick={() => setCur(e.path)}>
                <span className="mx-row-main">
                  <span className="mx-row-t">
                    {e.dir ? "▸ " : ""}
                    {e.name}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : tab === "diff" ? (
          <pre className="mx-code">
            {diff === null
              ? "loading…"
              : diff
                ? diff.split("\n").map((l, i) => (
                    <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>
                      {l}
                      {"\n"}
                    </span>
                  ))
                : "No uncommitted changes in this file."}
          </pre>
        ) : state.kind === "text" ? (
          <pre className="mx-code">
            {lines.slice(0, 1500).map((l, i) => (
              <span key={i} className={state.line === i + 1 ? "hl" : ""}>
                <i>{i + 1}</i>
                {l}
                {"\n"}
              </span>
            ))}
          </pre>
        ) : (
          <div className="mx-muted">This file can't be previewed here.</div>
        )}
      </div>
    </Sheet>
  );
}

function PermissionSheet({ s }: { s: SessionState }) {
  const p = s.pending!;
  const who = s.engine === "claude" ? "Claude" : s.engine === "codex" ? "Codex" : "Cursor";
  const answer = (d: "allow" | "allow_always" | "deny") => void hub().respondPermission(p.requestId, d);
  if (isPromptTool(p.tool))
    return (
      <Sheet onClose={() => {}} full>
        <div className="mx-sheet-pad">{p.tool === "AskUserQuestion" ? <QuestionCard p={p} who={who} /> : <PlanCard p={p} who={who} />}</div>
      </Sheet>
    );
  const cmd = String((p.input.command as string) ?? (p.input.file_path as string) ?? (p.input.url as string) ?? JSON.stringify(p.input)).slice(0, 600);
  return (
    <Sheet onClose={() => {}}>
      <h4 className="mx-sheet-title">Allow {who} to use {p.tool.replace(/^mcp__[^_]+__/, "")}?</h4>
      {p.reason && <div className="mx-sheet-sub">{p.reason}</div>}
      <pre className="mx-cmd">{cmd}</pre>
      <div className="mx-btnrow">
        <button className="mx-btn bad" onClick={() => answer("deny")}>
          Deny
        </button>
        <button className="mx-btn" onClick={() => answer("allow_always")}>
          Always
        </button>
        <button className="mx-btn primary" onClick={() => answer("allow")}>
          Allow
        </button>
      </div>
    </Sheet>
  );
}

function InfoSheet({ s, onClose, onGone }: { s: SessionState; onClose(): void; onGone(): void }) {
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const g = s.git;
  const system = s.isManager || s.isCloud || s.isEmail;
  return (
    <Sheet onClose={onClose}>
      {renaming ? (
        <input
          className="mx-input mx-sheet-in"
          defaultValue={s.title}
          autoFocus
          onBlur={(e) => {
            void hub().rename(s.id, e.target.value);
            setRenaming(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <h4 className="mx-sheet-title">{s.title}</h4>
      )}
      <div className="mx-sheet-sub">
        {s.engine} · {s.model ?? "default model"} · {s.permissionMode === "bypassPermissions" || s.codexSandbox === "danger-full-access" || s.cursorMode === "full" ? "max permissions" : "asks first"}
      </div>
      {!system && (
        <KV
          rows={[
            (s.worktree?.branch || g?.branch) && ["Branch", s.worktree?.branch ?? g?.branch],
            g && ["Status", g.merged ? <span className="ok">merged</span> : g.dirty ? `${num(g.dirty)} uncommitted` : g.ahead ? `${num(g.ahead)} commits ahead` : "clean"],
            g?.deploys?.length ? ["Deployed", g.deploys.filter(isDeployed).map((d) => d.tenant).join(", ") || "not yet"] : null,
            ["Work", `${s.items.filter((i) => i.kind === "tool").length} steps · ${s.tokens ? `${Math.round(s.tokens / 1000)}k tok` : "0 tok"}`],
            s.linearIssue && ["Linear", s.linearIssue],
          ]}
        />
      )}
      <Actions
        items={[
          { label: "Rename", onClick: () => setRenaming(true) },
          s.status === "running" && { label: "Stop", onClick: () => void hub().interrupt(s.id) },
          system && s.items.length > 0 && { label: "New chat", onClick: () => (void hub().newSystemChat(s.id), onClose()) },
          !system && {
            label: s.archived ? "Unarchive" : "Archive",
            onClick: () => {
              void hub().setArchived(s.id, !s.archived);
              toast(s.archived ? "Unarchived" : "Archived");
              onClose();
              if (!s.archived) onGone();
            },
          },
          !system && {
            label: confirmDel ? "Tap again to delete for good" : "Delete",
            danger: true,
            onClick: () => {
              if (!confirmDel) return setConfirmDel(true);
              void hub()
                .remove(s.id)
                .then(() => (onClose(), onGone()))
                .catch((e) => toast(cleanErr(e)));
            },
          },
        ]}
      />
    </Sheet>
  );
}

function SettingsSheet({ s, onClose }: { s: SessionState; onClose(): void }) {
  return (
    <Sheet onClose={onClose}>
      <h4 className="mx-sheet-title">Session settings</h4>
      {s.engine === "claude" && (
        <>
          <div className="mx-sheet-label">Model</div>
          <div className="mx-optlist">
            {CLAUDE_MODELS.map((m) => (
              <button key={m.label} className={(s.model ?? null) === m.id ? "on" : ""} onClick={() => void hub().setModel(s.id, m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="mx-sheet-label">Permissions</div>
          <div className="mx-optlist">
            {PERMISSION_MODES.map((m) => (
              <button key={m.value} className={(s.permissionMode ?? "default") === m.value ? "on" : ""} onClick={() => void hub().setPermissionMode(s.id, m.value)}>
                {m.label}
              </button>
            ))}
          </div>
        </>
      )}
      {s.engine !== "claude" && <div className="mx-sheet-sub">Model and permissions for {s.engine} sessions are set on the laptop.</div>}
    </Sheet>
  );
}

/** One session as a chat. `send` overrides delivery (the Cloud chat attaches the current board). */
export function MSession({ s, onBack, title, send, placeholder }: { s: SessionState; onBack(): void; title?: string; send?(text: string): void; placeholder?: string }) {
  const toast = useToast();
  const [file, setFile] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"info" | "settings" | "todos" | "pins" | null>(null);
  const [text, setText] = useDraft<string>(s.id, "");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const blocks = useMemo(() => blocksOf(s.items), [s.items]);
  const lastAssistant = [...s.items].reverse().find((i) => i.kind === "assistant");
  const busy = s.status === "running";
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.items.length, s.pending, busy]);
  const pane = useMemo<PaneApi>(() => ({ open: () => {}, openLink: (href) => (/^https?:\/\//i.test(href) ? void window.open(href, "_blank") : setFile(href)) }), []);
  const submit = (t = text) => {
    const v = t.trim();
    if (!v) return;
    stick.current = true;
    if (send) send(v);
    else void hub().send(s.id, v).catch((e) => toast(cleanErr(e)));
    if (t === text) setText("");
  };
  return (
    <PaneContext.Provider value={pane}>
      <div className="mx-screen">
        <Nav
          onBack={onBack}
          title={
            <span className="mx-title-stack">
              <span>{title ?? s.title}</span>
              {busy ? <small className="run">working…</small> : s.status === "needs_permission" ? <small className="need">needs you</small> : s.status === "error" ? <small className="bad">stopped</small> : null}
            </span>
          }
          right={
            <span className="mx-navbtns">
              {s.items.some((i) => i.pinned) && (
                <IconBtn label="Pinned replies" onClick={() => setSheet("pins")}>
                  <Pin size={18} />
                </IconBtn>
              )}
              {!s.isManager && !s.isCloud && !s.isEmail && (
                <IconBtn label="Reminders and follow-ups" onClick={() => setSheet("todos")}>
                  <Bell size={18} />
                  {openTodos(s).length > 0 && <span className={`mx-navdot ${openTodos(s).some(isOverdue) ? "hot" : ""}`}>{openTodos(s).length}</span>}
                </IconBtn>
              )}
              <IconBtn label="Session info" onClick={() => setSheet("info")}>
                <Info size={18} />
              </IconBtn>
            </span>
          }
        />
        {(() => {
          // Phone: the next reminder as a slim strip under the top bar (tap for the full list).
          const next = openTodos(s)
            .filter((t) => t.kind === "reminder")
            .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity))[0];
          const n = openTodos(s).length;
          if (!n || s.isManager || s.isCloud || s.isEmail) return null;
          return (
            <button className={`mx-todostrip ${next && isOverdue(next) ? "overdue" : ""}`} onClick={() => setSheet("todos")}>
              <Bell size={13} />
              <span className="mx-todostrip-t">{next ? next.text : `${n} follow-up${n === 1 ? "" : "s"}`}</span>
              {next?.due && <span className="mx-todostrip-d">{dueLabel(next.due)}</span>}
              {n > 1 && <span className="mx-todostrip-d">+{n - 1}</span>}
            </button>
          );
        })()}
        <div
          className="mx-chat"
          ref={scroller}
          onScroll={() => {
            const el = scroller.current!;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {!blocks.length && <div className="mx-muted mx-center">{placeholder ?? "Send a message to start."}</div>}
          {blocks.map((b) =>
            b.kind === "steps" ? (
              <Steps key={b.items[0].id} items={b.items} />
            ) : b.it.kind === "user" ? (
              <div key={b.it.id} className="mx-msg-u">
                {b.it.text}
                {b.it.images?.map((p) => <img key={p} src={fileUrl(p)} alt="" onClick={() => openLightbox(fileUrl(p))} />)}
                <LinkCards text={b.it.text} />
              </div>
            ) : b.it.kind === "tags" ? (
              <div key={b.it.id} className="mx-tagnote">
                {b.it.text}
              </div>
            ) : b.it.kind === "assistant" ? (
              <Fragment key={b.it.id}>
                <AssistantMsg it={b.it} sessionId={s.id} />
                {b.it.id === lastAssistant?.id && !busy && (
                  <div className="mx-quick">
                    <button onClick={() => submit(WTF)}>wtf</button>
                    <button onClick={() => submit("Status?")}>status</button>
                    {!b.it.simplified && <button onClick={() => void hub().simplify(s.id, b.it.id)}>simplify</button>}
                    <button onClick={() => submit("continue")}>continue</button>
                  </div>
                )}
              </Fragment>
            ) : b.it.kind === "error" ? (
              <ErrorCard key={b.it.id} it={b.it} />
            ) : null,
          )}
          {busy && (
            <div className="mx-working">
              <i />
              {s.engine === "claude" ? "Claude" : s.engine === "codex" ? "Codex" : "Cursor"} is working
            </div>
          )}
          <QueuedMessages s={s} mobile />
          <NextSteps s={s} mobile />
        </div>
        <div className="mx-composer">
          {s.engine === "claude" && !s.isCloud && (
            <button className="mx-cbtn ghost" onClick={() => setSheet("settings")} aria-label="Session settings">
              <SlidersHorizontal size={17} />
            </button>
          )}
          <textarea
            className="mx-cin"
            rows={1}
            value={text}
            placeholder={busy ? "Queue a message" : "Message"}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
          />
          {busy && !text.trim() ? (
            <button className="mx-cbtn stop" onClick={() => void hub().interrupt(s.id)} aria-label="Stop">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button className="mx-cbtn send" disabled={!text.trim()} onClick={() => submit()} aria-label="Send">
              <ArrowUp size={18} strokeWidth={2.4} />
            </button>
          )}
        </div>
        {s.pending && <PermissionSheet s={s} />}
        {sheet === "info" && <InfoSheet s={s} onClose={() => setSheet(null)} onGone={onBack} />}
        {sheet === "pins" && (
          <Sheet onClose={() => setSheet(null)} full>
            <h4 className="mx-sheet-title">Pinned</h4>
            <div className="mx-pins">
              {s.items
                .filter((i) => i.pinned)
                .map((it) => (
                  <div key={it.id} className="mx-pin-card">
                    <Markdown text={it.simplified ?? it.text} />
                    <button className="mx-link" onClick={() => void hub().pinItem(s.id, it.id, false)}>
                      unpin
                    </button>
                  </div>
                ))}
            </div>
          </Sheet>
        )}
        {sheet === "todos" && (
          <Sheet onClose={() => setSheet(null)} full>
            <h4 className="mx-sheet-title">Reminders and follow-ups</h4>
            <div className="mx-todos">
              <TodoList s={s} autoFocus={!openTodos(s).length} />
            </div>
          </Sheet>
        )}
        {sheet === "settings" && <SettingsSheet s={s} onClose={() => setSheet(null)} />}
        {file && <FileSheet link={file} session={s} onClose={() => setFile(null)} />}
      </div>
    </PaneContext.Provider>
  );
}

function AssistantMsg({ it, sessionId }: { it: TranscriptItem; sessionId: string }) {
  const [orig, setOrig] = useState(false);
  const [copied, setCopied] = useState(false);
  const show = it.simplified && !orig ? it.simplified : it.text;
  return (
    <div className="mx-msg-a">
      <Markdown text={show} />
      <span className="mx-msg-acts">
        {it.simplified && (
          <button className="mx-link" onClick={() => setOrig(!orig)}>
            {orig ? "show simple version" : "show original"}
          </button>
        )}
        <button
          className={`mx-pin ${copied ? "on" : ""}`}
          onClick={() =>
            void navigator.clipboard.writeText(it.text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          <Copy size={12} /> {copied ? "copied" : "copy"}
        </button>
        {sessionId && (
          <button className={`mx-pin ${it.pinned ? "on" : ""}`} onClick={() => void hub().pinItem(sessionId, it.id, !it.pinned)}>
            <Pin size={12} /> {it.pinned ? "pinned" : "pin"}
          </button>
        )}
      </span>
    </div>
  );
}

/** New chat: engine + worktree, then type. */
export function MNewChat({ onBack, onCreated, defaultEngine }: { onBack(): void; onCreated(id: string): void; defaultEngine: Engine }) {
  const repo = useRepo();
  const toast = useToast();
  const [engine, setEngine] = useState<Engine>(defaultEngine);
  const [worktree, setWorktree] = useState(true);
  const [text, setText] = useDraft<string>("new-chat", "");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const s = await hub().create({ engine, cwd: repo, prompt: text.trim(), worktree });
      setText("");
      onCreated(s.id);
    } catch (e) {
      toast(cleanErr(e));
      setBusy(false);
    }
  };
  return (
    <div className="mx-screen">
      <Nav onBack={onBack} title="New chat" />
      <div className="mx-newchat">
        <Seg value={engine} onChange={setEngine} options={[["claude", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"]]} />
        <label className="mx-check">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> own branch + worktree
        </label>
        <div className="mx-muted">{baseName(repo)}</div>
      </div>
      <div className="mx-composer">
        <textarea className="mx-cin" rows={2} autoFocus value={text} placeholder={`What should ${engine === "claude" ? "Claude" : engine === "codex" ? "Codex" : "Cursor"} do?`} onChange={(e) => setText(e.target.value)} />
        <button className="mx-cbtn send" disabled={!text.trim() || busy} onClick={() => void start()} aria-label="Start">
          <ArrowUp size={18} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  );
}

/** Small status line for a session row. */
export function sessionStatus(s: SessionState): { label: string; tone?: "run" | "need" | "bad" } {
  if (s.preparing) return { label: "setting up", tone: "run" };
  if (s.status === "running") return { label: "working", tone: "run" };
  if (s.status === "needs_permission") return { label: "needs you", tone: "need" };
  if (s.status === "error") return { label: "stopped", tone: "bad" };
  if (s.status === "idle" && s.processes?.length) return { label: `background · ${num(s.processes.length)}`, tone: "run" };
  const g = s.git;
  if (g?.dirty) return { label: "uncommitted" };
  if (g?.ahead && !g.merged) return { label: "not merged" };
  if (g?.merged) return { label: "merged" };
  return { label: "idle" };
}
export { ago, Pill };
