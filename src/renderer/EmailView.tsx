import { Star } from "lucide-react";
import { num } from "./models";
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EmailAttachment, EmailMessage, EmailThread, EmailThreadDetail, GmailStatus, Inbox, SessionState, TriageRun, TriageVerdict } from "../shared/types";
import { MAIL_FOLDERS, NEW_EMAIL, mailFolder } from "../shared/types";
import { SessionView } from "./SessionView";
import { hub } from "./App";
import { FilePreview } from "./PreviewPane";
import { Person, RecipientInput, useContacts } from "./contacts";
import { useMenu } from "./Menu";
import { ResizeHandle, usePanelWidth } from "./resize";
import { useToast } from "./toast";

/** Quoted history in common clients; hidden until "show quoted" is clicked. */
const QUOTE_SEL = ".gmail_quote, blockquote[type=cite], .yahoo_quoted, #appendonsend ~ *, #divRplyFwdMsg, #divRplyFwdMsg ~ *, .protonmail_quote";

/**
 * An email's HTML, sanitized (no scripts, forms or embeds) and rendered in a sandboxed frame so its styles can't touch
 * the app. Links open in your browser.
 */
export function HtmlBody({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [quoted, setQuoted] = useState(false);
  const [hasQuote, setHasQuote] = useState(false);
  const doc = useMemo(() => {
    const clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ["style"],
      FORBID_TAGS: ["script", "form", "input", "button", "iframe", "object", "embed", "link", "meta", "base"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
    });
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
      html,body{margin:0;padding:0;background:#fff;color:#1f1f1f;font:14px/1.5 -apple-system,system-ui,sans-serif;overflow-wrap:anywhere}
      html{overflow:hidden} body{padding:12px 14px;overflow-x:auto;overflow-y:hidden} img{max-width:100%;height:auto} table{max-width:100%} a{color:#1a56db}
    </style>${(clean.match(/<style[\s\S]*?<\/style>/gi) ?? []).join("")}<style>${quoted ? "" : `${QUOTE_SEL}{display:none!important}`}</style></head><body>${clean.replace(/^[\s\S]*<body[^>]*>|<\/body>[\s\S]*$/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")}</body></html>`;
  }, [html, quoted]);
  // The frame is always as tall as its email (no scrolling inside it), so only the thread scrolls.
  const ro = useRef<ResizeObserver | null>(null);
  useEffect(() => () => ro.current?.disconnect(), []);
  const fit = () => {
    const d = frame.current?.contentDocument;
    if (!d?.body) return;
    setHasQuote(!!d.querySelector(QUOTE_SEL));
    const size = () => frame.current && (frame.current.style.height = `${d.body.scrollHeight}px`);
    size();
    ro.current?.disconnect();
    ro.current = new ResizeObserver(size);
    ro.current.observe(d.body);
    d.querySelectorAll("img").forEach((img) => img.addEventListener("load", size, { once: true }));
  };
  return (
    <div className="em-html">
      <iframe ref={frame} title="email" scrolling="no" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} onLoad={fit} />
      {hasQuote && (
        <button className="em-quote-btn" onClick={() => setQuoted(!quoted)} title={quoted ? "Hide quoted text" : "Show quoted text"}>
          {quoted ? "hide quoted" : "···"}
        </button>
      )}
    </div>
  );
}

const emailsIn = (raw: string) => [...raw.matchAll(/[^\s<>,"]+@[^\s<>,"]+/g)].map((m) => m[0].toLowerCase());

const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Gmail-style date: time today, "Oct 21" this year, else numeric. */
function shortDate(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { year: "2-digit", month: "numeric", day: "numeric" });
}
const longDate = (ts: number) => new Date(ts).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function Setup({ status, onStatus }: { status: GmailStatus; onStatus(s: GmailStatus): void }) {
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const run = async (fn: () => Promise<GmailStatus>) => {
    setBusy(true);
    setErr(undefined);
    try {
      onStatus(await fn());
    } catch (e) {
      setErr(cleanErr(e));
    }
    setBusy(false);
  };
  return (
    <div className="tk-connect">
      <h2>Connect Gmail</h2>
      {!status.hasClient ? (
        <>
          <p className="muted">
            Paste a Google <b>Desktop</b> OAuth client (ID and secret). Your team can share one (see SETUP.md). It's encrypted with your macOS keychain and only
            used to sign you in to Google.
          </p>
          <a className="cl-ext" href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">
            open OAuth clients ↗
          </a>
          <form
            className="em-setup"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => hub().gmailSetClient(id, secret));
            }}
          >
            <input id="gmail-client-id" placeholder="Client ID (…apps.googleusercontent.com)" value={id} onChange={(e) => setId(e.target.value)} spellCheck={false} autoComplete="off" />
            <input id="gmail-client-secret" type="password" placeholder="Client secret" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} autoComplete="off" />
            <button className="kb" type="submit" disabled={busy || !id.trim() || !secret.trim()}>
              save
            </button>
          </form>
        </>
      ) : (
        <>
          <p className="muted">Sign in with your Google account. Happy can read, star, archive and save drafts. It only sends when you click Send.</p>
          <div className="tk-connect-row">
            <button className="tk-go" disabled={busy} onClick={() => void run(() => hub().gmailSignIn())}>
              {busy ? "waiting for Google…" : "sign in with Google"}
            </button>
            <button className="link-btn" onClick={() => void hub().gmailSignOut().then(() => onStatus({ hasClient: false, connected: false }))}>
              use a different client
            </button>
          </div>
        </>
      )}
      {(err || status.error) && <div className="tk-err">{err ?? status.error}</div>}
    </div>
  );
}

