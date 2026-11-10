import { useEffect, useMemo, useRef, useState } from "react";
import { num } from "./models";
import type { HappyStats, StatsDay } from "../shared/types";
import { hub } from "./App";

type Metric = "commits" | "lines";
const METRICS: Array<[Metric, string]> = [
  ["commits", "commits"],
  ["lines", "lines changed"],
];
const value = (d: StatsDay, m: Metric) => (m === "lines" ? d.added + d.deleted : d.commits);
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const DOW = ["", "Mon", "", "Wed", "", "Fri", ""];
/** Cool, distinct language colors (no orange/brown). */
const LANG_COLORS = ["#5b9bd5", "#9b7fe6", "#3fb6a8", "#d46aa8", "#7c83e6", "#4caf6e", "#2aa7c4", "#b48ead"];

/** GitHub-style grid: one column per week (Sun→Sat), shade by quartile of non-zero days. */
function Heatmap({ days, metric }: { days: StatsDay[]; metric: Metric }) {
  const first = new Date(`${days[0].date}T12:00:00`).getDay();
  const cells: Array<StatsDay | null> = [...Array(first).fill(null), ...days];
  const weeks: Array<Array<StatsDay | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const vals = days.map((d) => value(d, metric)).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => vals[Math.floor(p * (vals.length - 1))] ?? 0;
  const level = (v: number) => (!v ? 0 : v <= q(0.25) ? 1 : v <= q(0.5) ? 2 : v <= q(0.75) ? 3 : 4);
  const months = weeks.map((w, i) => {
    const d = w.find(Boolean);
    const m = d ? new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { month: "short" }) : "";
    const prev = i ? weeks[i - 1].find(Boolean) : undefined;
    return !prev || new Date(`${prev.date}T12:00:00`).getMonth() !== new Date(`${d?.date}T12:00:00`).getMonth() ? m : "";
  });
  // Keep month labels from colliding (a month starting mid-week can leave two labels one column apart).
  for (let i = 0, last = -9; i < months.length; i++) if (months[i]) (i - last < 3 ? (months[i] = "") : (last = i));
  return (
    <div className="hm">
      <div className="hm-months">
        <span />
        {months.map((m, i) => (
          <span key={i}>{m}</span>
        ))}
      </div>
      <div className="hm-body">
        <div className="hm-dow">
          {DOW.map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        {weeks.map((w, i) => (
          <div key={i} className="hm-week">
            {Array.from({ length: 7 }, (_, j) => {
              const d = w[j];
              if (!d) return <span key={j} className="hm-cell empty" />;
              const v = value(d, metric);
              return (
                <span
                  key={j}
                  className={`hm-cell l${level(v)}`}
                  title={`${new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${num(d.commits)} commits · +${compact(d.added)}/−${compact(d.deleted)} lines`}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="hm-legend">
        less <span className="hm-cell l0" />
        <span className="hm-cell l1" />
        <span className="hm-cell l2" />
        <span className="hm-cell l3" />
        <span className="hm-cell l4" /> more
      </div>
    </div>
  );
}

/** Weekly bars; two stacked series for lines (added up, deleted down). */
function WeeklyBars({ weeks, kind }: { weeks: Array<{ label: string; a: number; b?: number }>; kind: "commits" | "lines" }) {
  // Draw at the real pixel width so labels stay small instead of scaling up with the chart.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(320, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 140;
  const pad = { l: 40, r: 6, t: 8, b: 20 };
  const maxA = Math.max(1, ...weeks.map((w) => w.a));
  const maxB = Math.max(0, ...weeks.map((w) => w.b ?? 0));
  const span = maxA + maxB;
  const zero = pad.t + (maxA / span) * (H - pad.t - pad.b);
  const bw = (W - pad.l - pad.r) / weeks.length;
  const sy = (v: number) => (v / span) * (H - pad.t - pad.b);
  return (
    <div ref={box}>
    <svg className="wbars" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={kind === "lines" ? "Lines added and deleted per week" : "Commits per week"}>
      <line x1={pad.l} x2={W - pad.r} y1={zero} y2={zero} className="wb-axis" />
      <text x={pad.l - 6} y={pad.t + 8} className="wb-t" textAnchor="end">
        {compact(maxA)}
      </text>
      {maxB > 0 && (
        <text x={pad.l - 6} y={H - pad.b} className="wb-t" textAnchor="end">
          −{compact(maxB)}
        </text>
      )}
      {weeks.map((w, i) => (
        <g key={i}>
          <title>{`${w.label}: ${kind === "lines" ? `+${w.a.toLocaleString()} / −${(w.b ?? 0).toLocaleString()} lines` : `${w.a} commits`}`}</title>
          <rect x={pad.l + i * bw + 2} y={zero - sy(w.a)} width={Math.max(2, bw - 4)} height={sy(w.a)} rx={2} className="wb-a" />
          {!!w.b && <rect x={pad.l + i * bw + 2} y={zero} width={Math.max(2, bw - 4)} height={sy(w.b)} rx={2} className="wb-b" />}
          {i % Math.max(1, Math.ceil(64 / bw)) === 0 && (
            <text x={pad.l + i * bw + bw / 2} y={H - 5} className="wb-t" textAnchor="middle">
              {w.label}
            </text>
          )}
        </g>
      ))}
    </svg>
    </div>
  );
}

/** The logo page: your last year of commits and lines of code. */
export function StatsView() {
  const [s, setS] = useState<HappyStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [metric, setMetric] = useState<Metric>("commits");
  const range: HappyStats["range"] = "1y";
  const load = (refresh = false, r = range) => {
    setBusy(true);
    void hub()
      .stats(refresh, r)
      .then(setS)
      .finally(() => setBusy(false));
  };
  useEffect(() => load(), []);
  const weeks = useMemo(() => {
    if (!s) return [];
    const out: Array<{ label: string; commits: number; added: number; deleted: number }> = [];
    const step = s.days.length > 200 ? 14 : 7; // long ranges: two-week bars so the chart stays readable
    for (let i = 0; i < s.days.length; i += step) {
      const chunk = s.days.slice(i, i + step);
      out.push({
        label: new Date(`${chunk[0].date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        commits: chunk.reduce((n, d) => n + d.commits, 0),
        added: chunk.reduce((n, d) => n + d.added, 0),
        deleted: chunk.reduce((n, d) => n + d.deleted, 0),
      });
    }
    return out;
  }, [s]);
  if (!s) return <div className="muted pad center mono small">{busy ? "reading your git history…" : "loading…"}</div>;
  const sum = (k: keyof StatsDay) => s.days.reduce((n, d) => n + (d[k] as number), 0);
  const busiest = [...s.days].sort((a, b) => b.commits - a.commits)[0];
  const active = s.days.filter((d) => d.commits).length;
  return (
    <div className="stats-page">
      <div className="sp-head">
        <img className="logo" src="apple-touch-icon.png" alt="" />
        <div>
          <h1>Your last year</h1>
          <span className="muted small">
            {s.email || "git"} · {s.repo.replace(/^\/Users\/[^/]+/, "~")} · all branches, no merges or generated/data files
          </span>
        </div>
        <button className="kb" disabled={busy} onClick={() => load(true)}>
          {busy ? "refreshing…" : "refresh"}
        </button>
      </div>
      {s.error && <div className="tk-err st-err">{s.error}</div>}
      <div className="sp-cards">
        <div className="sp-card">
          <span>Commits</span>
          <b>{sum("commits").toLocaleString()}</b>
          <small>{active} active days</small>
        </div>
        <div className="sp-card">
          <span>Lines changed</span>
          <b>
            +{compact(sum("added"))} <em>−{compact(sum("deleted"))}</em>
          </b>
          <small>net {compact(sum("added") - sum("deleted"))}</small>
        </div>
        <div className="sp-card">
          <span>Streak</span>
          <b>{s.streak.current}d</b>
          <small>longest {s.streak.longest}d</small>
        </div>
        <div className="sp-card">
          <span>Busiest day</span>
          <b>{busiest?.commits ?? 0}</b>
          <small>{busiest ? new Date(`${busiest.date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""} commits</small>
        </div>
      </div>
      <section className="card">
        <h3>
          Activity
          <span className="sp-seg">
            {METRICS.map(([m, l]) => (
              <button key={m} className={metric === m ? "on" : ""} onClick={() => setMetric(m)}>
                {l}
              </button>
            ))}
          </span>
        </h3>
        <Heatmap days={s.days} metric={metric} />
      </section>
      {s.loc && (
        <section className="card">
          <h3>
            Codebase <span className="muted small">non-blank lines today · no libraries, generated files, migrations or data</span>
          </h3>
          <div className="loc-total">
            <b>{s.loc.total.toLocaleString()}</b> lines of code
          </div>
          <div className="loc-bar">
            {s.loc.byLang
              .filter((l) => l.lang !== "Markdown")
              .map((l, i) => (
                <span key={l.lang} style={{ width: `${(100 * l.lines) / s.loc!.total}%`, background: LANG_COLORS[i % LANG_COLORS.length] }} title={`${l.lang}: ${l.lines.toLocaleString()}`} />
              ))}
          </div>
          <div className="loc-langs">
            {s.loc.byLang.map((l, i) => (
              <div key={l.lang} className="loc-lang">
                <i style={{ background: l.lang === "Markdown" ? "var(--dim2)" : LANG_COLORS[s.loc!.byLang.filter((x) => x.lang !== "Markdown").findIndex((x) => x.lang === l.lang) % LANG_COLORS.length] }} />
                <span>{l.lang}</span>
                <b>{compact(l.lines)}</b>
                <small>
                  {l.lang === "Markdown" ? "docs" : `${Math.round((100 * l.lines) / s.loc!.total)}%`} · {num(l.files)} files
                </small>
              </div>
            ))}
          </div>
          <div className="loc-areas">
            {s.loc.byArea.map((a) => (
              <span key={a.area}>
                {a.area} <b>{compact(a.lines)}</b>
              </span>
            ))}
          </div>
        </section>
      )}
      <section className="card">
        <h3>Commits per {s.days.length > 200 ? "2 weeks" : "week"}</h3>
        <WeeklyBars weeks={weeks.map((w) => ({ label: w.label, a: w.commits }))} kind="commits" />
      </section>
      <section className="card">
        <h3>
          Lines per {s.days.length > 200 ? "2 weeks" : "week"} <span className="muted small">added above, deleted below</span>
        </h3>
        <WeeklyBars weeks={weeks.map((w) => ({ label: w.label, a: w.added, b: w.deleted }))} kind="lines" />
      </section>
    </div>
  );
}
