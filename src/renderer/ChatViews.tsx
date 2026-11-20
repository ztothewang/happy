import { Grid2x2, Maximize2, PanelRight, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionGroup, SessionState } from "../shared/types";
import { isSystemSession } from "../shared/types";
import { useMenu } from "./Menu";
import { lastMessageAt, relTime } from "./models";
import { SessionView } from "./SessionView";
import { DRAG_TYPE, RowSub } from "./Sidebar";
import { grid, useGrid } from "./grid";
import { viewing } from "./viewing";

/** Plain text of the latest message (no Markdown), for card previews. */
function latest(s: SessionState): { who: string; text: string } | undefined {
  const it = [...s.items].reverse().find((i) => i.kind === "assistant" || i.kind === "user");
  if (!it) return undefined;
  const text = it.text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return { who: it.kind === "user" ? "you" : s.engine, text };
}

const live = (xs: SessionState[]) => xs.filter((s) => !s.archived && !isSystemSession(s));

/** Chat wall: every active chat as a card, under its group, with its latest message. Click one to read and reply in a modal; tick some to open them in the grid. */
export function ChatWallView({ sessions, groups, onOpen, onGrid }: { sessions: SessionState[]; groups: SessionGroup[]; onOpen(id: string): void; onGrid(): void }) {
  const picked = useGrid();
  const chats = live(sessions);
  const sections = [
    { id: "", name: "General", members: chats.filter((s) => !s.routineId && (!s.groupId || !groups.some((g) => g.id === s.groupId))) },
    ...groups.map((g) => ({ id: g.id, name: g.name, members: chats.filter((s) => !s.routineId && s.groupId === g.id) })),
    { id: "routines", name: "Routines", members: chats.filter((s) => s.routineId) },
  ]
    .filter((x) => x.members.length)
    .map((x) => ({ ...x, members: [...x.members].sort((a, b) => lastMessageAt(b) - lastMessageAt(a)) }));
  return (
    <div className="chatwall">
      <div className="ac-bar">
        <b>Chat wall</b>
        <span className="muted mono small">{chats.length} active</span>
        <span className="ac-bar-right">
          {picked.length > 0 && (
            <>
              <span className="muted small">{picked.length} in the grid</span>
              <button className="link-btn" onClick={() => grid.clear()}>
                clear
              </button>
            </>
          )}
          <button className="tk-go" disabled={!picked.length} onClick={onGrid}>
            open chat grid
          </button>
        </span>
      </div>
      <div className="ac-scroll">
        {sections.map((sec) => (
          <section key={sec.id} className="ac-sec">
            <h3>
              {sec.name} <span className="ov-count">{sec.members.length}</span>
            </h3>
            <div className="ac-cards">
              {sec.members.map((s) => {
                  const m = latest(s);
                  const on = picked.includes(s.id);
                  return (
                    <div key={s.id} className={`ac-card ${on ? "on" : ""}`} onClick={() => onOpen(s.id)}>
                      <div className="ac-card-h">
                        <button
                          className={`ac-check ${on ? "on" : ""}`}
                          aria-label={on ? "Remove from the grid" : "Add to the grid"}
                          title={on ? "In the chat grid" : "Add to the chat grid"}
                          onClick={(e) => (e.stopPropagation(), grid.toggle(s.id))}
                        />
                        <b className="ac-title">{s.title}</b>
                        <span className="muted mono small">{relTime(lastMessageAt(s))}</span>
                      </div>
                      <RowSub s={s} onTag={() => {}} />
                      {m && (
                        <div className="ac-msg">
                          <span className="ac-who">{m.who}</span> {m.text}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </section>
        ))}
        {!sections.length && <div className="muted pad center">No active chats.</div>}
      </div>
    </div>
  );
}

/**
 * A chat opened from the Wall, Grid or Auto page: nearly full screen, the live chat with its own side pane (browser,
 * terminal, files…). Esc closes (an empty composer, or outside it); "Open in list" leaves for the normal view.
 */
export function ChatModal({ s, pane, onClose, onOpenInList, onTogglePane, paneOpen }: { s: SessionState; pane?: React.ReactNode; onClose(): void; onOpenInList(): void; onTogglePane(): void; paneOpen: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => viewing.add(s.id), [s.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el?.closest?.("textarea, input, [contenteditable]");
      // Esc in the composer still stops a running agent; an empty composer lets it close the window.
      const empty = !typing || (el instanceof HTMLTextAreaElement && !el.value);
      if (empty && !(typing && s.status === "running") && !document.querySelector(".menu, .peek-backdrop.rec-ed-back")) (e.preventDefault(), onClose());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="cm-backdrop" onMouseDown={onClose}>
      <div className="cm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="grid-card-h">
          <b className="ac-title" title={s.title}>
            {s.title}
          </b>
          <RowSub s={s} onTag={() => {}} />
          <span className="grid-card-acts">
            <button className={`icon-btn ${paneOpen ? "on" : ""}`} title="Side pane (⌘\)" onClick={onTogglePane}>
              <PanelRight size={13} />
            </button>
            <button className="icon-btn" title="Open in the list view" onClick={onOpenInList}>
              <Maximize2 size={12} />
            </button>
            <button className="icon-btn" title="Close (esc)" onClick={onClose}>
              <X size={13} />
            </button>
          </span>
        </div>
        <div className="cm-body">
          <div className="cm-chat" ref={ref}>
            <SessionView key={s.id} session={s} dropZone={ref} />
          </div>
          {pane}
        </div>
      </div>
    </div>
  );
}

function GridCard({ s, index, onOpen, sessions }: { s: SessionState; index: number; onOpen(id: string): void; sessions: Record<string, SessionState> }) {
  const ref = useRef<HTMLDivElement>(null);
  const menu = useMenu();
  const [over, setOver] = useState(false);
  // A card at least half on screen counts as looking at the chat.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let stop: (() => void) | undefined;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !stop) stop = viewing.add(s.id);
      else if (!e.isIntersecting && stop) (stop(), (stop = undefined));
    }, { threshold: 0.5 });
    io.observe(el);
    return () => (io.disconnect(), stop?.());
  }, [s.id]);
  return (
    <div
      ref={ref}
      id={`grid-card-${s.id}`}
      className={`grid-card ${over ? "drop" : ""}`}
      onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (!id || id === s.id) return;
        e.preventDefault();
        // Dropped on a card: replace it, or add alongside.
        menu.at(e.clientX, e.clientY, [
          { type: "header", label: sessions[id]?.title ?? "chat" },
          { label: `Replace "${s.title.slice(0, 40)}"`, onSelect: () => grid.replace(index, id) },
          { label: "Add to the grid", onSelect: () => grid.add(id) },
        ]);
      }}
    >
      <div className="grid-card-h">
        <b className="ac-title" title={s.title}>
          {s.title}
        </b>
        <RowSub s={s} onTag={() => {}} />
        <span className="grid-card-acts">
          <button className="icon-btn" title="Open on its own" onClick={() => onOpen(s.id)}>
            <Maximize2 size={12} />
          </button>
          <button className="icon-btn" title="Remove from the grid" onClick={() => grid.remove(s.id)}>
            <X size={13} />
          </button>
        </span>
      </div>
      <div className="grid-card-body">
        <SessionView key={s.id} session={s} dropZone={ref} />
      </div>
      {over && <div className="grid-drop-hint">drop to replace or add</div>}
    </div>
  );
}

/**
 * Chat grid: the chats you picked, side by side as live cards (2 across; past four, the rest scroll in rows of two).
 * Drag a chat from the sidebar onto a card to replace it, or onto the "add" tile to add it.
 */
export function ChatGridView({ sessions, onOpen, onBack, onWall }: { sessions: Record<string, SessionState>; onOpen(id: string): void; onBack(): void; onWall(): void }) {
  const ids = useGrid().filter((id) => sessions[id]);
  const menu = useMenu();
  const scroller = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(600);
  const [overAdd, setOverAdd] = useState(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    // Shift + scroll moves the grid itself, wherever the cursor is (macOS turns it into a sideways scroll; use either axis).
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      el.scrollTop += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => (ro.disconnect(), el.removeEventListener("wheel", onWheel, { capture: true }));
  }, []);
  // A sidebar click on a chat that's in the grid scrolls to its card and flashes it.
  useEffect(() => {
    const on = (e: Event) => {
      const el = document.getElementById(`grid-card-${(e as CustomEvent<string>).detail}`);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      el.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    };
    window.addEventListener("happy:grid-focus", on);
    return () => window.removeEventListener("happy:grid-focus", on);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(document.activeElement as HTMLElement)?.closest?.("textarea, input") && onBack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);
  const all = live(Object.values(sessions)).sort((a, b) => lastMessageAt(b) - lastMessageAt(a));
  const addMenu = (el: HTMLElement) =>
    menu.below(
      el,
      all.filter((s) => !ids.includes(s.id)).slice(0, 30).map((s) => ({ label: s.title, onSelect: () => grid.add(s.id) })),
    );
  const addTile = (
    <div
      className={`grid-add ${overAdd ? "drop" : ""} ${ids.length ? "" : "empty"}`}
            onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && (e.preventDefault(), setOverAdd(true))}
      onDragLeave={() => setOverAdd(false)}
      onDrop={(e) => {
        setOverAdd(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id) (e.preventDefault(), grid.add(id));
      }}
      onClick={(e) => addMenu(e.currentTarget)}
    >
      <Plus size={16} />
      <span>{ids.length ? "drag a chat here to add it, or click" : "Drag chats here from the sidebar, ⌘-click several there and right-click → Add to chat grid, or pick them on the Chat wall"}</span>
    </div>
  );
  // 1 → full; 2 → side by side, full height; 3+ → two rows per screen, scrolling past four.
  const rows = ids.length <= 2 ? h - 12 : (h - 24) / 2;
  const cols = ids.length ? 2 : 1;
  return (
    <div className="chatgrid">
      <div className="ac-bar">
        <b>Chat grid</b>
        <span className="muted mono small">{ids.length} chats</span>
        <span className="ac-bar-right">
          <button className="link-btn" onClick={(e) => addMenu(e.currentTarget)}>
            add
          </button>
          <button className="link-btn" onClick={onWall}>
            pick on the chat wall
          </button>
          {ids.length > 0 && (
            <button className="link-btn" onClick={() => grid.clear()}>
              clear
            </button>
          )}
          <button className="icon-btn" title="Close the grid (Esc)" onClick={onBack}>
            <X size={14} />
          </button>
        </span>
      </div>
      <div className="grid-scroll" ref={scroller}>
        <div className="grid-cards" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: `${Math.max(260, rows)}px` }}>
          {ids.map((id, i) => (
            <GridCard key={id} s={sessions[id]} index={i} onOpen={onOpen} sessions={sessions} />
          ))}
          {(ids.length % 2 === 1 || !ids.length) && addTile}
        </div>
        {ids.length > 0 && ids.length % 2 === 0 && <div className="grid-add-bar">{addTile}</div>}
      </div>
    </div>
  );
}