function Row({ t, active, checked, onCheck, onOpen, onStar, verdict }: { t: EmailThread; active: boolean; checked: boolean; onCheck(shift: boolean): void; onOpen(): void; onStar(): void; verdict?: TriageVerdict }) {
  return (
    <div className={`em-row ${t.unread ? "unread" : ""} ${active ? "on" : ""} ${checked ? "checked" : ""}`} onClick={onOpen}>
      <input
        type="checkbox"
        className="em-check"
        checked={checked}
        aria-label="Select"
        onClick={(e) => {
          e.stopPropagation();
          onCheck(e.shiftKey);
        }}
        onChange={() => {}}
      />
      <button
        className={`em-star ${t.starred ? "on" : ""}`}
        title={t.starred ? "Unstar" : "Star (important)"}
        onClick={(e) => {
          e.stopPropagation();
          onStar();
        }}
      >
        <Star size={14} fill={t.starred ? "currentColor" : "none"} />
      </button>
      <span className="em-from">
        {t.important && !t.starred && <span className="em-imp" title="Gmail marked this important">›</span>}
        {t.lastFromMe && t.to && !t.inInbox ? <><span className="muted">to </span>{t.to}</> : t.from}
        {t.count > 1 && <span className="em-count">{num(t.count)}</span>}
      </span>
      <span className="em-subj">
        <b>{t.subject}</b>
        <span className="em-snip"> · {t.snippet}</span>
      </span>
      <span className="em-date">{shortDate(t.date)}</span>
      {verdict && <span className={`em-verdict ${verdict.verdict}`}>{verdict.verdict}</span>}
    </div>
  );
}

function Reply({ thread, onSent }: { thread: EmailThreadDetail; onSent?(): void }) {
  const toast = useToast();
  const [instruction, setInstruction] = useState("");
  const [body, setBody] = useState("");
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [busy, setBusy] = useState<"draft" | "save" | "send" | null>(null);
  const [draftId, setDraftId] = useState<string>();
  // A draft that isn't a reply (a new email) has its own subject to edit.
  const standalone = !!thread.draft && thread.messages.length === 0;
  const [subject, setSubject] = useState("");
  const [saved, setSaved] = useState<string>();
  const [confirmSend, setConfirmSend] = useState(false);
  useEffect(() => {
    setConfirmSend(false);
    setInstruction("");
    // A saved draft opens ready to edit or send.
    if (thread.draft) {
      const d = thread.draft;
      setBody(d.body);
      setTo(d.to);
      setCc(d.cc);
      setShowCc(d.cc.length > 0);
      setDraftId(d.id);
      setSubject(d.subject);
      setSaved(JSON.stringify([d.to, d.cc, d.body, d.subject]));
      return;
    }
    setBody("");
    setDraftId(undefined);
    setSaved(undefined);
    setTo([]);
    setCc([]);
    void hub()
      .emailReplyDefaults(thread.id)
      .then((r) => {
        setTo(r.to);
        setCc(r.cc);
        setShowCc(r.cc.length > 0);
      })
      .catch(() => {});
  }, [thread.id, thread.draft?.id]);
  const snapshot = JSON.stringify(thread.draft ? [to, cc, body, subject] : [to, cc, body]);
  const rcpt = { to, cc };

  const draft = async () => {
    setBusy("draft");
    try {
      const text = await hub().emailDraft(thread.id, instruction, to);
      // New emails come back as "Subject: …" then the body.
      const m = !thread.id ? text.match(/^Subject:\s*(.+)\n+/i) : null;
      if (m) {
        setSubject(m[1].trim());
        setBody(text.slice(m[0].length).trim());
      } else setBody(text);
    } catch (e) {
      toast(`Couldn't draft: ${cleanErr(e)}`);
    }
    setBusy(null);
  };
  const save = async () => {
    setBusy("save");
    try {
      setDraftId(await hub().emailSaveDraft(thread.id, body, rcpt, draftId, standalone ? subject : undefined));
      setSaved(snapshot);
      toast("Saved to Gmail drafts");
    } catch (e) {
      toast(`Couldn't save: ${cleanErr(e)}`);
    }
    setBusy(null);
  };
  const send = async () => {
    setBusy("send");
    try {
      const id = saved === snapshot && draftId ? draftId : await hub().emailSaveDraft(thread.id, body, rcpt, draftId, standalone ? subject : undefined);
      await hub().emailSend(id);
      toast("Sent");
      setBody("");
      setDraftId(undefined);
      setSaved(undefined);
      onSent?.();
    } catch (e) {
      toast(`Couldn't send: ${cleanErr(e)}`);
    }
    setConfirmSend(false);
    setBusy(null);
  };

  return (
    <div className="em-reply">
      <div className="em-rcpts">
        <RecipientInput id="email-to" label="To" value={to} onChange={setTo} placeholder="add recipients" />
        {standalone && (
          <label className="em-subject">
            <span className="muted small">Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="subject" />
          </label>
        )}
        {showCc ? (
          <RecipientInput id="email-cc" label="Cc" value={cc} onChange={setCc} />
        ) : (
          <button className="link-btn em-cc-btn" onClick={() => setShowCc(true)}>
            cc
          </button>
        )}
      </div>
      <div className="em-reply-ai">
        <input
          id="email-instruction"
          placeholder={thread.id ? "what should the reply say? (optional)" : "what should the email say?"}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && void draft()}
          spellCheck={false}
        />
        <button className="kb" disabled={!!busy} onClick={() => void draft()}>
          {busy === "draft" ? "drafting…" : body ? "redraft with Claude" : "draft with Claude"}
        </button>
      </div>
      <textarea id="email-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder={thread.id ? "Reply…" : "Write your email…"} rows={body ? Math.min(14, body.split("\n").length + 2) : thread.id ? 3 : 8} />
      <div className="em-reply-acts">
        <span className="muted small">{draftId ? (saved === snapshot ? "saved in Gmail drafts" : "edited since saving") : "not saved"}</span>
        <button className="kb" disabled={!body.trim() || !to.length || !!busy} onClick={() => void save()}>
          {busy === "save" ? "saving…" : "save draft"}
        </button>
        {confirmSend ? (
          <>
            <button className="tk-go em-send" disabled={!!busy} onClick={() => void send()}>
              {busy === "send" ? "sending…" : `send to ${to.length + cc.length}`}
            </button>
            <button className="link-btn" onClick={() => setConfirmSend(false)}>
              cancel
            </button>
          </>
        ) : (
          <button className="tk-go" disabled={!body.trim() || !to.length || !!busy} onClick={() => setConfirmSend(true)}>
            send
          </button>
        )}
      </div>
    </div>
  );
}

