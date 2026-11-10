import { randomUUID } from "node:crypto";
import type { CalendarEvent, EventInput } from "../shared/types.js";
import type { Gmail } from "./gmail.js";

const API = "https://www.googleapis.com/calendar/v3";
const PRIMARY = "primary";

/** Google Calendar (primary calendar) over the same Google sign-in as Gmail. */
export class Calendar {
  private colors?: Record<string, string>;
  constructor(private google: Gmail) {}

  private api(path: string, init: { method?: string; body?: unknown } = {}) {
    return this.google.google(`${API}${path}`, init, "Calendar");
  }

  private async eventColors() {
    if (this.colors) return this.colors;
    try {
      const c = await this.api("/colors");
      this.colors = Object.fromEntries(Object.entries(c.event ?? {}).map(([k, v]: [string, any]) => [k, v.background]));
    } catch {
      this.colors = {};
    }
    return this.colors;
  }

  private toEvent(e: any, colors: Record<string, string>): CalendarEvent {
    const allDay = !!e.start?.date;
    const me = (e.attendees ?? []).find((a: any) => a.self);
    return {
      id: e.id,
      calendarId: PRIMARY,
      title: e.summary || "(no title)",
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      allDay,
      location: e.location,
      description: e.description,
      attendees: (e.attendees ?? []).map((a: any) => ({ email: a.email, name: a.displayName, response: a.responseStatus, self: a.self, organizer: a.organizer })),
      meetLink: e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p: any) => p.entryPointType === "video")?.uri,
      htmlLink: e.htmlLink,
      myResponse: me?.responseStatus,
      organizerSelf: !!e.organizer?.self,
      color: e.colorId ? colors[e.colorId] : undefined,
      recurring: !!e.recurringEventId,
    };
  }

  async events(timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    const colors = await this.eventColors();
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      if (pageToken) q.set("pageToken", pageToken);
      const r = await this.api(`/calendars/${PRIMARY}/events?${q}`);
      for (const e of r.items ?? []) if (e.status !== "cancelled") out.push(this.toEvent(e, colors));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  private body(input: EventInput) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      summary: input.title,
      location: input.location || undefined,
      description: input.description || undefined,
      start: input.allDay ? { date: input.start.slice(0, 10) } : { dateTime: input.start, timeZone: tz },
      end: input.allDay ? { date: input.end.slice(0, 10) } : { dateTime: input.end, timeZone: tz },
      attendees: input.attendees?.length ? input.attendees.map((email) => ({ email })) : undefined,
      ...(input.addMeet ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
    };
  }

  /** Create or update. `notify` decides whether Google emails the guests. */
  async save(input: EventInput, opts: { id?: string; notify: boolean }): Promise<CalendarEvent> {
    const q = new URLSearchParams({ sendUpdates: opts.notify ? "all" : "none", conferenceDataVersion: "1" });
    const body = this.body(input);
    const e = opts.id
      ? await this.api(`/calendars/${PRIMARY}/events/${encodeURIComponent(opts.id)}?${q}`, { method: "PATCH", body: { ...body, attendees: body.attendees ?? [] } })
      : await this.api(`/calendars/${PRIMARY}/events?${q}`, { method: "POST", body });
    return this.toEvent(e, await this.eventColors());
  }

  async remove(id: string, notify: boolean) {
    await this.api(`/calendars/${PRIMARY}/events/${encodeURIComponent(id)}?sendUpdates=${notify ? "all" : "none"}`, { method: "DELETE" });
  }

  /** RSVP to an invite (only your own attendee entry changes). */
  async respond(id: string, response: "accepted" | "declined" | "tentative") {
    const e = await this.api(`/calendars/${PRIMARY}/events/${encodeURIComponent(id)}`);
    const attendees = (e.attendees ?? []).map((a: any) => (a.self ? { ...a, responseStatus: response } : a));
    await this.api(`/calendars/${PRIMARY}/events/${encodeURIComponent(id)}?sendUpdates=all`, { method: "PATCH", body: { attendees } });
  }
}
