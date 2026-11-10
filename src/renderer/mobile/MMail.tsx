import { Archive, Filter, ListChecks, MessageCircle, Plus, Reply, Search, ShieldAlert, Sparkles, Star } from "lucide-react";
import { num } from "../models";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent, EmailThread, EmailThreadDetail, EventInput, GmailStatus, Inbox, TriageRun } from "../../shared/types";
import { MAIL_FOLDERS, NEW_EMAIL, mailFolder } from "../../shared/types";
import { hub } from "../App";
import { Person, RecipientInput, useContacts } from "../contacts";
import { HtmlBody, Setup, attKind, fmtSize } from "../EmailView";
import { FileSheet } from "./MSession";
import { enablePush } from "../remote";
import { useToast } from "../toast";
import { Actions, BigTitle, Chips, Empty, Fab, Group, IconBtn, KV, Nav, Row, Sheet, cleanErr, Seg } from "./ui";

const when = (ts: number) => {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const initial = (s: string) => (s.replace(/[^A-Za-z0-9]/g, "")[0] ?? "?").toUpperCase();

function MailRow({ t, selecting, checked, onTap, onLong }: { t: EmailThread; selecting: boolean; checked: boolean; onTap(): void; onLong(): void }) {
  const timer = useRef<number | undefined>(undefined);
  return (
    <button
      className={`mx-mail ${t.unread ? "" : "read"}`}
      onClick={onTap}
      onTouchStart={() => (timer.current = window.setTimeout(onLong, 450))}
      onTouchEnd={() => clearTimeout(timer.current)}
      onTouchMove={() => clearTimeout(timer.current)}
      onContextMenu={(e) => (e.preventDefault(), onLong())}
    >
      {selecting ? <span className={`mx-chk ${checked ? "on" : ""}`} /> : <span className="mx-av">{initial(t.from)}</span>}
      <span className="mx-mail-main">
        <span className="mx-mail-who">
          <b>
            {t.starred && <Star className="mx-star" size={13} fill="currentColor" />}
            {t.lastFromMe && t.to && !t.inInbox ? `to ${t.to}` : t.from}
            {t.count > 1 && <span className="mx-muted"> {num(t.count)}</span>}
          </b>
          <span>{when(t.date)}</span>
        </span>
        <span className="mx-mail-subj">{t.subject}</span>
        <span className="mx-mail-snip">{t.snippet}</span>
      </span>
    </button>
  );
}

function ReplySheet({ thread, onClose }: { thread: EmailThreadDetail; onClose(): void }) {
  const isNew = !thread.id;
  const toast = useToast();
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [ask, setAsk] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const standalone = !!thread.draft && thread.messages.length === 0;
  const [subject, setSubject] = useState(thread.draft?.subject ?? "");
  // A saved draft opens ready to edit or send; otherwise reply-all defaults.
  useEffect(() => {
    if (thread.draft) {
      setTo(thread.draft.to);
      setCc(thread.draft.cc);
      setBody(thread.draft.body);
      return;
    }
    void hub().emailReplyDefaults(thread.id).then((r) => (setTo(r.to), setCc(r.cc))).catch(() => {});
  }, [thread.id, thread.draft?.id]);
  const run = async (what: "draft" | "save" | "send") => {
    setBusy(what);
    try {
      if (what === "draft") {
        const text = await hub().emailDraft(thread.id, ask, to);
        const m = isNew ? text.match(/^Subject:\s*(.+)\n+/i) : null;
        if (m) (setSubject(m[1].trim()), setBody(text.slice(m[0].length).trim()));
        else setBody(text);
      }
      else {
        const id = await hub().emailSaveDraft(thread.id, body, { to, cc }, thread.draft?.id, standalone ? subject : undefined);
        if (what === "send") {
          await hub().emailSend(id);
          toast("Sent");
        } else toast("Saved to Gmail drafts");
        onClose();
      }
    } catch (e) {
      toast(cleanErr(e));
    }
    setBusy(null);
  };
  return (
    <Sheet onClose={onClose} full>
      <h4 className="mx-sheet-title">{isNew ? "New email" : thread.draft ? "Draft" : "Reply"}</h4>
      <div className="mx-pad">
        <RecipientInput id="m-to" label="To" value={to} onChange={setTo} />
        {standalone && <input className="mx-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />}
        {cc.length > 0 && <RecipientInput id="m-cc" label="Cc" value={cc} onChange={setCc} />}
      </div>
      <div className="mx-askrow">
        <input className="mx-input" placeholder="What should it say? (optional)" value={ask} onChange={(e) => setAsk(e.target.value)} />
        <button className="mx-btn" disabled={!!busy} onClick={() => void run("draft")}>
          {busy === "draft" ? "…" : body ? "Redraft" : "Draft"}
        </button>
      </div>
      <textarea className="mx-input tall grow" placeholder="Reply…" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="mx-btnrow">
        <button className="mx-btn" disabled={!body.trim() || !to.length || !!busy} onClick={() => void run("save")}>
          Save draft
        </button>
        {confirm ? (
          <button className="mx-btn primary" disabled={!!busy} onClick={() => void run("send")}>
            {busy === "send" ? "Sending…" : `Send to ${to.length + cc.length}`}
          </button>
        ) : (
          <button className="mx-btn primary" disabled={!body.trim() || !to.length} onClick={() => setConfirm(true)}>
            Send
          </button>
        )}
      </div>
    </Sheet>
  );
}

const ZERO_INBOX = "Zero inbox: go through my inbox, archive what I don't need to see, and tell me what's left that needs a reply or should stay.";

function ThreadScreen({ id, me, onBack, onChat }: { id: string; me: string; onBack(): void; onChat?(threadId: string): void }) {
  const toast = useToast();
  const [t, setT] = useState<EmailThreadDetail | null>(null);
  const [reply, setReply] = useState(false);
  const [rules, setRules] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    void hub()
      .emailThread(id)
      .then((d) => (setT(d), setOpen(new Set(d.messages.slice(-1).map((m) => m.id)))))
      .catch((e) => toast(cleanErr(e)));
  }, [id]);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      onBack();
    } catch (e) {
      toast(cleanErr(e));
    }
  };
  const sender = t ? [...t.messages].reverse().find((m) => !m.fromMe)?.fromEmail : undefined;
  const domain = sender?.split("@")[1];
  return (
    <div className="mx-screen">
      <Nav
        onBack={onBack}
        right={
          t && (
            <IconBtn label={t.starred ? "Unstar" : "Star"} onClick={() => void hub().emailStar(t.id, !t.starred).then(() => setT({ ...t, starred: !t.starred }))}>
              <Star size={18} fill={t.starred ? "currentColor" : "none"} className={t.starred ? "mx-star" : ""} />
            </IconBtn>
          )
        }
      />
      <div className="mx-scroll">
        {!t ? (
          <Empty>loading…</Empty>
        ) : (
          <>
            <div className="mx-thread-subj">{t.subject}</div>
            {t.messages.map((m) => {
              const isOpen = open.has(m.id);
              return (
                <div key={m.id} className="mx-tmsg">
                  <button className="mx-tmsg-h" onClick={() => setOpen((s) => new Set(isOpen ? [...s].filter((x) => x !== m.id) : [...s, m.id]))}>
                    <span className="mx-av">{initial(m.from)}</span>
                    <span className="mx-tmsg-who">
                      <b>{m.fromMe ? "me" : <Person email={m.fromEmail} name={m.from} />}</b>
                      <span>{isOpen ? `to ${m.to.split(",").length > 1 ? `${m.to.split(",").length} people` : "me"} · ${when(m.date)}` : m.text.replace(/\s+/g, " ").slice(0, 80)}</span>
                    </span>
                  </button>
                  {isOpen && (m.html ? <HtmlBody html={m.html} /> : <div className="mx-tmsg-body">{m.text}</div>)}
                  {isOpen && m.attachments.length > 0 && (
                    <div className="mx-atts">
                      {m.attachments.map((a0) => {
                        const a = typeof a0 === "string" ? { name: a0, mimeType: "", size: 0, id: "" } : a0;
                        return (
                          <button
                            key={a.id || a.name}
                            className="mx-att"
                            disabled={fetching === a.id}
                            onClick={async () => {
                              if (!a.id) return toast("Refresh this thread to open its attachments.");
                              setFetching(a.id);
                              try {
                                setFile(await hub().emailAttachment(m.id, a));
                              } catch (e) {
                                toast(cleanErr(e));
                              }
                              setFetching(null);
                            }}
                          >
                            <span className={`em-att-kind k-${attKind(a).toLowerCase()}`}>{attKind(a)}</span>
                            <span className="mx-att-name">{a.name}</span>
                            <span className="mx-att-size">{fetching === a.id ? "…" : fmtSize(a.size)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
      {t && (
        <div className="mx-toolbar">
          <button onClick={() => void act(() => hub().emailArchive([t.id]), "Archived")}>
            <Archive size={21} />Archive
          </button>
          <button className="bad" onClick={() => void act(() => hub().emailSpam([t.id]), "Reported as spam")}>
            <ShieldAlert size={21} />Spam
          </button>
          <button onClick={() => setRules(true)}>
            <Filter size={21} />Always archive
          </button>
          <button onClick={() => setReply(true)}>
            <Reply size={21} />{t?.draft ? "Draft" : "Reply"}
          </button>
        </div>
      )}
      {reply && t && <ReplySheet thread={t} onClose={() => setReply(false)} />}
      {rules && sender && (
        <Sheet onClose={() => setRules(false)}>
          <h4 className="mx-sheet-title">Always archive</h4>
          <div className="mx-sheet-sub">Creates a Gmail filter so this mail skips your inbox, and archives what's there now.</div>
          <Actions
            items={[
              { label: `From ${sender}`, onClick: () => void act(() => hub().emailAutoArchive(sender, true), `Gmail will archive mail from ${sender}`) },
              domain && !/^(gmail|googlemail|yahoo|outlook|hotmail|icloud|me|proton)\./i.test(domain) && { label: `From anyone at ${domain}`, onClick: () => void act(() => hub().emailAutoArchive(`@${domain}`, true), `Gmail will archive mail from ${domain}`) },
            ]}
          />
        </Sheet>
      )}
      {file && <FileSheet link={file} onClose={() => setFile(null)} />}
      {onChat && (
        <Fab onClick={() => onChat(id)}>
          <MessageCircle size={18} /> Ask
        </Fab>
      )}
      {me && null}
    </div>
  );
}

function ZeroScreen({ onBack, onOpen }: { onBack(): void; onOpen(id: string): void }) {
  const toast = useToast();
  const [run, setRun] = useState<TriageRun | null | undefined>(undefined);
  useEffect(() => {
    void hub()
      .emailTriageRun()
      .then((r) => (r ? setRun(r) : hub().emailTriage().then(setRun)));
    return hub().onTriage(setRun);
  }, []);
  const picked = new Set(run?.picked ?? []);
  const setPicked = (s: Set<string>) => (setRun((r) => (r ? { ...r, picked: [...s] } : r)), void hub().emailTriagePick([...s]));
  const group = (k: "archive" | "reply" | "keep", title: string) => {
    const rows = (run?.verdicts ?? []).filter((v) => v.verdict === k);
    if (!rows.length) return null;
    const all = rows.every((v) => picked.has(v.id));
    return (
      <Group
        title={`${title} · ${num(rows.length)}`}
        action={
          <button className="mx-link" onClick={() => setPicked(new Set(all ? [...picked].filter((id) => !rows.some((v) => v.id === id)) : [...picked, ...rows.map((v) => v.id)]))}>
            {all ? "Select none" : "Select all"}
          </button>
        }
      >
        {rows.map((v) => (
          <div key={v.id} className="mx-zrow">
            <button className={`mx-chk sq ${picked.has(v.id) ? "on" : ""}`} onClick={() => setPicked(new Set(picked.has(v.id) ? [...picked].filter((x) => x !== v.id) : [...picked, v.id]))} aria-label="Select" />
            <button className="mx-zrow-main" onClick={() => onOpen(v.id)}>
              <b>{v.subject ?? "(thread)"}</b>
              <span>
                {v.from} · {v.reason}
              </span>
            </button>
          </div>
        ))}
      </Group>
    );
  };
  const n = [...picked].filter((id) => run?.verdicts.some((v) => v.id === id)).length;
  return (
    <div className="mx-screen">
      <Nav
        onBack={onBack}
        title="Zero inbox"
        right={
          <button className="mx-link" disabled={run?.status === "running"} onClick={() => void hub().emailTriage().then(setRun)}>
            Redo
          </button>
        }
      />
      <div className="mx-scroll">
        <div className="mx-sub-pad">{run?.status === "running" ? `Claude is reading ${num(run.verdicts.length)}/${num(run.total)}… you can leave; it's saved.` : run ? `Saved run · ${new Date(run.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "loading…"}</div>
        {run?.error && <div className="mx-banner bad">{run.error}</div>}
        {group("archive", "Archive")}
        {group("reply", "Needs your reply")}
        {group("keep", "Keep")}
        {run?.status === "done" && !run.verdicts.length && <Empty>All handled ✓</Empty>}
      </div>
      <div className="mx-bottombar">
        <button
          className="mx-btn primary wide"
          disabled={!n}
          onClick={() =>
            void hub()
              .emailArchive([...picked])
              .then(() => toast(`Archived ${n}`))
              .catch((e) => toast(cleanErr(e)))
          }
        >
          Archive {n}
        </button>
      </div>
    </div>
  );
}

/** Phone Mail. `onChat` opens the Mail chat (about a thread, or with a question such as zero inbox). */
export function MMail({ onChat }: { onChat?(threadId?: string, ask?: string): void }) {
  const toast = useToast();
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [composing, setComposing] = useState(false);
  const [screen, setScreen] = useState<{ kind: "thread"; id: string } | { kind: "zero" } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState<string | null>(null);
  useContacts();
  useEffect(() => {
    void hub().gmailStatus().then(setStatus);
    return hub().onGoogleStatus(setStatus);
  }, []);
  useEffect(() => {
    if (!status?.connected) return;
    void hub().inbox().then(setInbox);
    return hub().onInbox(setInbox);
  }, [status?.connected]);
  const list = useMemo(() => [...(inbox && !inbox.query ? inbox.starred : []), ...(inbox?.threads ?? [])], [inbox]);
  if (status && !status.connected)
    return (
      <div className="mx-screen">
        <div className="mx-scroll">
          <Setup status={status} onStatus={setStatus} />
        </div>
      </div>
    );
  if (screen?.kind === "thread") return <ThreadScreen id={screen.id} me={status?.email ?? ""} onBack={() => setScreen(null)} onChat={onChat} />;
  if (screen?.kind === "zero") return <ZeroScreen onBack={() => setScreen(null)} onOpen={(id) => setScreen({ kind: "thread", id })} />;
  const toggle = (id: string) => setPicked((s) => new Set(s.has(id) ? [...s].filter((x) => x !== id) : [...s, id]));
  const bulk = async (fn: (ids: string[]) => Promise<unknown>, msg: string) => {
    try {
      await fn([...picked]);
      toast(msg);
      setPicked(new Set());
      setSelecting(false);
    } catch (e) {
      toast(cleanErr(e));
    }
  };
  return (
    <div className="mx-screen">
      {selecting ? (
        <Nav
          title={`${num(picked.size)} selected`}
          onBack={() => (setSelecting(false), setPicked(new Set()))}
          right={
            <span className="mx-navbtns">
              <button className="mx-link" onClick={() => setPicked(new Set(list.filter((t) => !t.starred).map((t) => t.id)))}>
                Unstarred
              </button>
              <button className="mx-link" onClick={() => setPicked(picked.size === list.length ? new Set() : new Set(list.map((t) => t.id)))}>
                {picked.size === list.length ? "None" : "All"}
              </button>
            </span>
          }
        />
      ) : (
        <Nav
          right={
            <>
              <IconBtn label="Search" onClick={() => setSearch(inbox?.query ?? "")}>
                <Search size={18} />
              </IconBtn>
              <IconBtn label="Select" onClick={() => setSelecting(true)}>
                <ListChecks size={18} />
              </IconBtn>
              {onChat && (
                <IconBtn label="Mail chat" onClick={() => onChat()}>
                  <MessageCircle size={18} />
                </IconBtn>
              )}
            </>
          }
        />
      )}
      <div className="mx-scroll">
        <BigTitle
          sub={
            inbox
              ? mailFolder(inbox.query) === "inbox"
                ? `${num(inbox.total)} threads · ${num(inbox.importantUnread)} important unread`
                : mailFolder(inbox.query) === "search"
                  ? `~${num(inbox.total)} results for “${inbox.query}”`
                  : `~${num(inbox.total)} ${mailFolder(inbox.query)}`
              : undefined
          }
        >
          {{ inbox: "Inbox", drafts: "Drafts", sent: "Sent", search: "Search" }[mailFolder(inbox?.query ?? "")]}
        </BigTitle>
        <div className="mx-sub-pad">
          <Seg
            value={mailFolder(inbox?.query ?? "") === "search" ? "inbox" : (mailFolder(inbox?.query ?? "") as "inbox" | "drafts" | "sent")}
            options={[["inbox", "Inbox"], ["drafts", "Drafts"], ["sent", "Sent"]]}
            onChange={(f) => void hub().inboxPage(f === "inbox" ? "" : MAIL_FOLDERS[f], 0).then(setInbox)}
          />
          <button className="mx-link" style={{ marginTop: 10 }} onClick={() => setComposing(true)}>
            + New email
          </button>
        </div>
        {composing && <ReplySheet thread={NEW_EMAIL} onClose={() => setComposing(false)} />}
        {mailFolder(inbox?.query ?? "") === "search" && (
          <button className="mx-link mx-sub-pad" onClick={() => void hub().inboxPage("", 0).then(setInbox)}>
            ‹ Back to inbox
          </button>
        )}
        {!inbox ? (
          <Empty>loading…</Empty>
        ) : (
          <div className="mx-list mx-maillist">
            {list.map((t) => (
              <MailRow key={t.id} t={t} selecting={selecting} checked={picked.has(t.id)} onTap={() => (selecting ? toggle(t.id) : setScreen({ kind: "thread", id: t.id }))} onLong={() => (setSelecting(true), toggle(t.id))} />
            ))}
            {!list.length && <Empty>{inbox.query ? "No results" : "Inbox zero ✓ Archived threads come back when someone replies."}</Empty>}
          </div>
        )}
        {inbox && (inbox.page > 0 || inbox.hasNext) && (
          <div className="mx-pager">
            <button className="mx-btn" disabled={!inbox.page} onClick={() => void hub().inboxPage(inbox.query, inbox.page - 1).then(setInbox)}>
              Newer
            </button>
            <span className="mx-muted">page {inbox.page + 1}</span>
            <button className="mx-btn" disabled={!inbox.hasNext} onClick={() => void hub().inboxPage(inbox.query, inbox.page + 1).then(setInbox)}>
              Older
            </button>
          </div>
        )}
        {!status?.calendar || !status?.contacts || !status?.filters ? (
          <button className="mx-banner" onClick={() => void hub().gmailSignIn().then(setStatus).catch((e) => toast(cleanErr(e)))}>
            Sign in with Google again to allow calendar, contact names and filters ›
          </button>
        ) : null}
      </div>
      {selecting ? (
        <div className="mx-selbar">
          <b>{num(picked.size)} selected</b>
          <button disabled={!picked.size} onClick={() => void bulk((ids) => hub().emailArchive(ids), `Archived ${num(picked.size)}`)}>
            Archive
          </button>
          <button className="bad" disabled={!picked.size} onClick={() => void bulk((ids) => hub().emailSpam(ids), `Reported ${num(picked.size)} as spam`)}>
            Spam
          </button>
        </div>
      ) : (
        <Fab onClick={() => (onChat ? onChat(undefined, ZERO_INBOX) : setScreen({ kind: "zero" }))}>
          <Sparkles size={18} /> Zero inbox
        </Fab>
      )}
      {search !== null && (
        <Sheet onClose={() => setSearch(null)}>
          <h4 className="mx-sheet-title">Search mail</h4>
          <form
            className="mx-askrow"
            onSubmit={(e) => {
              e.preventDefault();
              void hub().inboxPage(search, 0).then(setInbox);
              setSearch(null);
            }}
          >
            <input className="mx-input" autoFocus placeholder="from:lucy subject:pipeline" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button className="mx-btn primary" type="submit">
              Search
            </button>
          </form>
        </Sheet>
      )}
    </div>
  );
}

// ── Calendar ───────────────────────────────────────────────────
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const evStart = (e: CalendarEvent) => (e.allDay ? new Date(`${e.start}T00:00:00`) : new Date(e.start));
const evEnd = (e: CalendarEvent) => (e.allDay ? new Date(`${e.end}T00:00:00`) : new Date(e.end));
const hm = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function EventSheet({ e, me, onClose, onChanged }: { e: CalendarEvent; me: string; onClose(): void; onChanged(): void }) {
  const toast = useToast();
  const [guests, setGuests] = useState(false);
  const [del, setDel] = useState(false);
  const s = evStart(e);
  const en = evEnd(e);
  const going = e.attendees.filter((a) => a.response === "accepted").length;
  const rsvp = (r: "accepted" | "declined" | "tentative") =>
    void hub()
      .calendarRespond(e.id, r)
      .then(() => (onChanged(), toast(r === "accepted" ? "Going" : r === "declined" ? "Not going" : "Maybe")))
      .catch((x) => toast(cleanErr(x)));
  return (
    <Sheet onClose={onClose}>
      <h4 className="mx-sheet-title">{e.title}</h4>
      <div className="mx-sheet-sub">
        {s.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
        {e.allDay ? " · all day" : ` · ${hm(s)} – ${hm(en)}`}
      </div>
      {e.meetLink && (
        <a className="mx-btn primary wide" href={e.meetLink} target="_blank" rel="noreferrer">
          Join video call
        </a>
      )}
      <KV
        rows={[
          e.location && ["Where", e.location.replace(/https?:\/\/\S+/g, "").replace(/,\s*$/, "") || "video call"],
          e.attendees.length > 1 && [
            "Guests",
            <button className="mx-link" onClick={() => setGuests(!guests)}>
              {num(e.attendees.length)} · {going} going ›
            </button>,
          ],
        ]}
      />
      {guests && (
        <div className="mx-list">
          {e.attendees.map((a) => (
            <Row key={a.email} chevron={false} title={<Person email={a.email} name={a.name} me={me} />} right={a.response === "accepted" ? "✓" : a.response === "declined" ? "✕" : a.response === "tentative" ? "?" : "·"} />
          ))}
        </div>
      )}
      {!e.organizerSelf && e.myResponse && (
        <div className="mx-btnrow">
          {(["accepted", "tentative", "declined"] as const).map((r) => (
            <button key={r} className={`mx-btn ${e.myResponse === r ? "primary" : ""}`} onClick={() => rsvp(r)}>
              {r === "accepted" ? "Yes" : r === "declined" ? "No" : "Maybe"}
            </button>
          ))}
        </div>
      )}
      <Actions
        items={[
          e.htmlLink && { label: "Open in Google Calendar ↗", onClick: () => window.open(e.htmlLink, "_blank") },
          e.organizerSelf && {
            label: del ? (e.attendees.length > 1 ? "Tap again: delete and notify guests" : "Tap again to delete") : "Delete event",
            danger: true,
            onClick: () => (del ? void hub().calendarDelete(e.id, e.attendees.length > 1).then(() => (onClose(), onChanged())) : setDel(true)),
          },
        ]}
      />
    </Sheet>
  );
}

function NewEventSheet({ onClose, onCreated }: { onClose(): void; onCreated(): void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<EventInput | null>(null);
  const [busy, setBusy] = useState(false);
  const fmt = (i: EventInput) => {
    if (i.allDay) return `${i.start.slice(0, 10)} · all day`;
    const s = new Date(i.start);
    return `${s.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${hm(s)}–${hm(new Date(i.end))}`;
  };
  return (
    <Sheet onClose={onClose} full>
      <h4 className="mx-sheet-title">New event</h4>
      <div className="mx-sheet-sub">Describe it; Claude fills in the details for you to check.</div>
      <textarea className="mx-input tall" placeholder="coffee with bryce@reactor.inc thursday 10am at Sightglass" value={text} onChange={(e) => setText(e.target.value)} />
      {!draft ? (
        <button
          className="mx-btn primary wide"
          disabled={busy || !text.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              setDraft(await hub().calendarParse(text));
            } catch (e) {
              toast(cleanErr(e));
            }
            setBusy(false);
          }}
        >
          {busy ? "reading…" : <><Sparkles size={16} /> Fill with Claude</>}
        </button>
      ) : (
        <>
          <input className="mx-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <KV rows={[["When", fmt(draft)], draft.location && ["Where", draft.location], !!draft.attendees?.length && ["Guests", draft.attendees.join(", ")], draft.addMeet && ["Video", "Google Meet"]]} />
          <div className="mx-btnrow">
            <button className="mx-btn" onClick={() => setDraft(null)}>
              Back
            </button>
            <button
              className="mx-btn primary grow"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await hub().calendarSave(draft, { notify: !!draft.attendees?.length });
                  toast("Event created");
                  onCreated();
                  onClose();
                } catch (e) {
                  toast(cleanErr(e));
                }
                setBusy(false);
              }}
            >
              {draft.attendees?.length ? `Create · email ${num(draft.attendees.length)}` : "Create"}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

export function MCal() {
  const toast = useToast();
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [range, setRange] = useState<"agenda" | "today">("agenda");
  const [open, setOpen] = useState<CalendarEvent | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    void hub().gmailStatus().then(setStatus);
    return hub().onGoogleStatus(setStatus);
  }, []);
  const load = () => {
    const from = startOfDay(new Date());
    void hub()
      .calendarEvents(from.toISOString(), addDays(from, range === "today" ? 1 : 14).toISOString())
      .then(setEvents)
      .catch((e) => toast(cleanErr(e)));
  };
  useEffect(() => {
    if (!status?.calendar) return;
    load();
    return hub().onCalendarChanged(load);
  }, [status?.calendar, range]);
  if (status && !status.calendar)
    return (
      <div className="mx-screen">
        <div className="mx-scroll">
          <BigTitle>Calendar</BigTitle>
          <Empty>{status.connected ? "Sign in with Google once more to allow calendar access." : "Connect Gmail first (Mail tab)."}</Empty>
          {status.connected && (
            <button className="mx-btn primary wide" onClick={() => void hub().gmailSignIn().then(setStatus).catch((e) => toast(cleanErr(e)))}>
              Sign in with Google
            </button>
          )}
        </div>
      </div>
    );
  const days: Array<{ d: Date; evs: CalendarEvent[] }> = [];
  for (const e of events ?? []) {
    const d = startOfDay(evStart(e) < startOfDay(new Date()) ? new Date() : evStart(e));
    let g = days.find((x) => +x.d === +d);
    if (!g) days.push((g = { d, evs: [] }));
    g.evs.push(e);
  }
  days.sort((a, b) => +a.d - +b.d);
  const today = startOfDay(new Date());
  const label = (d: Date) => (+d === +today ? "Today" : +d === +addDays(today, 1) ? "Tomorrow" : d.toLocaleDateString([], { weekday: "long" }));
  return (
    <div className="mx-screen">
      <Nav
        right={
          <IconBtn label="New event with Claude" onClick={() => setCreating(true)}>
            <Sparkles size={18} />
          </IconBtn>
        }
      />
      <div className="mx-scroll">
        <BigTitle>Calendar</BigTitle>
        <Chips value={range} onChange={setRange} options={[["agenda", "Next 2 weeks"], ["today", "Today"]]} />
        {!events ? (
          <Empty>loading…</Empty>
        ) : !days.length ? (
          <Empty>Nothing scheduled.</Empty>
        ) : (
          days.map(({ d, evs }) => (
            <div key={+d}>
              <div className="mx-day-h">
                <b>{label(d)}</b> {d.toLocaleDateString([], { month: "short", day: "numeric" })}
              </div>
              <div className="mx-daycol">
                {evs.map((e) => (
                  <button key={e.id} className={`mx-ev ${e.myResponse === "needsAction" ? "pending" : ""} ${e.myResponse === "declined" ? "declined" : ""}`} onClick={() => setOpen(e)}>
                    {!e.allDay && (
                      <span className="mx-ev-tm">
                        <b>{hm(evStart(e)).replace(/\s?[AP]M$/i, "")}</b>
                        {hm(evEnd(e))}
                      </span>
                    )}
                    <span className="mx-ev-bar" style={e.color ? { background: e.color } : undefined} />
                    <span className="mx-ev-bd">
                      <b>{e.title}</b>
                      <span>
                        {e.allDay ? "all day" : e.myResponse === "needsAction" ? "you haven't answered" : e.attendees.length > 1 ? `${num(e.attendees.length)} guests` : (e.location ?? "").replace(/https?:\/\/\S+/g, "").slice(0, 60)}
                      </span>
                    </span>
                    {e.meetLink && <span className="mx-join">Join</span>}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
      <Fab round onClick={() => setCreating(true)}>
        <Plus size={26} />
      </Fab>
      {open && <EventSheet e={open} me={status?.email ?? ""} onClose={() => setOpen(null)} onChanged={load} />}
      {creating && <NewEventSheet onClose={() => setCreating(false)} onCreated={load} />}
    </div>
  );
}

export { enablePush };
