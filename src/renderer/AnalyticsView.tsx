import { useEffect, useState } from "react";
import type { AnalyticsEvent, AnalyticsQuery, AnalyticsSnapshot } from "../shared/types";
import { hub } from "./App";
import { tenantColor } from "./charts";
import { num } from "./models";

const RANGES: AnalyticsQuery["range"][] = ["1h", "24h", "7d", "30d"];
const REFRESH_MS = 30_000;

const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${Math.max(s, 0)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** What happened, in words: "viewed /projects", "click Save", or the event's own name. */
const what = (e: AnalyticsEvent) =>
  e.event === "$pageview" ? `viewed ${e.path ?? ""}` : e.event === "$autocapture" ? (e.action ?? "click") : e.event === "$rageclick" ? "rage click" : e.event === "$exception" ? "error" : e.event.replace(/^\$/, "");

const readPrefs = (): Omit<AnalyticsQuery, "person"> => {
  try {
    return { range: "24h", signedIn: true, hideInternal: true, ...JSON.parse(localStorage.getItem("analytics-prefs") ?? "{}") };
  } catch {
    return { range: "24h", signedIn: true, hideInternal: true };
  }
};

/** Product events from PostHog: active people per environment, top events, and a live feed. */
export function AnalyticsView() {
  const [prefs, setPrefs] = useState(readPrefs);
  const [person, setPerson] = useState<string>();
  const [snap, setSnap] = useState<AnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem("analytics-prefs", JSON.stringify(prefs));
    } catch {}
  }, [prefs]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void hub()
      .analytics({ ...prefs, person })
      .then((s) => live && setSnap(s))
      .finally(() => live && setLoading(false));
    const t = setTimeout(() => setTick((n) => n + 1), REFRESH_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [prefs, person, tick]);

  const set = (p: Partial<typeof prefs>) => setPrefs((x) => ({ ...x, ...p }));
  const envName = (id?: string) => snap?.envs.find((e) => e.id === id)?.name ?? id ?? "";
  const dot = (id?: string) => <span className="an-dot" style={{ background: id ? (snap?.envs.find((e) => e.id === id)?.color ?? tenantColor(id)) : "var(--dim2)" }} title={envName(id)} />;
  const totalUsers = snap?.envs.reduce((a, e) => a + e.users, 0) ?? 0;

  if (snap && !snap.configured)
    return (
      <div className="muted pad center small">
        Analytics isn't set up for this project. Add an <code>analytics</code> block (PostHog project id, key file or secret, and site hosts per environment) to the project config.
      </div>
    );

  return (
    <div className="cl">
      <div className="cl-main">
        <div className="cl-tabs">
          <button className={`cl-tab ${!prefs.env ? "on" : ""}`} onClick={() => set({ env: undefined })}>
            all{totalUsers > 0 && <span className="cl-n">{num(totalUsers)}</span>}
          </button>
          {snap?.envs.map((e) => (
            <button key={e.id} className={`cl-tab ${prefs.env === e.id ? "on" : ""}`} onClick={() => set({ env: e.id })} title={`${num(e.users)} people · ${num(e.events)} events`}>
              {e.id}
              {e.users > 0 && <span className="cl-n">{num(e.users)}</span>}
            </button>
          ))}
          <span className="cl-tabs-right">
            <span className="an-seg">
              {RANGES.map((r) => (
                <button key={r} className={`kb ${prefs.range === r ? "on" : ""}`} onClick={() => set({ range: r })}>
                  {r}
                </button>
              ))}
            </span>
            <button className={`kb ${prefs.signedIn ? "on" : ""}`} title="Only people who are signed in" onClick={() => set({ signedIn: !prefs.signedIn })}>
              signed in
            </button>
            <button className={`kb ${prefs.hideInternal ? "on" : ""}`} title="Hide your own team" onClick={() => set({ hideInternal: !prefs.hideInternal })}>
              hide team
            </button>
            {snap?.link && (
              <button className="kb" onClick={() => void hub().openInChrome(snap.link!)}>
                PostHog
              </button>
            )}
            <button className="kb" disabled={loading} onClick={() => setTick((n) => n + 1)}>
              {loading ? "loading…" : "refresh"}
            </button>
          </span>
        </div>
        <div className="cl-scroll an">
          {snap?.error && <div className="err-title">{snap.error}</div>}
          {!snap ? (
            <div className="muted pad center mono small">loading events…</div>
          ) : (
            <div className="an-cols">
              <div className="card an-people">
                <h3>
                  people <span className="ov-count">{num(snap.people.length)}</span>
                </h3>
                {snap.people.map((p) => (
                  <button key={p.email} className={`an-row ${person === p.email ? "on" : ""}`} onClick={() => setPerson(person === p.email ? undefined : p.email)}>
                    {dot(p.env)}
                    <span className="an-email">{p.email}</span>
                    <span className="muted mono small">{num(p.events)}</span>
                    <span className="muted mono small an-ago">{ago(p.lastSeen)}</span>
                  </button>
                ))}
                {!snap.people.length && <div className="muted small">No one in this range.</div>}
              </div>
              <div className="an-right">
                <div className="card">
                  <h3>top events</h3>
                  <div className="an-top">
                    {snap.top.map((t) => (
                      <span key={t.event} className="an-chip" title={`${num(t.users)} people`}>
                        {t.event.replace(/^\$/, "")} <b>{num(t.count)}</b>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="card">
                  <h3>
                    {person ? (
                      <>
                        {person}
                        <button className="kb" onClick={() => setPerson(undefined)}>
                          everyone
                        </button>
                      </>
                    ) : (
                      "latest"
                    )}
                    <span className="ov-count">every 30s</span>
                  </h3>
                  {snap.feed.map((e, i) => (
                    <div key={`${e.ts}-${i}`} className="an-ev">
                      <span className="muted mono small an-time" title={new Date(e.ts).toLocaleString()}>
                        {clock(e.ts)}
                      </span>
                      {dot(e.env)}
                      <button className="an-who" disabled={!e.email} onClick={() => e.email && setPerson(e.email)}>
                        {e.email ?? "anonymous"}
                      </button>
                      <span className={`an-what ${e.event === "$exception" || e.event === "$rageclick" ? "bad" : e.event.startsWith("$") ? "" : "custom"}`}>{what(e)}</span>
                      {e.event !== "$pageview" && e.path && <span className="muted small an-path">{e.path}</span>}
                    </div>
                  ))}
                  {!snap.feed.length && <div className="muted small">No events in this range.</div>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
