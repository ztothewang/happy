import { MoreHorizontal, PanelRight } from "lucide-react";
import { Grid2x2, PanelLeft } from "lucide-react";
import { useEffect, useState } from "react";
import type { EngineLimits, LimitWindow, SessionGroup, SessionState } from "../shared/types";
import { hub } from "./App";
import { GcloudChip } from "./GcloudChip";
import { useMenu } from "./Menu";
import { fmtCost, fmtDuration, fmtTokens } from "./models";
import { baseName } from "./pane";
import { sessionMenuItems } from "./sessionMenu";
import { useToast } from "./toast";

const PaneIcon = () => <PanelRight size={16} strokeWidth={1.8} />;

function untilText(ms: number) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}

/** One plan window as "62% 5h" with a remaining-bar; window already reset → treated as full. */
function Window({ w }: { w: LimitWindow }) {
  const reset = w.resetsAt != null && w.resetsAt < Date.now();
  const left = reset ? 100 : w.usedPct == null ? null : Math.max(0, Math.round(100 - w.usedPct));
  const tone = left == null ? "" : left < 10 ? "bad" : left < 25 ? "low" : "";
  const when = w.resetsAt && !reset ? `resets in ${untilText(w.resetsAt - Date.now())} (${new Date(w.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })})` : reset ? "window has reset" : "";
  return (
    <span className={`lim ${tone}`} title={`${left == null ? w.status ?? "unknown" : `${left}% left`} in the ${w.label} window${when ? ` · ${when}` : ""}`}>
      <span className="lim-bar">
        <span style={{ width: `${left ?? 0}%` }} />
      </span>
      <b>{left == null ? "?" : `${left}%`}</b> {w.label.replace("week", "wk")}
    </span>
  );
}

function Limits({ limits }: { limits: EngineLimits }) {
  const todayTok = (e: "claude" | "codex" | "cursor") => {
    const n = limits.today?.[e] ?? 0;
    return n ? <span className="lim-tok" title="Tokens used today in Happy">{fmtTokens(n)}</span> : null;
  };
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="limits" title="Plan usage remaining">
      <span className="lim-eng">
        claude{" "}
        {limits.claude?.windows.length ? (
          limits.claude.windows.map((w) => <Window key={w.label} w={w} />)
        ) : (
          <span className="muted" title="Claude reports plan usage during a session turn; it shows up after the next one.">—</span>
        )}
        {todayTok("claude")}
      </span>
      <span className="lim-eng">
        codex{" "}
        {limits.codex?.windows.length ? (
          limits.codex.windows.map((w) => <Window key={w.label} w={w} />)
        ) : (
          <span className="muted" title="No Codex usage recorded yet.">—</span>
        )}
        {todayTok("codex")}
      </span>
      <span className="lim-eng" title="Cursor's CLI doesn't report remaining usage; this is your plan tier and tokens used today in Happy.">
        cursor <b className="lim-tier">{limits.cursor?.tier ?? "—"}</b>
        {todayTok("cursor") ?? <span className="lim-tok">0</span>}
      </span>
    </div>
  );
}

/** Live elapsed time for a session: finished turns plus the current one. */
function useElapsed(s?: SessionState) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!s?.turnStartedAt) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [s?.turnStartedAt]);
  if (!s) return 0;
  return (s.activeMs ?? 0) + (s.turnStartedAt ? Date.now() - s.turnStartedAt : 0);
}

export function TopBar(props: {
  session?: SessionState;
  newChatRepo: string;
  groups: SessionGroup[];
  allTags: string[];
  limits: EngineLimits;
  paneOpen: boolean;
  onTogglePane(): void;
  onPalette(): void;
  /** Phone layout: back to the list. */
  onBack?(): void;
  sidebarHidden?: boolean;
  onToggleSidebar?(): void;
  /** Chats in the grid (0 hides the shortcut, e.g. while you're on it). */
  gridCount?: number;
  onGrid?(): void;
}) {
  const s = props.session;
  const menu = useMenu();
  const toast = useToast();
  const elapsed = useElapsed(s);


  return (
    <div className="topbar">
      {props.onBack && (
        <button className="icon-btn m-back" onClick={props.onBack} aria-label="Back">
          ‹
        </button>
      )}
      {props.onToggleSidebar && (
        <button className={`icon-btn m-hide tb-side ${props.sidebarHidden ? "" : "on"}`} title={props.sidebarHidden ? "Show the sidebar (⌘B)" : "Hide the sidebar (⌘B)"} onClick={props.onToggleSidebar}>
          <PanelLeft size={14} />
        </button>
      )}
      <div className="crumb">
        <span className="crumb-app">Happy</span>
        <span className="crumb-sep">/</span>
        <span title={s?.cwd ?? props.newChatRepo}>{s?.isManager ? "all sessions" : baseName(s?.worktree?.repo ?? s?.cwd ?? props.newChatRepo)}</span>
      </div>

      {!!props.gridCount && (
        <button className="kb tb-grid" title="Back to the chat grid (⌘8)" onClick={props.onGrid}>
          <Grid2x2 size={12} /> {props.gridCount}
        </button>
      )}
      {!hub().isRemote && <GcloudChip />}
      <Limits limits={props.limits} />
      <div className="stats">
        {s && (
          <>
            <span title="Tokens processed (excludes cache reads)">
              <b className="num">{fmtTokens(s.tokens)}</b> tok
            </span>
            <span title="Time spent working">
              <b className="num">{fmtDuration(elapsed) || "0s"}</b>
            </span>
            {!!s.costUsd && (
              <span title="Estimated at API list prices. Not billed on a subscription login.">
                <b className="num">{fmtCost(s.costUsd)}</b>
              </span>
            )}
          </>
        )}
        <button className={`icon-btn m-hide ${props.paneOpen ? "on" : ""}`} title="Toggle side pane (⌘\)" onClick={props.onTogglePane} disabled={!s}>
          <PaneIcon />
        </button>
        {s && (
          <button
            className="icon-btn"
            title="More"
            onClick={async (e) => {
              const el = e.currentTarget;
              const worktrees = s.isManager ? [] : await hub().listWorktrees(s.id).catch(() => []);
              const onRename = () => window.dispatchEvent(new CustomEvent("rename-session", { detail: s.id }));
              menu.below(el, sessionMenuItems({ s, groups: props.groups, allTags: props.allTags, onRename, toast, worktrees }), true);
            }}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
        <button className="kbd" style={{ background: "none" }} onClick={props.onPalette} title="Command palette">
          ⌘K
        </button>
      </div>
    </div>
  );
}
