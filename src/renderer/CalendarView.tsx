import { Pencil, Trash2 } from "lucide-react";
import { num } from "./models";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent, EventInput, GmailStatus } from "../shared/types";
import { hub } from "./App";
import { Person, RecipientInput } from "./contacts";
import { ResizeHandle, usePanelWidth } from "./resize";
import { useToast } from "./toast";

const HOUR = 44; // px per hour
const VIEW_KEY = "happy.cal.view";
const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7)); // Monday
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** Local date + "HH:MM" → ISO 8601 with this machine's offset. */
function localISO(date: string, time: string) {
  const d = new Date(`${date}T${time}:00`);
  const off = -d.getTimezoneOffset();
  return `${date}T${time}:00${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: d.getMinutes() ? "2-digit" : undefined });
const parseStart = (e: CalendarEvent) => (e.allDay ? new Date(`${e.start}T00:00:00`) : new Date(e.start));
const parseEnd = (e: CalendarEvent) => (e.allDay ? new Date(`${e.end}T00:00:00`) : new Date(e.end));

/** Side-by-side columns for overlapping events within one day. */
function layout(events: CalendarEvent[]) {
  const sorted = [...events].sort((a, b) => +parseStart(a) - +parseStart(b) || +parseEnd(b) - +parseEnd(a));
  const out = new Map<string, { col: number; cols: number }>();
  let cluster: Array<{ e: CalendarEvent; col: number }> = [];
  let clusterEnd = 0;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) out.set(c.e.id, { col: c.col, cols });
    cluster = [];
  };
  for (const e of sorted) {
    const s = +parseStart(e);
    if (cluster.length && s >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => +parseEnd(c.e) > s).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ e, col });
    clusterEnd = Math.max(clusterEnd, +parseEnd(e));
  }
  flush();
  return out;
}

interface Draft {
  id?: string;
  title: string;
  date: string;
  startTime: string;
  endDate: string;
  endTime: string;
  allDay: boolean;
  location: string;
  attendees: string[];
  description: string;
  addMeet: boolean;
  notify: boolean;
  /** The existing event, when editing. */
  event?: CalendarEvent;
}

function draftFromEvent(e: CalendarEvent): Draft {
  const s = parseStart(e);
  const en = parseEnd(e);
  return {
    id: e.id,
    title: e.title,
    date: ymd(s),
    startTime: hm(s),
    endDate: ymd(e.allDay ? addDays(en, -1) : en),
    endTime: hm(en),
    allDay: e.allDay,
    location: e.location ?? "",
    attendees: e.attendees.filter((a) => !a.self).map((a) => a.email),
    description: e.description ?? "",
    addMeet: false,
    notify: true,
    event: e,
  };
}
function draftFromInput(i: EventInput): Draft {
  const s = i.allDay ? new Date(`${i.start.slice(0, 10)}T00:00:00`) : new Date(i.start);
  const en = i.allDay ? new Date(`${i.end.slice(0, 10)}T00:00:00`) : new Date(i.end);
  return {
    title: i.title,
    date: ymd(s),
    startTime: hm(s),
    endDate: ymd(i.allDay ? addDays(en, -1) < s ? s : addDays(en, -1) : en),
    endTime: hm(en),
    allDay: !!i.allDay,
    location: i.location ?? "",
    attendees: i.attendees ?? [],
    description: i.description ?? "",
    addMeet: !!i.addMeet,
    notify: true,
  };
}
const blankDraft = (start: Date, minutes = 30): Draft => {
  const end = new Date(+start + minutes * 60_000);
  return { title: "", date: ymd(start), startTime: hm(start), endDate: ymd(end), endTime: hm(end), allDay: false, location: "", attendees: [], description: "", addMeet: false, notify: true };
};

function toInput(d: Draft): EventInput {
  return {
    title: d.title.trim() || "(no title)",
    start: d.allDay ? d.date : localISO(d.date, d.startTime),
    end: d.allDay ? ymd(addDays(new Date(`${d.endDate}T00:00:00`), 1)) : localISO(d.endDate, d.endTime),
    allDay: d.allDay,
    location: d.location.trim() || undefined,
    description: d.description.trim() || undefined,
    attendees: d.attendees,
    addMeet: d.addMeet,
  };
}

const RESP: Record<string, { icon: string; label: string }> = {
  accepted: { icon: "✓", label: "going" },
  declined: { icon: "✕", label: "not going" },
  tentative: { icon: "?", label: "maybe" },
  needsAction: { icon: "·", label: "awaiting" },
};

function whenLine(e: CalendarEvent) {
  const s = parseStart(e);
  const en = parseEnd(e);
  const day = (d: Date) => d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  if (e.allDay) {
    const last = addDays(en, -1);
    return sameDay(s, last) ? `${day(s)} · all day` : `${day(s)} – ${day(last)}`;
  }
  return sameDay(s, en) ? `${day(s)} · ${fmtTime(s)} – ${fmtTime(en)}` : `${day(s)} ${fmtTime(s)} – ${day(en)} ${fmtTime(en)}`;
}

/** Read view of an event, Google Calendar style. */
function Details({ e, me, width, onEdit, onClose, onChanged }: { e: CalendarEvent; me: string; width: number; onEdit(): void; onClose(): void; onChanged(): void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const guests = e.attendees.filter((a) => !a.self || e.attendees.length > 1);
  const going = e.attendees.filter((a) => a.response === "accepted").length;
  const rsvp = async (r: "accepted" | "declined" | "tentative") => {
    setBusy(r);
    try {
      await hub().calendarRespond(e.id, r);
      onChanged();
    } catch (err) {
      toast(`Couldn't respond: ${cleanErr(err)}`);
    }
    setBusy(null);
  };
  const del = async () => {
    setBusy("delete");
    try {
      await hub().calendarDelete(e.id, e.attendees.length > 1);
      toast("Event deleted");
      onClose();
      onChanged();
    } catch (err) {
      toast(`Couldn't delete: ${cleanErr(err)}`);
    }
    setBusy(null);
  };
  return (
    <aside className="cal-side" style={{ width }}>
      <div className="cal-side-acts">
        {e.organizerSelf && (
          <button className="icon-btn" title="Edit" onClick={onEdit}>
            <Pencil size={15} />
          </button>
        )}
        {e.organizerSelf &&
          (confirmDelete ? (
            <button className="kb cal-del" disabled={!!busy} onClick={() => void del()}>
              {busy === "delete" ? "deleting…" : e.attendees.length > 1 ? "delete & notify guests" : "confirm delete"}
            </button>
          ) : (
            <button className="icon-btn" title="Delete" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={15} />
            </button>
          ))}
        {e.htmlLink && (
          <a className="icon-btn" title="Open in Google Calendar" href={e.htmlLink} target="_blank" rel="noreferrer">
            ↗
          </a>
        )}
        <button className="icon-btn" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="cal-side-body">
        <div className="cal-d-title">
          <i style={e.color ? { background: e.color } : undefined} />
          <h2>{e.title}</h2>
        </div>
        <div className="cal-d-when">{whenLine(e)}</div>
        {e.recurring && <div className="cal-d-row muted">repeats</div>}
        {e.meetLink && (
          <a className="cal-d-meet" href={e.meetLink} target="_blank" rel="noreferrer">
            Join with Google Meet
          </a>
        )}
        {e.location && (
          <div className="cal-d-row">
            <span className="cal-d-ico">⌖</span>
            <span>{e.location}</span>
          </div>
        )}
        {guests.length > 0 && (
          <div className="cal-d-guests">
            <div className="cal-d-row">
              <span className="cal-d-ico">☺</span>
              <span>
                {num(guests.length)} guests <span className="muted">· {going} going</span>
              </span>
            </div>
            {guests.map((a) => (
              <div key={a.email} className={`cal-d-guest ${a.response ?? ""}`}>
                <span className="cal-d-resp" title={RESP[a.response ?? "needsAction"]?.label}>
                  {RESP[a.response ?? "needsAction"]?.icon}
                </span>
                <Person email={a.email} name={a.name} me={me} />
                {a.organizer && <span className="muted small">organizer</span>}
              </div>
            ))}
          </div>
        )}
        {e.description && <div className="cal-d-desc">{e.description.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")}</div>}
      </div>
      {!e.organizerSelf && e.myResponse && (
        <div className="cal-side-foot">
          <span className="muted small">Going?</span>
          {(["accepted", "declined", "tentative"] as const).map((r) => (
            <button key={r} className={`cal-rsvp ${e.myResponse === r ? "on" : ""}`} disabled={!!busy} onClick={() => void rsvp(r)}>
              {r === "accepted" ? "Yes" : r === "declined" ? "No" : "Maybe"}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

/** Create / edit form. */
function EventForm({ draft, width, onChange, onClose, onSaved }: { draft: Draft; width: number; onChange(d: Draft): void; onClose(): void; onSaved(): void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const guests = draft.attendees;
  const save = async () => {
    setBusy(true);
    try {
      await hub().calendarSave(toInput(draft), { id: draft.id, notify: draft.notify && guests.length > 0 });
      toast(draft.id ? "Event updated" : "Event created");
      onSaved();
    } catch (err) {
      toast(`Couldn't save: ${cleanErr(err)}`);
    }
    setBusy(false);
  };
  return (
    <aside className="cal-side" style={{ width }}>
      <div className="cal-side-acts">
        <span className="muted small cal-form-label">{draft.id ? "Edit event" : "New event"}</span>
        <button className="icon-btn" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <form
        className="cal-side-body cal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input id="cal-title" className="cal-f-title" placeholder="Add title" value={draft.title} onChange={(x) => set({ title: x.target.value })} autoFocus />
        <div className="cal-f-when">
          <input id="cal-date" type="date" value={draft.date} onChange={(x) => set({ date: x.target.value, endDate: x.target.value > draft.endDate || draft.endDate === draft.date ? x.target.value : draft.endDate })} />
          {!draft.allDay && (
            <>
              <input id="cal-start" type="time" value={draft.startTime} onChange={(x) => set({ startTime: x.target.value })} />
              <span className="muted">–</span>
              <input id="cal-end" type="time" value={draft.endTime} onChange={(x) => set({ endTime: x.target.value })} />
            </>
          )}
        </div>
        {(draft.allDay || draft.endDate !== draft.date) && (
          <div className="cal-f-when">
            <span className="muted small">until</span>
            <input id="cal-end-date" type="date" value={draft.endDate} onChange={(x) => set({ endDate: x.target.value })} />
          </div>
        )}
        <label className="cal-f-check">
          <input type="checkbox" checked={draft.allDay} onChange={(x) => set({ allDay: x.target.checked })} /> All day
        </label>
        <RecipientInput id="cal-guests" label="Guests" value={draft.attendees} onChange={(v) => set({ attendees: v })} placeholder="add people" />
        {!draft.event?.meetLink && (
          <label className="cal-f-check">
            <input type="checkbox" checked={draft.addMeet} onChange={(x) => set({ addMeet: x.target.checked })} /> Add Google Meet
          </label>
        )}
        <input id="cal-location" placeholder="Add location" value={draft.location} onChange={(x) => set({ location: x.target.value })} />
        <textarea id="cal-desc" placeholder="Add description" rows={4} value={draft.description} onChange={(x) => set({ description: x.target.value })} />
        <button type="submit" hidden />
      </form>
      <div className="cal-side-foot">
        {guests.length > 0 && (
          <label className="cal-f-check cal-notify">
            <input type="checkbox" checked={draft.notify} onChange={(x) => set({ notify: x.target.checked })} /> email {num(guests.length)} guest{guests.length > 1 ? "s" : ""}
          </label>
        )}
        <button className="link-btn" onClick={onClose}>
          cancel
        </button>
        <button className="tk-go" disabled={busy} onClick={() => void save()}>
          {busy ? "saving…" : draft.id ? "save" : "create"}
        </button>
      </div>
    </aside>
  );
}

/** Calendar: week/day view of your primary Google Calendar; create/edit by hand or by describing it to Claude. */
export function CalendarView() {
  const toast = useToast();
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [view, setView] = useState<"week" | "day">(() => {
    try {
      return (localStorage.getItem(VIEW_KEY) as "week" | "day") || "week";
    } catch {
      return "week";
    }
  });
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [err, setErr] = useState<string>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<CalendarEvent | null>(null);
  const [sideWidth, setSideWidth] = usePanelWidth("calendar-side", 360);
  const [me, setMe] = useState("");
  const [ask, setAsk] = useState("");
  const [parsing, setParsing] = useState(false);
  const [now, setNow] = useState(new Date());
  const grid = useRef<HTMLDivElement>(null);

  const days = useMemo(() => (view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)) : [anchor]), [view, anchor]);
  const rangeStart = days[0];
  const rangeEnd = addDays(days[days.length - 1], 1);

  useEffect(() => {
    const apply = (st: GmailStatus) => (setStatus(st), setMe(st.email ?? ""));
    void hub().gmailStatus().then(apply);
    return hub().onGoogleStatus(apply);
  }, []);
  const open = (e: CalendarEvent) => (setDraft(null), setViewing(e));
  const compose = (d: Draft) => (setViewing(null), setDraft(d));
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {}
  }, [view]);
  const load = () =>
    hub()
      .calendarEvents(rangeStart.toISOString(), rangeEnd.toISOString())
      .then((e) => {
        setEvents(e);
        setErr(undefined);
      })
      .catch((e) => setErr(cleanErr(e)));
  useEffect(() => {
    if (!status?.calendar) return;
    setEvents(null);
    void load();
    const t = setInterval(() => void load(), 3 * 60_000);
    const off = hub().onCalendarChanged(() => void load());
    return () => {
      clearInterval(t);
      off();
    };
  }, [status?.calendar, +rangeStart, +rangeEnd]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  useLayoutEffect(() => {
    if (grid.current) grid.current.scrollTop = HOUR * 7.5;
  }, [status?.calendar]);

  const createFromText = async () => {
    if (!ask.trim()) return;
    setParsing(true);
    try {
      compose(draftFromInput(await hub().calendarParse(ask)));
      setAsk("");
    } catch (e) {
      toast(`Claude couldn't read that: ${cleanErr(e)}`);
    }
    setParsing(false);
  };

  if (!status) return <div className="muted pad center mono small">checking Google…</div>;
  if (!status.connected || !status.calendar)
    return (
      <div className="tk-connect">
        <h2>Connect Calendar</h2>
        {!status.connected ? (
          <p className="muted">Calendar uses the same Google sign-in as Email. Connect Gmail in the Email tab first.</p>
        ) : (
          <>
            <p className="muted">Calendar was added after you signed in. Sign in once more to grant calendar access (same account, same client).</p>
            <div className="tk-connect-row">
              <button
                className="tk-go"
                onClick={() =>
                  void hub()
                    .gmailSignIn()
                    .then(setStatus)
                    .catch((e) => toast(cleanErr(e)))
                }
              >
                sign in with Google
              </button>
            </div>
          </>
        )}
      </div>
    );

  const label =
    view === "day"
      ? anchor.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })
      : `${days[0].toLocaleDateString([], { month: "short", day: "numeric" })} – ${days[0].getMonth() === days[6].getMonth() ? days[6].getDate() : days[6].toLocaleDateString([], { month: "short", day: "numeric" })}, ${days[6].getFullYear()}`;
  const step = view === "week" ? 7 : 1;
  const allDay = (d: Date) => (events ?? []).filter((e) => e.allDay && parseStart(e) <= d && parseEnd(e) > d);
  const timed = (d: Date) => (events ?? []).filter((e) => !e.allDay && sameDay(parseStart(e), d));

  return (
    <div className="cal">
      <div className="tk-bar">
        <button className="kb" onClick={() => setAnchor(startOfDay(new Date()))}>
          today
        </button>
        <button className="icon-btn" onClick={() => setAnchor(addDays(anchor, -step))} title="Previous">
          ‹
        </button>
        <button className="icon-btn" onClick={() => setAnchor(addDays(anchor, step))} title="Next">
          ›
        </button>
        <b className="cal-label">{label}</b>
        <div className="tk-seg">
          <button className={view === "day" ? "on" : ""} onClick={() => setView("day")}>
            day
          </button>
          <button className={view === "week" ? "on" : ""} onClick={() => setView("week")}>
            week
          </button>
        </div>
        {err && <span className="tk-err">{err}</span>}
        <form
          className="cal-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void createFromText();
          }}
        >
          <input id="cal-ask" placeholder="describe an event… “coffee with ada@x.com Tue 10am”" value={ask} onChange={(e) => setAsk(e.target.value)} spellCheck={false} />
          <button className="kb" type="submit" disabled={parsing || !ask.trim()}>
            {parsing ? "reading…" : "create with Claude"}
          </button>
        </form>
        <button className="tk-go" onClick={() => compose(blankDraft(new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000)))}>
          new
        </button>
      </div>
      <div className="cal-split">
        <div className="cal-main">
          <div className="cal-head" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` }}>
            <span />
            {days.map((d) => (
              <div key={+d} className={`cal-day-h ${sameDay(d, now) ? "today" : ""}`} onClick={() => (setAnchor(d), setView("day"))}>
                <span>{d.toLocaleDateString([], { weekday: "short" })}</span>
                <b>{d.getDate()}</b>
              </div>
            ))}
            <span className="cal-allday-l muted small">all day</span>
            {days.map((d) => (
              <div key={`ad${+d}`} className="cal-allday">
                {allDay(d).map((e) => (
                  <button key={e.id} className="cal-chip" style={e.color ? { ["--c" as string]: e.color } : undefined} onClick={() => open(e)}>
                    {e.title}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="cal-grid" ref={grid}>
            <div className="cal-grid-inner" style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))`, height: HOUR * 24 }}>
              <div className="cal-hours">
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} style={{ top: h * HOUR }}>
                    {h === 0 ? "" : new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" })}
                  </span>
                ))}
              </div>
              {days.map((d) => {
                const evs = timed(d);
                const pos = layout(evs);
                return (
                  <div
                    key={+d}
                    className="cal-col"
                    onClick={(ev) => {
                      if ((ev.target as HTMLElement).closest(".cal-ev")) return;
                      const y = ev.clientY - (ev.currentTarget as HTMLElement).getBoundingClientRect().top;
                      const mins = Math.floor((y / HOUR) * 2) * 30;
                      compose(blankDraft(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, mins)));
                    }}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <i key={h} className="cal-line" style={{ top: h * HOUR }} />
                    ))}
                    {sameDay(d, now) && <i className="cal-now" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR }} />}
                    {evs.map((e) => {
                      const s = parseStart(e);
                      const en = parseEnd(e);
                      const top = ((s.getHours() * 60 + s.getMinutes()) / 60) * HOUR;
                      const h = Math.max(18, ((+en - +s) / 3_600_000) * HOUR - 2);
                      const p = pos.get(e.id) ?? { col: 0, cols: 1 };
                      return (
                        <button
                          key={e.id}
                          className={`cal-ev ${e.myResponse === "declined" ? "declined" : ""} ${e.myResponse === "needsAction" ? "pending" : ""} ${viewing?.id === e.id || draft?.id === e.id ? "on" : ""} ${h < 30 ? "short" : ""}`}
                          style={{ top, height: h, left: `calc(${(p.col / p.cols) * 100}% + 2px)`, width: `calc(${100 / p.cols}% - 4px)`, ...(e.color ? { ["--c" as string]: e.color } : {}) }}
                          onClick={() => open(e)}
                          title={`${e.title}\n${fmtTime(s)} – ${fmtTime(en)}${e.location ? `\n${e.location}` : ""}`}
                        >
                          <b>{e.title}</b>
                          <span>
                            {fmtTime(s)}
                            {h > 30 ? ` – ${fmtTime(en)}` : ""}
                            {h > 48 && e.location ? ` · ${e.location}` : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
          {!events && !err && <div className="cal-loading muted mono small">loading…</div>}
        </div>
        {(draft || viewing) && <ResizeHandle width={sideWidth} onWidth={setSideWidth} side="right" min={300} max={760} reset={360} />}
        {draft && <EventForm key={draft.id ?? "new"} width={sideWidth} draft={draft} onChange={setDraft} onClose={() => setDraft(null)} onSaved={() => (setDraft(null), void load())} />}
        {viewing && !draft && (
          <Details
            key={viewing.id}
            e={(events ?? []).find((x) => x.id === viewing.id) ?? viewing}
            me={me}
            width={sideWidth}
            onEdit={() => compose(draftFromEvent((events ?? []).find((x) => x.id === viewing.id) ?? viewing))}
            onClose={() => setViewing(null)}
            onChanged={() => void load()}
          />
        )}
      </div>
    </div>
  );
}