export const fmtSize = (n: number) => (!n ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const attKind = (a: EmailAttachment) => {
  const ext = a.name.split(".").pop()?.toLowerCase() ?? "";
  if (a.mimeType.startsWith("image/")) return "IMG";
  if (ext === "pdf" || a.mimeType === "application/pdf") return "PDF";
  if (/^(xlsx?|xlsm|csv|tsv|ods)$/.test(ext)) return "XLS";
  if (/^(docx?|odt|rtf)$/.test(ext)) return "DOC";
  if (/^(pptx?|key)$/.test(ext)) return "PPT";
  if (/^(zip|gz|tar|7z)$/.test(ext)) return "ZIP";
  return ext.slice(0, 4).toUpperCase() || "FILE";
};

/** Attachment chips: click to download (once) and open in Happy's preview pane; "open" uses the Mac's default app. */
function Attachments({ messageId, list }: { messageId: string; list: Array<EmailAttachment | string> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const atts = list.map((a) => (typeof a === "string" ? { name: a, mimeType: "", size: 0, id: "" } : a));
  const get = async (a: EmailAttachment, external: boolean) => {
    if (!a.id) return toast("Refresh this thread to open its attachments.");
    setBusy(a.id);
    try {
      const path = await hub().emailAttachment(messageId, a);
      if (external) await hub().openFile(path);
      else window.dispatchEvent(new CustomEvent("happy:preview-file", { detail: path }));
    } catch (e) {
      toast(`Couldn't get ${a.name}: ${cleanErr(e)}`);
    }
    setBusy(null);
  };
  return (
    <div className="em-atts">
      {atts.map((a) => (
        <div key={a.id || a.name} className="em-att-chip" title={a.name}>
          <button className="em-att-main" onClick={() => void get(a, false)} disabled={busy === a.id}>
            <span className={`em-att-kind k-${attKind(a).toLowerCase()}`}>{attKind(a)}</span>
            <span className="em-att-name">{a.name}</span>
            <span className="em-att-size">{busy === a.id ? "…" : fmtSize(a.size)}</span>
          </button>
          <button className="em-att-open" onClick={() => void get(a, true)} title="Open in the default app">
            open
          </button>
        </div>
      ))}
    </div>
  );
}

function MessageView({ m, me }: { m: EmailMessage; me: string }) {
  const people = (raw: string) =>
    emailsIn(raw).map((e, i) => (
      <span key={e}>
        {i > 0 && ", "}
        <Person email={e} me={me} />
      </span>
    ));
  return (
    <>
      <div className="muted small em-to">
        to {people(m.to)}
        {m.cc && <> · cc {people(m.cc)}</>}
      </div>
      {m.html ? <HtmlBody html={m.html} /> : <div className="em-body">{m.text || "(no text)"}</div>}
      {m.attachments.length > 0 && <Attachments messageId={m.id} list={m.attachments} />}
    </>
  );
}

const PERSONAL_DOMAINS = /^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|aol|proton|protonmail)\./i;

function ThreadPane({ id, me, onArchive, onSpam, onStar, starred, onClose }: { id: string; me: string; onArchive(): void; onSpam(): void; onStar(): void; starred: boolean; onClose?(): void }) {
  const toast = useToast();
  const menu = useMenu();
  const [t, setT] = useState<EmailThreadDetail | null>(null);
  const [err, setErr] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setT(null);
    setErr(undefined);
    hub()
      .emailThread(id)
      .then((d) => {
        setT(d);
        setExpanded(new Set(d.messages.slice(-2).map((m) => m.id)));
      })
      .catch((e) => setErr(cleanErr(e)));
  }, [id]);
  useEffect(() => {
    if (t) requestAnimationFrame(() => scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight));
  }, [t?.id]);
  if (err) return <div className="tk-err pad">{err}</div>;
  if (!t) return <div className="muted pad center mono small">loading…</div>;
  return (
    <div className="em-thread">
      <div className="em-thread-h stacked">
        <h2>{t.subject}</h2>
        {onClose && (
          <button className="icon-btn em-close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        )}
        <button className={`em-star big ${starred ? "on" : ""}`} onClick={onStar} title="Star (s)">
          <Star size={17} fill={starred ? "currentColor" : "none"} />
        </button>
        <button className="kb" onClick={onArchive} title="Archive (e)">
          archive
        </button>
        <button className="kb" onClick={onSpam} title="Report spam (!)">
          spam
        </button>
        {(() => {
          const sender = [...t.messages].reverse().find((m) => !m.fromMe)?.fromEmail;
          if (!sender) return null;
          const domain = sender.split("@")[1];
          const rule = async (from: string) => {
            try {
              const n = await hub().emailAutoArchive(from, true);
              toast(`Gmail will archive mail from ${from}${n ? ` · archived ${n} already in the inbox` : ""}`);
              onArchive();
            } catch (e) {
              toast(cleanErr(e));
            }
          };
          return (
            <button
              className="kb"
              title="Create a Gmail filter"
              onClick={(e) =>
                menu.below(
                  e.currentTarget,
                  [
                    { type: "header", label: "Gmail filter: skip the inbox" },
                    { label: `Always archive from ${sender}`, onSelect: () => void rule(sender) },
                    ...(domain && !PERSONAL_DOMAINS.test(domain) ? [{ label: `Always archive from anyone at ${domain}`, onSelect: () => void rule(`@${domain}`) }] : []),
                  ],
                  true,
                )
              }
            >
              always archive ▾
            </button>
          );
        })()}
      </div>
      <div className="em-msgs" ref={scroller}>
        {t.messages.map((m) => {
          const open = expanded.has(m.id);
          return (
            <div key={m.id} className={`em-msg ${open ? "open" : ""}`}>
              <button className="em-msg-h" onClick={() => setExpanded((s) => new Set(open ? [...s].filter((x) => x !== m.id) : [...s, m.id]))}>
                <b>{m.fromMe ? "me" : <Person email={m.fromEmail} name={m.from} />}</b>
                {!m.fromMe && <span className="muted small">{m.fromEmail}</span>}
                <span className="em-msg-date">{longDate(m.date)}</span>
              </button>
              {open ? (
                <MessageView m={m} me={me} />
              ) : (
                <div className="em-collapsed">{m.text.replace(/\s+/g, " ").slice(0, 140)}</div>
              )}
            </div>
          );
        })}
      </div>
      <Reply thread={t} />
    </div>
  );
}

function ZeroInbox({ onClose, onOpen }: { onClose(): void; onOpen(id: string): void }) {
  const toast = useToast();
  const [run, setRun] = useState<TriageRun | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void hub()
      .emailTriageRun()
      .then((r) => (r ? setRun(r) : hub().emailTriage().then(setRun)));
    return hub().onTriage(setRun);
  }, []);
  const picked = new Set(run?.picked ?? []);
  const setPicked = (next: Set<string>) => {
    setRun((r) => (r ? { ...r, picked: [...next] } : r));
    void hub().emailTriagePick([...next]);
  };
  const group = (k: TriageVerdict["verdict"]) => (run?.verdicts ?? []).filter((v) => v.verdict === k);
  const inRun = new Set((run?.verdicts ?? []).map((v) => v.id));
  const live = [...picked].filter((id) => inRun.has(id));
  const archive = async () => {
    setBusy(true);
    try {
      await hub().emailArchive(live);
      toast(`Archived ${num(live.length)} threads`);
    } catch (e) {
      toast(`Couldn't archive: ${cleanErr(e)}`);
    }
    setBusy(false);
  };
  const section = (k: TriageVerdict["verdict"], title: string, hint: string) => {
    const rows = group(k);
    if (!rows.length) return null;
    return (
      <div className="em-z-sec">
        <h3>
          {title} <span className="ov-count">{num(rows.length)}</span> <span className="muted small em-z-hint">{hint}</span>
          <span className="em-z-sel">
            {rows.every((v) => picked.has(v.id)) ? (
              <button className="link-btn" onClick={() => setPicked(new Set([...picked].filter((id) => !rows.some((v) => v.id === id))))}>
                select none
              </button>
            ) : (
              <button className="link-btn" onClick={() => setPicked(new Set([...picked, ...rows.map((v) => v.id)]))}>
                select all
              </button>
            )}
          </span>
        </h3>
        {rows.map((v) => {
          const t = { id: v.id, from: v.from ?? "", subject: v.subject ?? "(thread)" };
          return (
            <label key={v.id} className="em-z-row">
              <input type="checkbox" checked={picked.has(v.id)} onChange={(e) => setPicked(new Set(e.target.checked ? [...picked, v.id] : [...picked].filter((x) => x !== v.id)))} />
              <span className="em-z-from">{t.from}</span>
              <span className="em-z-subj" onClick={(e) => (e.preventDefault(), onOpen(t.id))}>
                {t.subject}
              </span>
              <span className="em-z-why">{v.reason}</span>
            </label>
          );
        })}
      </div>
    );
  };
  const when = run ? new Date(run.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  return (
    <div className="em-zero">
      <div className="em-thread-h">
        <h2>Zero inbox</h2>
        <span className="muted small">{run ? (run.status === "running" ? `reading ${num(run.verdicts.length)}/${num(run.total)}…` : `run from ${when}`) : ""}</span>
        <button className="kb" disabled={run?.status === "running"} onClick={() => void hub().emailTriage().then(setRun)}>
          start over
        </button>
        <button className="link-btn" onClick={() => void hub().emailTriageClear().then(onClose)}>
          discard
        </button>
        <button className="link-btn" onClick={onClose} title="Close (the run stays saved)">
          close
        </button>
      </div>
      {run === undefined ? (
        <div className="muted pad mono small">loading…</div>
      ) : run?.status === "error" && !run.verdicts.length ? (
        <div className="tk-err pad">{run.error}</div>
      ) : (
        <>
          <div className="em-z-scroll">
            {run?.status === "error" && <div className="tk-err">{run.error}</div>}
            {run?.status === "running" && !run.verdicts.length && <div className="muted mono small">Claude is reading {num(run.total)} threads… you can leave this tab; the result is saved.</div>}
            {section("archive", "Archive", "nothing to do, or waiting on them (comes back when they reply)")}
            {section("reply", "Needs your reply", "")}
            {section("keep", "Keep", "")}
            {run?.status === "done" && !run.verdicts.length && <div className="muted pad center mono small">All handled ✓</div>}
          </div>
          <div className="em-reply-acts em-z-foot">
            <span className="muted small">archived threads return to the inbox when someone replies</span>
            <button className="tk-go" disabled={!live.length || busy} onClick={() => void archive()}>
              {busy ? "archiving…" : `archive ${num(live.length)}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Email: Gmail inbox with starred threads pinned, Claude drafts, and a zero-inbox pass. */
const ZERO_INBOX = "Zero inbox: go through my inbox, archive what I don't need to see, and tell me what's left that needs a reply or should stay.";
const MAIL_CHAT_KEY = "happy.mailchat.open";

/** Mail chat (right side): ask about email or have it act on mail. Zero inbox is a one-click macro. */
function MailChat({ sessions, openThread, onClose }: { sessions: Record<string, SessionState>; openThread?: EmailThread; onClose(): void }) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [width, setWidth] = usePanelWidth("email-chat", 400);
  useEffect(() => void hub().emailChat().then((c) => setChatId(c.id)), []);
  const chat = chatId ? sessions[chatId] : undefined;
  const dropZone = useRef<HTMLElement | null>(null);
  return (
    <>
      <ResizeHandle width={width} onWidth={setWidth} side="right" min={300} max={900} reset={400} />
      <aside className="cl-chat" style={{ width }}>
        <div className="cl-chat-h">
          <b>Mail chat</b>
          <span className="muted mono small em-chat-sees">{openThread ? `sees: ${openThread.subject}` : "sees: your inbox"}</span>
          <button className="link-btn" disabled={chat?.status === "running"} onClick={() => void hub().emailAsk(ZERO_INBOX)} title="Archive what you don't need, list what needs you">
            zero inbox
          </button>
          {chat && chat.items.length > 0 && (
            <button className="link-btn" disabled={chat.status === "running"} onClick={() => void hub().newSystemChat(chat.id)} title="Start a fresh conversation">
              new chat
            </button>
          )}
          <button className="icon-btn cl-min" title="Minimize" onClick={onClose}>
            –
          </button>
        </div>
        {chat ? (
          <SessionView
            key={chat.id}
            session={chat}
            dropZone={dropZone}
            onSend={(text) => void hub().emailAsk(text, openThread?.id)}
            placeholder={openThread ? "ask about this email, or tell me what to do" : "ask about your email, or tell me what to do"}
          />
        ) : (
          <div className="muted pad center mono small">starting…</div>
        )}
      </aside>
    </>
  );
}

export function EmailView({ sessions }: { sessions: Record<string, SessionState> }) {
  const toast = useToast();
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [zero, setZero] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  // Laptop widths: while a thread is open, the list turns into a slim column and the chat steps aside (its button brings it back).
  const [winW, setWinW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const [chatForced, setChatForced] = useState(false);
  useEffect(() => setChatForced(false), [sel]);
  const narrowThread = !!sel && winW < 1600;
  useEffect(() => {
    const on = (e: Event) => setPreview((e as CustomEvent<string>).detail);
    window.addEventListener("happy:preview-file", on);
    return () => window.removeEventListener("happy:preview-file", on);
  }, []);
  useEffect(() => {
    if (!preview) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setPreview(null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [preview]);
  const [chatOpen, setChatOpen] = useState(() => {
    try {
      return localStorage.getItem(MAIL_CHAT_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const chatShown = chatOpen && (!narrowThread || winW >= 1500 || chatForced);
  useEffect(() => {
    try {
      localStorage.setItem(MAIL_CHAT_KEY, chatOpen ? "1" : "0");
    } catch {}
  }, [chatOpen]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<TriageRun | null>(null);
  const [listWidth, setListWidth] = usePanelWidth("email-list", 460);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** "Select all N in inbox" (beyond this page). */
  const [allInbox, setAllInbox] = useState(false);
  const [keepStarred, setKeepStarred] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const lastCheck = useRef<string | null>(null);
  useContacts();

  useEffect(() => {
    void hub().gmailStatus().then(setStatus);
    void hub().emailTriageRun().then(setRun);
    const a = hub().onTriage(setRun);
    const b = hub().onGoogleStatus(setStatus);
    return () => (a(), b());
  }, []);
  useEffect(() => {
    if (!status?.connected) return;
    void hub().inbox().then(setInbox);
    return hub().onInbox(setInbox);
  }, [status?.connected]);

  const starred = inbox && !inbox.query ? inbox.starred : [];
  const rest = inbox?.threads ?? [];
  const ordered = useMemo(() => [...starred, ...rest], [starred, rest]);

  const star = (t: EmailThread) => void hub().emailStar(t.id, !t.starred).catch((e) => toast(`Couldn't star: ${cleanErr(e)}`));
  const archive = (id: string) => {
    const idx = ordered.findIndex((t) => t.id === id);
    const next = ordered[idx + 1] ?? ordered[idx - 1];
    void hub()
      .emailArchive([id])
      .then(() => {
        toast("Archived");
        setSel(next && next.id !== id ? next.id : null);
      })
      .catch((e) => toast(`Couldn't archive: ${cleanErr(e)}`));
  };

  // Gmail keys: j/k move, e archive (selection or current), a archive current, s star (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable) return;
      const idx = ordered.findIndex((t) => t.id === sel);
      if (e.key === "j" || e.key === "k") {
        const t = ordered[Math.max(0, Math.min(ordered.length - 1, idx + (e.key === "j" ? 1 : -1)))];
        if (t) setSel(t.id);
      } else if (e.key === "x" && sel) toggle(sel, false);
      else if (e.key === "!" && sel)
        void hub()
          .emailSpam([sel])
          .then(() => (toast("Reported as spam"), setSel(null)))
          .catch((er) => toast(cleanErr(er)));
      else if (e.key === "Escape" && sel && !document.querySelector(".em-preview")) setSel(null);
      else if (e.key === "a" && sel) archive(sel);
      else if (e.key === "e" && (picked.size || allInbox)) void archivePicked();
      else if (e.key === "e" && sel) archive(sel);
      else if (e.key === "s" && sel) {
        const t = ordered[idx];
        if (t) star(t);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!status) return <div className="muted pad center mono small">checking Gmail…</div>;
  if (!status.connected) return <Setup status={status} onStatus={setStatus} />;

  const selThread = ordered.find((t) => t.id === sel);
  const search = (query: string, page = 0) => {
    setPicked(new Set());
    setAllInbox(false);
    void hub().inboxPage(query, page).then(setInbox);
  };
  const toggle = (id: string, shift: boolean) => {
    setAllInbox(false);
    setPicked((cur) => {
      const next = new Set(cur);
      // Shift-click selects the range from the last box you clicked.
      if (shift && lastCheck.current) {
        const a = ordered.findIndex((t) => t.id === lastCheck.current);
        const b = ordered.findIndex((t) => t.id === id);
        if (a >= 0 && b >= 0) {
          for (const t of ordered.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(t.id);
          return next;
        }
      }
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    lastCheck.current = id;
  };
  const pageAll = ordered.length > 0 && ordered.every((t) => picked.has(t.id));
  const archivePicked = async () => {
    setBulkBusy(true);
    try {
      if (allInbox) {
        const n = await hub().emailArchiveAll(keepStarred);
        toast(`Archived the inbox (${n} messages). Threads come back when someone replies.`);
      } else {
        const ids = [...picked];
        await hub().emailArchive(ids);
        toast(`Archived ${num(ids.length)} thread${ids.length > 1 ? "s" : ""}`);
        if (sel && picked.has(sel)) setSel(null);
      }
      setPicked(new Set());
      setAllInbox(false);
    } catch (e) {
      toast(`Couldn't archive: ${cleanErr(e)}`);
    }
    setBulkBusy(false);
  };
  const from = (inbox?.page ?? 0) * (inbox?.pageSize ?? 50);
  const folder = mailFolder(inbox?.query ?? "");
  return (
    <div className="em-wrap">
    <div className="em">
      <div className="tk-bar">
        <span className="em-folders">
          {(["inbox", "drafts", "sent"] as const).map((f) => (
            <button key={f} className={folder === f ? "on" : ""} onClick={() => (setQ(""), search(f === "inbox" ? "" : MAIL_FOLDERS[f]))}>
              {f === "inbox" ? "Inbox" : f === "drafts" ? "Drafts" : "Sent"}
            </button>
          ))}
        </span>
        <span className="muted mono small">
          {inbox
            ? folder === "inbox"
              ? `${num(inbox.importantUnread)} important unread · ${num(inbox.total)} in inbox`
              : folder === "search"
                ? `~${num(inbox.total)} results`
                : `~${num(inbox.total)} ${folder}`
            : "loading…"}
          {inbox?.error ? ` · ${inbox.error}` : ""}
        </span>
        <form
          className="em-search"
          onSubmit={(e) => {
            e.preventDefault();
            search(q);
          }}
        >
          <input id="email-search" className="tk-filter" placeholder="search mail (Gmail syntax)" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          {folder === "search" && (
            <button type="button" className="link-btn" onClick={() => (setQ(""), search(""))}>
              clear
            </button>
          )}
        </form>
        <span className="tk-bar-right">
          <button className="tk-go" onClick={() => (setComposing(true), setSel(null), setZero(false))} title="Write a new email">
            new email
          </button>
          <span className="muted mono small">{status.email}</span>
          <button
            className="kb"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setInbox(await hub().inbox(true));
              setBusy(false);
            }}
          >
            {busy ? "refreshing…" : "refresh"}
          </button>
          <button className="tk-go" onClick={() => (setChatOpen(true), void hub().emailAsk(ZERO_INBOX))} disabled={!inbox?.total} title="Runs in the Mail chat">
            zero inbox
          </button>
          {!chatShown && (
            <button className="kb" onClick={() => (setChatOpen(true), setChatForced(true))}>
              chat
            </button>
          )}
        </span>
      </div>
      {(!status.contacts || !status.calendar || !status.filters) && (
        <div className="em-banner">
          <span>Sign in once more to allow {[!status.calendar && "calendar", !status.contacts && "contact names", !status.filters && "Gmail filters (always archive)"].filter(Boolean).join(", ")}.</span>
          <button className="kb" onClick={() => void hub().gmailSignIn().then(setStatus).catch((e) => toast(cleanErr(e)))}>
            sign in with Google
          </button>
        </div>
      )}
      <div className="em-body-split">
        <div className={`em-list ${sel || zero ? "" : "full"} ${narrowThread ? "slim" : ""}`} style={sel || zero ? { width: narrowThread ? Math.min(listWidth, 300) : listWidth } : undefined}>
          {inbox && ordered.length > 0 && (
            <div className={`em-bulk ${picked.size || allInbox ? "on" : ""}`}>
              <input
                type="checkbox"
                className="em-check"
                aria-label="Select all on this page"
                checked={pageAll || allInbox}
                onChange={() => {
                  setAllInbox(false);
                  setPicked(pageAll ? new Set() : new Set(ordered.map((t) => t.id)));
                }}
              />
              {allInbox ? (
                <>
                  <span>All {num(inbox.total)} inbox threads selected</span>
                  {starred.some((t) => t.inInbox) && (
                    <label className="cal-f-check">
                      <input type="checkbox" checked={keepStarred} onChange={(e) => setKeepStarred(e.target.checked)} /> keep starred
                    </label>
                  )}
                </>
              ) : picked.size ? (
                <>
                  <span>{num(picked.size)} selected</span>
                  {pageAll && !inbox.query && inbox.total > ordered.length && (
                    <button className="link-btn" onClick={() => setAllInbox(true)}>
                      select all {num(inbox.total)} in inbox
                    </button>
                  )}
                </>
              ) : (
                <span className="muted">select · x toggles · shift-click for a range</span>
              )}
              {!allInbox && ordered.some((t) => !t.starred) && (
                <button
                  className="link-btn"
                  title="Select every thread on this page that isn't starred"
                  onClick={() => (setAllInbox(false), setPicked(new Set(ordered.filter((t) => !t.starred).map((t) => t.id))))}
                >
                  select non-starred
                </button>
              )}
              {(picked.size > 0 || allInbox) && (
                <span className="em-bulk-acts">
                  <button className="link-btn" onClick={() => (setPicked(new Set()), setAllInbox(false))}>
                    clear
                  </button>
                  {!allInbox && (
                    <button
                      className="kb"
                      disabled={bulkBusy}
                      onClick={async () => {
                        const ids = [...picked];
                        try {
                          await hub().emailSpam(ids);
                          toast(`Reported ${num(ids.length)} as spam`);
                          setPicked(new Set());
                        } catch (e) {
                          toast(cleanErr(e));
                        }
                      }}
                    >
                      spam
                    </button>
                  )}
                  <button className="tk-go" disabled={bulkBusy} onClick={() => void archivePicked()}>
                    {bulkBusy ? "archiving…" : allInbox ? `archive all ${num(inbox.total)}` : `archive ${num(picked.size)}`}
                  </button>
                </span>
              )}
            </div>
          )}
          {!inbox ? (
            <div className="muted pad center mono small">loading inbox…</div>
          ) : (
            <>
              {starred.length > 0 && <div className="gh">Starred · {num(starred.length)}</div>}
              {starred.map((t) => (
                <Row key={t.id} t={t} active={t.id === sel} checked={allInbox || picked.has(t.id)} onCheck={(shift) => toggle(t.id, shift)} onOpen={() => (setSel(t.id), setZero(false), setComposing(false))} onStar={() => star(t)} />
              ))}
              <div className="gh em-pager">
                <span>{inbox.query ? "Results" : "Inbox"}</span>
                <span className="em-range">
                  {rest.length ? `${from + 1}–${from + rest.length}` : "0"}
                  {inbox.total ? ` of ${inbox.query ? "~" : ""}${num(inbox.total)}` : ""}
                </span>
                <button className="icon-btn" disabled={!inbox.page || inbox.loading} onClick={() => search(inbox.query, inbox.page - 1)} title="Newer">
                  ‹
                </button>
                <button className="icon-btn" disabled={!inbox.hasNext || inbox.loading} onClick={() => search(inbox.query, inbox.page + 1)} title="Older">
                  ›
                </button>
              </div>
              {rest.map((t) => (
                <Row key={t.id} t={t} active={t.id === sel} checked={allInbox || picked.has(t.id)} onCheck={(shift) => toggle(t.id, shift)} onOpen={() => (setSel(t.id), setZero(false), setComposing(false))} onStar={() => star(t)} />
              ))}
              {inbox.loading && !rest.length && <div className="muted pad center mono small">loading…</div>}
              {!inbox.loading && !rest.length && <div className="muted pad center mono small">{inbox.query ? "no results" : "inbox zero ✓"}</div>}
            </>
          )}
        </div>
        {(sel || zero || composing) && <ResizeHandle width={listWidth} onWidth={setListWidth} side="left" min={300} max={1000} reset={460} />}
        {/* The reading pane only opens when you pick a thread; otherwise the list takes the space. */}
        {(sel || zero || composing) && (
        <div className="em-pane">
          {composing && !sel && !zero ? (
            <div className="em-thread em-compose">
              <div className="em-thread-h">
                <h2>New email</h2>
                <button className="td-x" aria-label="Discard" title="Close (saved drafts stay in Drafts)" onClick={() => setComposing(false)}>
                  ×
                </button>
              </div>
              <Reply thread={NEW_EMAIL} onSent={() => setComposing(false)} />
            </div>
          ) : zero ? (
            <ZeroInbox onClose={() => setZero(false)} onOpen={(id) => (setSel(id), setZero(false))} />
          ) : sel && selThread ? (
            <ThreadPane
              key={sel}
              id={sel}
              me={status.email ?? ""}
              onSpam={() =>
                void hub()
                  .emailSpam([sel])
                  .then(() => (toast("Reported as spam"), setSel(null)))
                  .catch((e) => toast(cleanErr(e)))
              }
              starred={selThread.starred} onStar={() => star(selThread)} onArchive={() => archive(sel)} onClose={() => setSel(null)} />
          ) : (
            <div className="muted pad center mono small">select a thread · j/k move · a archive · s star</div>
          )}
        </div>
        )}
      </div>
    </div>
    {chatShown && <MailChat sessions={sessions} openThread={selThread ?? undefined} onClose={() => (setChatOpen(false), setChatForced(false))} />}
    {preview && (
      <div className="em-preview" onClick={() => setPreview(null)}>
        <div className="em-preview-box" onClick={(e) => e.stopPropagation()}>
          <div className="em-preview-h">
            <b>{preview.split("/").pop()}</b>
            <button className="link-btn" onClick={() => void hub().openFile(preview)}>
              open in app
            </button>
            <button className="link-btn" onClick={() => void hub().revealFile(preview)}>
              reveal
            </button>
            <button className="icon-btn" title="Close (Esc)" onClick={() => setPreview(null)}>
              ×
            </button>
          </div>
          <div className="em-preview-body">
            <FilePreview path={preview} />
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
