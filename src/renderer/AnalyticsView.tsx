import { useEffect, useState } from "react";
import type { AnalyticsEvent, AnalyticsEventDetail, AnalyticsQuery, AnalyticsSnapshot, AnalyticsStatus } from "../shared/types";
import { hub } from "./App";
import { tenantColor } from "./charts";
import { num } from "./models";

const RANGES: AnalyticsQuery["range"][] = ["1h", "24h", "7d", "30d"];
const REFRESH_MS = 30_000;

const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${Math.max(s, 0)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

/** What happened, in words: "viewed /projects", "click Save", or the event's own name. */
const what = (e: AnalyticsEvent) =>
  e.event === "$pageview"
    ? `viewed ${e.path ?? ""}`
    : e.event === "$autocapture"
      ? (e.action ?? "click")
      : e.event === "$rageclick"
        ? "rage click"
        : e.event === "$exception"
          ? "error"
          : e.event.replace(/^\$/, "");

type Prefs = Omit<AnalyticsQuery, "people"> & { peopleOpen?: boolean };
const readPrefs = (): Prefs => {
  try {
    const { range = "24h", env, peopleOpen } = JSON.parse(localStorage.getItem("analytics-prefs") ?? "{}") as Prefs;
    return { range, env, peopleOpen };
  } catch {
    return { range: "24h" };
  }
};

/** Product events from PostHog: active people per environment, top events, and a live feed. */
export function AnalyticsView() {
  const [prefs, setPrefs] = useState(readPrefs);
  /** People picked in the list: the feed and top events show only them (none picked = everyone). */
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (email: string) => setPicked((xs) => (xs.includes(email) ? xs.filter((x) => x !== email) : [...xs, email]));
  const [snap, setSnap] = useState<AnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<AnalyticsEvent>();
  const [status, setStatus] = useState<AnalyticsStatus>();
  useEffect(() => {
    if (snap?.connected && !status) void hub().analyticsStatus().then(setStatus);
  }, [snap?.connected]);

  useEffect(() => {
    try {
      localStorage.setItem("analytics-prefs", JSON.stringify(prefs));
    } catch {}
  }, [prefs]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void hub()
      .analytics({
        range: prefs.range,
        env: prefs.env,
        people: picked,
      })
      .then((s) => live && setSnap(s))
      .finally(() => live && setLoading(false));
    const t = setTimeout(() => setTick((n) => n + 1), REFRESH_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [prefs.range, prefs.env, picked.join(","), tick]);

  const set = (p: Partial<typeof prefs>) => setPrefs((x) => ({ ...x, ...p }));
  const envName = (id?: string) => snap?.envs.find((e) => e.id === id)?.name ?? id ?? "";
  const dot = (id?: string) => (
    <span
      className="an-dot"
      style={{
        background: id ? (snap?.envs.find((e) => e.id === id)?.color ?? tenantColor(id)) : "var(--dim2)",
      }}
      title={envName(id)}
    />
  );
  const totalUsers = snap?.envs.reduce((a, e) => a + e.users, 0) ?? 0;

  if (snap && !snap.connected)
    return (
      <PostHogConnect
        onConnected={() => {
          window.dispatchEvent(new Event("happy:posthog"));
          setTick((n) => n + 1);
        }}
      />
    );

  return (
    <div className="cl">
      <div className="cl-main an-main">
        <div className="cl-tabs">
          <span className="an-tabs">
            <button className={`cl-tab ${!prefs.env ? "on" : ""}`} onClick={() => set({ env: undefined })}>
              all
              {totalUsers > 0 && <span className="cl-n">{num(totalUsers)}</span>}
            </button>
            {snap?.envs.map((e) => (
              <button
                key={e.id}
                className={`cl-tab ${prefs.env === e.id ? "on" : ""}`}
                onClick={() => set({ env: e.id })}
                title={`${num(e.users)} people · ${num(e.events)} events`}
              >
                {e.id}
                {e.users > 0 && <span className="cl-n">{num(e.users)}</span>}
              </button>
            ))}
          </span>
          <span className="cl-tabs-right">
            <span className="an-seg">
              {RANGES.map((r) => (
                <button key={r} className={`kb ${prefs.range === r ? "on" : ""}`} onClick={() => set({ range: r })}>
                  {r}
                </button>
              ))}
            </span>
            {status && (status.projects?.length ?? 0) > 1 && (
              <select
                className="an-proj"
                value={status.projectId}
                onChange={(e) => void hub().analyticsSetProject(Number(e.target.value)).then(() => (setStatus({ ...status, projectId: Number(e.target.value) }), setTick((n) => n + 1)))}
              >
                {status.projects!.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
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
            <>
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
                  <span className="an-fold" onClick={() => set({ peopleOpen: !prefs.peopleOpen })}>
                    <span className="err-caret">{prefs.peopleOpen ? "▾" : "▸"}</span> people <span className="ov-count">{num(snap.people.length)}</span>
                  </span>
                  {picked.length > 0 && (
                    <>
                      <span className="ov-count">· showing {num(picked.length)}</span>
                      <button className="kb" onClick={() => setPicked([])}>
                        everyone
                      </button>
                    </>
                  )}
                </h3>
                {prefs.peopleOpen && (
                  <div className="an-people">
                    {snap.people.map((p) => (
                      <button key={p.email} className={`an-row ${picked.includes(p.email) ? "on" : ""}`} onClick={() => toggle(p.email)}>
                        <input type="checkbox" readOnly tabIndex={-1} checked={picked.includes(p.email)} />
                        {dot(p.env)}
                        <span className="an-email">{p.email}</span>
                        <span className="muted mono small">{num(p.events)}</span>
                        <span className="muted mono small an-ago">{ago(p.lastSeen)}</span>
                      </button>
                    ))}
                    {!snap.people.length && <div className="muted small">No one in this range.</div>}
                  </div>
                )}
              </div>
              <div className="card">
                <h3>
                  {picked.length === 1 ? picked[0] : picked.length ? `${num(picked.length)} people` : "latest"}
                  <span className="ov-count">every 30s · double-click for details</span>
                </h3>
                {snap.feed.map((e) => (
                  <div key={e.id} className={`an-ev ${open?.id === e.id ? "on" : ""}`} onDoubleClick={() => setOpen(e)}>
                    <span className="muted mono small an-time" title={new Date(e.ts).toLocaleString()}>
                      {clock(e.ts)}
                    </span>
                    {dot(e.env)}
                    <button className="an-who" disabled={!e.email} title="Pick this person (or unpick)" onClick={() => e.email && toggle(e.email)}>
                      {e.email ?? "anonymous"}
                    </button>
                    <span className={`an-what ${e.event === "$exception" || e.event === "$rageclick" ? "bad" : e.event.startsWith("$") ? "" : "custom"}`}>{what(e)}</span>
                    {e.event !== "$pageview" && e.path && <span className="muted small an-path">{e.path}</span>}
                  </div>
                ))}
                {!snap.feed.length && <div className="muted small">No events in this range.</div>}
              </div>
            </>
          )}
        </div>
      </div>
      {open && <EventDetail key={open.id} e={open} envName={envName(open.env)} onPerson={(p) => !picked.includes(p) && toggle(p)} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

/** Everything PostHog has on one event: the basics, then every property (yours first, PostHog's after). */
function EventDetail({ e, envName, onPerson, onClose }: { e: AnalyticsEvent; envName: string; onPerson(p: string): void; onClose(): void }) {
  const [d, setD] = useState<AnalyticsEventDetail>();
  const [err, setErr] = useState<string>();
  const [showEl, setShowEl] = useState(false);
  useEffect(() => {
    hub()
      .analyticsEvent(e.id, e.ts)
      .then(setD, (x: Error) => setErr(x.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
  }, [e.id, e.ts]);
  const props = Object.entries(d?.properties ?? {}).sort(([a], [b]) => Number(a.startsWith("$")) - Number(b.startsWith("$")) || a.localeCompare(b));
  const val = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return (
    <aside className="cal-side an-side">
      <div className="cal-side-acts">
        <span className="muted small cal-form-label">{e.event}</span>
        {d && (
          <button className="kb" onClick={() => void hub().openInChrome(d.link)}>
            PostHog
          </button>
        )}
        <button className="icon-btn" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="cal-side-body">
        <div className="an-kv">
          <span>what</span>
          <b>{what(e)}</b>
          <span>when</span>
          <span>{new Date(e.ts).toLocaleString()}</span>
          <span>who</span>
          {e.email ? (
            <button className="an-who" onClick={() => onPerson(e.email!)}>
              {e.email}
            </button>
          ) : (
            <span>anonymous</span>
          )}
          {envName && (
            <>
              <span>where</span>
              <span>{envName}</span>
            </>
          )}
          {e.path && (
            <>
              <span>page</span>
              <span className="mono small">{e.path}</span>
            </>
          )}
        </div>
        {err && <div className="err-title">{err}</div>}
        {!d && !err && <div className="muted small">loading…</div>}
        {d?.elements && (
          <div>
            <div className="an-sub an-fold" onClick={() => setShowEl(!showEl)}>
              <span className="err-caret">{showEl ? "▾" : "▸"}</span> element
            </div>
            {showEl && <pre className="err-raw">{d.elements}</pre>}
          </div>
        )}
        {props.length > 0 && (
          <div>
            <div className="an-sub">properties</div>
            <div className="an-props">
              {props.map(([k, v]) => (
                <div key={k} className="an-prop">
                  <span className={k.startsWith("$") ? "muted" : ""}>{k}</span>
                  <span className="mono">{val(v)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {d && Object.keys(d.person).length > 0 && (
          <div>
            <div className="an-sub">person</div>
            <div className="an-props">
              {Object.entries(d.person)
                .filter(([k]) => !k.startsWith("$initial") && !k.startsWith("$geoip"))
                .map(([k, v]) => (
                  <div key={k} className="an-prop">
                    <span className={k.startsWith("$") ? "muted" : ""}>{k}</span>
                    <span className="mono">{val(v)}</span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/** Paste a PostHog personal API key: checked against PostHog, then stored encrypted with the OS keychain. */
function PostHogConnect({ onConnected }: { onConnected(s: AnalyticsStatus): void }) {
  const [key, setKey] = useState("");
  const [host, setHost] = useState("https://us.posthog.com");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    void hub()
      .analyticsStatus()
      .then((s) => setErr(s.error));
  }, []);
  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      onConnected(await hub().analyticsConnect(key, host));
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
    setBusy(false);
  };
  return (
    <div className="tk-connect">
      <h2>Connect PostHog</h2>
      <p className="muted">
        Happy reads your product events with a PostHog personal API key. Create one in PostHog under Settings → Personal API keys with read access to your project (query read), then
        paste it here. It's encrypted with your macOS keychain and only sent to PostHog. Happy only runs read queries. Or set <code>POSTHOG_PERSONAL_API_KEY</code> in Happy's
        environment instead.
      </p>
      <a className="cl-ext" href={`${host}/settings/user-api-keys`} target="_blank" rel="noreferrer">
        open PostHog API key settings ↗
      </a>
      <form
        className="tk-connect-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) void submit();
        }}
      >
        <select className="an-proj" value={host} onChange={(e) => setHost(e.target.value)}>
          <option value="https://us.posthog.com">US cloud</option>
          <option value="https://eu.posthog.com">EU cloud</option>
        </select>
        <input type="password" autoComplete="off" spellCheck={false} placeholder="phx_…" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="kb" type="submit" disabled={busy || !key.trim()}>
          {busy ? "checking…" : "connect"}
        </button>
      </form>
      <p className="muted small">Tabs follow your environments: each site's first subdomain is matched to an environment's deploy tag, and the bare domain to the one without a tag.</p>
      {err && <div className="tk-err">{err}</div>}
    </div>
  );
}
