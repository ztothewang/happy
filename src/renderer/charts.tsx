/** Small SVG charts shared by the Manager board and the Cloud dashboard. */

import { hub } from "./App";

/** Environment colors: from .happy/config.json, else a stable pick from a cool palette (no orange). */
const PALETTE = ["#3b82f6", "#a855f7", "#06b6d4", "#10b981", "#6366f1", "#ec4899", "#14b8a6", "#8b5cf6"];
let configured: Record<string, string> = {};
let order: string[] = [];
let loading = false;
export const tenantColor = (t: string) => {
  if (!loading && typeof window !== "undefined" && (window as { hub?: unknown }).hub) {
    loading = true;
    void hub()
      .projectConfig()
      .then((c) => {
        configured = Object.fromEntries((c.environments ?? []).filter((e) => e.color).map((e) => [e.id, e.color!]));
        order = (c.environments ?? []).map((e) => e.id);
      })
      .catch(() => {});
  }
  if (configured[t]) return configured[t];
  const i = order.indexOf(t);
  const h = i >= 0 ? i : [...t].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return PALETTE[h % PALETTE.length];
};

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  /** 24 hourly values, oldest first, ending at the current hour. */
  values: number[];
  /** Shown in the legend (e.g. the 24h total); "?" when unknown. */
  total?: number | string;
}

const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

function niceCeil(max: number) {
  if (max <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / p) * p;
}

/** Hourly line chart, last 24h, one line per series. */
export function LineChart({ series, label, height = 150, format = compact }: { series: ChartSeries[]; label: string; height?: number; format?: (n: number) => string }) {
  const W = 560;
  const H = height;
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  const top = niceCeil(Math.max(0, ...series.flatMap((s) => s.values)));
  const n = Math.max(2, ...series.map((s) => s.values.length));
  const x = (i: number) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const hourLabel = (i: number) => new Date(Date.now() - (n - 1 - i) * 3600_000).toLocaleTimeString(undefined, { hour: "numeric" });
  const ticks = [0, Math.round((n - 1) / 4), Math.round((n - 1) / 2), Math.round((3 * (n - 1)) / 4), n - 1];
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(top * f)} y2={y(top * f)} className="chart-grid" />
            <text x={pad.l - 6} y={y(top * f) + 3} className="chart-axis" textAnchor="end">
              {format(top * f)}
            </text>
          </g>
        ))}
        {ticks.map((i) => (
          <text key={i} x={x(i)} y={H - 6} className="chart-axis" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
            {i === n - 1 ? "now" : hourLabel(i)}
          </text>
        ))}
        {series.map((s) => (
          <g key={s.key}>
            <polyline fill="none" stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
            {s.values.length > 0 && <circle cx={x(s.values.length - 1)} cy={y(s.values[s.values.length - 1])} r={2.6} fill={s.color} />}
          </g>
        ))}
      </svg>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label} {s.total != null && <b>{typeof s.total === "number" ? format(s.total) : s.total}</b>}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Tiny inline trend line; `bad` overlays a second series (e.g. 5xx) in red. */
export function Spark({ values, bad, width = 90, height = 18 }: { values: number[]; bad?: number[]; width?: number; height?: number }) {
  const max = Math.max(1, ...values, ...(bad ?? []));
  const pts = (v: number[]) => v.map((n, i) => `${(i / Math.max(1, v.length - 1)) * width},${height - 1 - (n / max) * (height - 2)}`).join(" ");
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline fill="none" stroke="var(--dim)" strokeWidth={1.2} points={pts(values)} />
      {bad?.some((n) => n > 0) && <polyline fill="none" stroke="var(--bad)" strokeWidth={1.2} points={pts(bad)} />}
    </svg>
  );
}
