import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isSystemSession } from "../shared/types";
import type { BrowserState, EngineLimits, HubApi, SessionGroup, SessionState, UsageTotals } from "../shared/types";
import { MenuProvider } from "./Menu";
import { CLAUDE_MODELS, PERMISSION_MODES, lastMessageAt } from "./models";
import { NewChat } from "./NewChat";
import { TerminalView } from "./TerminalView";
import { StatsView } from "./StatsView";
import { useRepo, useSettings } from "./settings";
import { OverviewView } from "./Overview";
import { CloudView } from "./CloudView";
import { MobileApp } from "./mobile/MobileApp";
import { Lightbox, openLightbox } from "./Lightbox";
import { ResizeHandle, usePanelWidth } from "./resize";
import { CHAT_WALL, CALENDAR, CLOUD, EMAIL, GRID, SETTINGS, TASKS, TERMINAL, STATS } from "./Sidebar";
import { ChatWallView, ChatGridView } from "./ChatViews";
import { useGrid } from "./grid";
import { SettingsView } from "./SettingsView";
import { CalendarView } from "./CalendarView";
import { EmailView } from "./EmailView";
import { TasksView } from "./TasksView";
import { Palette, type PaletteItem } from "./Palette";
import { PaneContext, fileUrl, isImagePath, resolvePath, toTab, type PaneApi, type PaneState, type TabInput } from "./pane";
import { PreviewPane } from "./PreviewPane";
import { SessionView, readShowSys, readShowTools, writeShowSys, writeShowTools } from "./SessionView";
import { Sidebar, setTagDefs } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { ToastProvider, useToast } from "./toast";
import { TopBar } from "./TopBar";

declare global {
  interface Window {
    hub: HubApi;
  }
}
export const hub = () => window.hub;

const PANE_KEY = "session-hub:panes";
const PANE_WIDTH_KEY = "session-hub:pane-width";
const SIDEBAR_WIDTH_KEY = "session-hub:sidebar-width";
const NEW = "new";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

export function App() {
  return (
    <ToastProvider>
      <MenuProvider>
        <Shell />
        <Lightbox />
      </MenuProvider>
    </ToastProvider>
  );
}

function Shell() {
  const [sessions, setSessions] = useState<Record<string, SessionState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  // Where to go back to when the grid closes.
  const beforeGrid = useRef<string | null>(null);
  useEffect(() => {
    if (selected !== GRID && selected !== CHAT_WALL) beforeGrid.current = selected;
  }, [selected]);
  const gridIds = useGrid();
  // Open a chat from anywhere (e.g. a fresh fork from the session menu).
  useEffect(() => {
    const on = (e: Event) => setSelected((e as CustomEvent<string>).detail);
    window.addEventListener("happy:open-session", on);
    return () => window.removeEventListener("happy:open-session", on);
  }, []);
  const [sidebarHidden, setSidebarHidden] = useState<boolean>(() => loadJson("happy.sidebar.hidden", false));
  useEffect(() => saveJson("happy.sidebar.hidden", sidebarHidden), [sidebarHidden]);
  const repo = useRepo();
  const st = useSettings();
  useEffect(() => hub().onFocusSession((id) => setSelected(id)), []);
  useEffect(() => {
    const open = () => setSelected(TERMINAL);
    window.addEventListener("happy:open-terminal", open);
    return () => window.removeEventListener("happy:open-terminal", open);
  }, []);
  const [boardWidth, setBoardWidth] = usePanelWidth("manager-board", 780);
  // Phone-width layout: list or one screen at a time.
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // Deep links from notifications: #session=<id>
  useEffect(() => {
    const go = () => {
      const m = location.hash.match(/session=([\w-]+)/);
      if (m) setSelected(m[1]);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);
  /** Sessions with something new for you: finished, waiting on you, or failed. Cleared when you click the session. */
  const [unread, setUnread] = useState<Map<string, "done" | "blocked" | "failed">>(new Map());
  const [panes, setPanes] = useState<Record<string, PaneState>>(() => loadJson(PANE_KEY, {}));
  const [paneWidth, setPaneWidth] = useState<number>(() => loadJson(PANE_WIDTH_KEY, 520));
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadJson(SIDEBAR_WIDTH_KEY, 340));
  const [browserStates, setBrowserStates] = useState<Record<string, BrowserState>>({});
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [filter, setFilter] = useState("");
  const [usage, setUsage] = useState<UsageTotals>({ tokens: 0, costUsd: 0 });
  const [palette, setPalette] = useState(false);
  const [limits, setLimits] = useState<EngineLimits>({});
  const mainRef = useRef<HTMLElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const prevStatus = useRef<Record<string, string>>({});
  const toast = useToast();

  useEffect(() => saveJson(PANE_KEY, panes), [panes]);
  useEffect(() => saveJson(PANE_WIDTH_KEY, paneWidth), [paneWidth]);
  useEffect(() => saveJson(SIDEBAR_WIDTH_KEY, sidebarWidth), [sidebarWidth]);

  const updatePane = useCallback((sid: string, fn: (p: PaneState) => PaneState) => {
    setPanes((all) => ({ ...all, [sid]: fn(all[sid] ?? { open: false, tabs: [] }) }));
  }, []);

  const openTab = useCallback(
    (sid: string, input: TabInput, focus = true) =>
      updatePane(sid, (p) => {
        const tab = toTab(input);
        const exists = p.tabs.some((t) => t.key === tab.key);
        const tabs = exists ? p.tabs.map((t) => (t.key === tab.key ? tab : t)) : [...p.tabs, tab];
        return { open: true, tabs, active: focus || !p.active ? tab.key : p.active };
      }),
    [updatePane],
  );

  useEffect(() => {
    hub()
      .list()
      .then((list) => {
        setSessions(Object.fromEntries(list.map((s) => [s.id, s])));
        list.forEach((s) => (prevStatus.current[s.id] = s.status));
        // Phone width opens on the list; desktop opens a new chat.
        setSelected((cur) => cur ?? (window.matchMedia("(max-width: 760px)").matches ? null : NEW));
        list.forEach((s) => hub().browserState(s.id).then((b) => b && setBrowserStates((m) => ({ ...m, [s.id]: b }))));
      });
    hub().groups().then(setGroups);
    hub().usageToday().then(setUsage);
    hub().limits().then(setLimits);
    const offs = [
      hub().onGroups(setGroups),
      hub().onUsage(setUsage),
      hub().onLimits(setLimits),
      hub().onUpdate((s) => {
        setSessions((prev) => ({ ...prev, [s.id]: s }));
        const before = prevStatus.current[s.id];
        prevStatus.current[s.id] = s.status;
        const finished = before === "running" && s.status === "idle";
        const blocked = before !== "needs_permission" && s.status === "needs_permission";
        const failed = before === "running" && s.status === "error";
        if ((finished || blocked || failed) && !isSystemSession(s) && (s.id !== selectedRef.current || !document.hasFocus())) {
          const kind = blocked ? "blocked" : failed ? "failed" : "done";
          setUnread((u) => new Map(u).set(s.id, kind));
          new Notification(s.title, {
            body: blocked ? (s.pending?.tool === "AskUserQuestion" ? "Has a question for you" : `Needs permission: ${s.pending?.tool}`) : failed ? "Failed" : "Finished",
            silent: kind === "done",
          });
          if (blocked) void hub().attention();
        }
      }),
      hub().onRemoved((id) => {
        setSessions((prev) => {
          const { [id]: _, ...rest } = prev;
          return rest;
        });
        setSelected((cur) => (cur === id ? NEW : cur));
      }),
      hub().onBrowserState((b) => setBrowserStates((m) => ({ ...m, [b.sessionId]: b }))),
      // When an agent starts using its browser, surface the browser tab (without stealing focus from an open file).
      hub().onBrowserActivity((sid) =>
        setPanes((all) => {
          const p = all[sid] ?? { open: false, tabs: [] };
          if (p.tabs.some((t) => t.kind === "browser")) return p.open ? all : { ...all, [sid]: { ...p, open: true } };
          return {
            ...all,
            [sid]: { open: true, tabs: [...p.tabs, { key: "browser", kind: "browser" }], active: p.open && p.active ? p.active : "browser" },
          };
        }),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const ordered = useMemo(
    () => Object.values(sessions).filter((s) => !s.isCloud && !s.isEmail).sort((a, b) => Number(!!b.isManager) - Number(!!a.isManager) || lastMessageAt(b) - lastMessageAt(a)),
    [sessions],
  );
  // Your tags from Settings first, then any others sessions already use.
  useEffect(() => setTagDefs(st?.tags ?? []), [st?.tags]);
  const allTags = useMemo(() => [...new Set([...(st?.tags ?? []).map((t) => t.name), ...Object.values(sessions).flatMap((s) => s.tags ?? []).sort()])], [sessions, st?.tags]);

  const select = useCallback((id: string) => {
    setSelected(id);
    setUnread((u) => {
      if (!u.has(id)) return u;
      const n = new Map(u);
      n.delete(id);
      return n;
    });
  }, []);

  // Dock badge = number of sessions with something new.
  useEffect(() => {
    void hub().setBadge(unread.size);
  }, [unread]);

  const current = selected && selected !== NEW && selected !== CLOUD && selected !== TASKS && selected !== EMAIL && selected !== CALENDAR && selected !== SETTINGS ? sessions[selected] : undefined;
  const pane = current ? (panes[current.id] ?? { open: false, tabs: [] }) : undefined;
  const togglePane = () => current && updatePane(current.id, (p) => ({ ...p, open: !p.open }));

  // ⌘N new, ⌘K palette, ⌘1-9 switch, ⌘\ toggle pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "n") {
        e.preventDefault();
        setSelected(NEW);
      } else if (e.key === ",") {
        e.preventDefault();
        setSelected(SETTINGS);
      } else if (e.key === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === "b") {
        e.preventDefault();
        setSidebarHidden((h) => !h);
      } else if (e.key === "7" || e.key === "8") {
        e.preventDefault();
        select(e.key === "7" ? CHAT_WALL : GRID);
      } else if (e.key === "\\" && current) {
        e.preventDefault();
        togglePane();
      } else if (/^Digit[1-9]$/.test(e.code) && e.altKey) {
        // ⌘⌥1–9: chats in sidebar order.
        const s = ordered.filter((x) => !x.archived && !x.isManager)[Number(e.code.slice(5)) - 1];
        if (s) {
          e.preventDefault();
          select(s.id);
        }
      } else if (/^[1-6]$/.test(e.key)) {
        // ⌘1–6: the sections, in sidebar order (Manager, Cloud, Tasks, Email, Calendar, Terminal; hidden ones skipped).
        const show = st?.show;
        const mgr = ordered.find((x) => x.isManager);
        const tabs = [
          show?.manager !== false && mgr ? mgr.id : null,
          show?.cloud !== false ? CLOUD : null,
          show?.tasks !== false ? TASKS : null,
          show?.email !== false ? EMAIL : null,
          show?.calendar !== false ? CALENDAR : null,
          show?.terminal !== false ? TERMINAL : null,
        ].filter((x): x is string => !!x);
        const t = tabs[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          select(t);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const paneApi = useMemo<PaneApi>(() => {
    if (!current) return { open: () => {}, openLink: () => {} };
    return {
      open: (t) => openTab(current.id, t),
      runCommand: (command) => {
        openTab(current.id, { kind: "terminal" });
        void hub().termRun(current.id, command);
      },
      openInHappy: (href) => {
        openTab(current.id, { kind: "browser" });
        void hub().browserNavigate(current.id, href);
      },
      openLink: (href) => {
        if (/^https?:\/\//i.test(href)) {
          // Claude designs and artifacts open in the side panel's browser (signed in there); other links in Chrome.
          if (/^https?:\/\/([\w-]+\.)*(claude\.ai|claude\.site|claudeusercontent\.com)(\/|$)/i.test(href)) {
            openTab(current.id, { kind: "browser" });
            void hub().browserNavigate(current.id, href);
          } else void hub().openInChrome(href);
        } else if (href.startsWith("#") || /^mailto:/i.test(href)) {
          return;
        } else {
          const sid = current.id;
          void hub()
            .resolveLink(sid, href)
            .then((r) => {
              if (r.kind === "dir") openTab(sid, { kind: "dir", path: r.path });
              else if (r.kind === "image") openLightbox(fileUrl(r.path));
              else openTab(sid, { kind: "file", path: r.path, line: r.line }); // missing → file view says "not found"
            })
            .catch(() => {
              const { path, line } = resolvePath(href, current.cwd);
              if (isImagePath(path)) openLightbox(fileUrl(path));
              else openTab(sid, { kind: "file", path, line });
            });
        }
      },
    };
  }, [current, openTab]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      { id: "new", kind: "action", label: "New chat", hint: "⌘N", run: () => setSelected(NEW) },
      { id: "chatwall", kind: "view", label: "Chat wall", hint: "⌘7", run: () => setSelected(CHAT_WALL) },
      { id: "grid", kind: "view", label: "Chat grid", hint: "⌘8", run: () => setSelected(GRID) },
      { id: "sidebar", kind: "view", label: "Toggle sidebar", hint: "⌘B", run: () => setSidebarHidden((h) => !h) },
      { id: "tools", kind: "view", label: readShowTools() ? "Hide tool steps by default" : "Always show tool steps", run: () => writeShowTools(!readShowTools()) },
      { id: "sys", kind: "view", label: readShowSys() ? "Hide system notes" : "Show system notes", run: () => writeShowSys(!readShowSys()) },
      { id: "f-run", kind: "filter", label: "Show running sessions", run: () => setFilter("is:running") },
      { id: "f-wait", kind: "filter", label: "Show sessions waiting on me", run: () => setFilter("is:waiting") },
      ...(st?.tags ?? []).map(({ name: t }) => ({ id: `f-${t}`, kind: "filter", label: `Show #${t} sessions`, run: () => setFilter(`tag:${t}`) })),
    ];
    if (current) {
      const sid = current.id;
      items.push(
        { id: "pane", kind: "action", label: "Toggle side pane", hint: "⌘\\", run: togglePane },
        { id: "changes", kind: "action", label: "Show uncommitted changes", run: () => openTab(sid, { kind: "changes" }) },
        { id: "browser", kind: "action", label: "Open browser", run: () => openTab(sid, { kind: "browser" }) },
        { id: "stop", kind: "action", label: "Stop current turn", hint: "esc", run: () => void hub().interrupt(sid) },
        ...(st?.tags ?? []).map(({ name: t }) => ({
          id: `tag-${t}`,
          kind: "tag",
          label: current.tags?.includes(t) ? `Remove #${t}` : `Tag as #${t}`,
          run: () => void hub().setTags(sid, current.tags?.includes(t) ? current.tags.filter((x) => x !== t) : [...(current.tags ?? []), t]),
        })),
        ...(current.engine === "claude"
          ? CLAUDE_MODELS.map((m) => ({ id: `m-${m.label}`, kind: "model", label: `Model: ${m.label}`, run: () => void hub().setModel(sid, m.id) }))
          : [{ id: "m-default", kind: "model", label: "Model: Default", run: () => void hub().setModel(sid, null) }]),
        ...(current.engine === "claude"
          ? PERMISSION_MODES.map((m) => ({ id: `p-${m.value}`, kind: "mode", label: `Mode: ${m.label}`, run: () => void hub().setPermissionMode(sid, m.value) }))
          : []),
        ...groups.map((g) => ({ id: `g-${g.id}`, kind: "group", label: `Move to ${g.name}`, run: () => void hub().moveToGroup(sid, g.id) })),
      );
      if (!current.isManager)
        items.push({
          id: "archive",
          kind: "action",
          label: "Archive session",
          run: () => {
            void hub().setArchived(sid, true);
            toast(`archived “${current.title}”`, { label: "undo", run: () => hub().setArchived(sid, false) });
          },
        });
    }
    for (const s of ordered)
      items.push({
        id: `s-${s.id}`,
        kind: s.archived ? "archived" : "session",
        label: s.title,
        hint: s.status === "running" ? "running" : s.status === "needs_permission" ? "waiting" : undefined,
        run: () => select(s.id),
      });
    return items;
  }, [current, ordered, groups, st?.tags]);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const move = (ev: MouseEvent) => setSidebarWidth(Math.min(Math.max(220, startW + (ev.clientX - startX)), Math.min(640, window.innerWidth - 480)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = paneWidth;
    const move = (ev: MouseEvent) => setPaneWidth(Math.min(Math.max(300, startW + (startX - ev.clientX)), window.innerWidth - 560));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Phone width: a separate, touch-first layout over the same data.
  if (narrow) return <MobileApp sessions={sessions} />;

  return (
    <PaneContext.Provider value={paneApi}>
      <div className="shell">
        <TopBar
          session={current}
          newChatRepo={repo}
          groups={groups}
          allTags={allTags}
          limits={limits}
          paneOpen={!!pane?.open}
          onTogglePane={togglePane}
          onPalette={() => setPalette(true)}
          sidebarHidden={sidebarHidden}
          onToggleSidebar={() => setSidebarHidden((h) => !h)}
          gridCount={selected === GRID ? 0 : gridIds.length}
          onGrid={() => select(GRID)}
        />
        <div className="shell-body">
          {!sidebarHidden && (
          <Sidebar
            sessions={ordered}
            groups={groups}
            allTags={allTags}
            selected={selected}
            unread={unread}
            filter={filter}
            onFilter={setFilter}
            onSelect={select}
            onNew={() => setSelected(NEW)}
            width={sidebarWidth}
          />
          )}
          {!sidebarHidden && <div className="resizer" onMouseDown={startSidebarResize} onDoubleClick={() => setSidebarWidth(340)} title="Drag to resize · double-click to reset" />}
          <main className="main" ref={mainRef}>
            {current?.isManager ? (
              <div className="mgr">
                <div className="mgr-left" style={{ width: boardWidth }}>
                  <OverviewView onOpen={select} />
                </div>
                <ResizeHandle width={boardWidth} onWidth={setBoardWidth} side="left" min={360} max={1100} reset={620} />
                <div className="mgr-right">
                  <div className="mgr-chat-h">
                    <b>Manager chat</b>
                    <span className="muted small">can reference the board (A1, D3, M2, E1…)</span>
                    {current.items.length > 0 && (
                      <button className="link-btn" disabled={current.status === "running"} onClick={() => void hub().newSystemChat(current.id)} title="Start a fresh conversation">
                        new chat
                      </button>
                    )}
                  </div>
                  <SessionView key={current.id} session={current} dropZone={mainRef} />
                </div>
              </div>
            ) : current ? (
              <SessionView key={current.id} session={current} dropZone={mainRef} />
            ) : selected === CLOUD ? (
              <CloudView sessions={sessions} dropZone={mainRef} onOpen={select} />
            ) : selected === TASKS ? (
              <TasksView sessions={sessions} onOpen={select} />
            ) : selected === EMAIL ? (
              <EmailView sessions={sessions} />
            ) : selected === CALENDAR ? (
              <CalendarView />
            ) : selected === TERMINAL ? (
              <TerminalView />
            ) : selected === CHAT_WALL ? (
              <ChatWallView sessions={ordered} groups={groups} onOpen={select} onGrid={() => select(GRID)} />
            ) : selected === GRID ? (
              <ChatGridView sessions={sessions} onOpen={select} onWall={() => select(CHAT_WALL)} onBack={() => select(beforeGrid.current && sessions[beforeGrid.current] ? beforeGrid.current : (ordered.find((s) => s.isManager)?.id ?? NEW))} />
            ) : selected === STATS ? (
              <StatsView />
            ) : selected === SETTINGS ? (
              <SettingsView />
            ) : (
              <NewChat
                dropZone={mainRef}
                onCreated={(s) => {
                  setSessions((prev) => ({ ...prev, [s.id]: s }));
                  select(s.id);
                }}
              />
            )}
          </main>
          {current && pane?.open && (
            <>
              <div className="resizer" onMouseDown={startResize} />
              <div className="pane-wrap" style={{ width: paneWidth }}>
                <PreviewPane
                  key={current.id}
                  sessionId={current.id}
                  cwd={current.cwd}
                  items={current.items}
                  tabs={pane.tabs}
                  active={pane.active}
                  browser={browserStates[current.id]}
                  hideNative={palette}
                  onActivate={(k) => updatePane(current.id, (p) => ({ ...p, active: k }))}
                  onCloseTab={(k) =>
                    updatePane(current.id, (p) => {
                      const idx = p.tabs.findIndex((t) => t.key === k);
                      const tabs = p.tabs.filter((t) => t.key !== k);
                      const active = p.active === k ? tabs[Math.max(0, idx - 1)]?.key : p.active;
                      return { open: tabs.length > 0 && p.open, tabs, active };
                    })
                  }
                  onClosePane={() => updatePane(current.id, (p) => ({ ...p, open: false }))}
                  onCloseAll={() => updatePane(current.id, () => ({ open: false, tabs: [] }))}
                  checkouts={[
                    ...(current.worktree?.removed ? [] : [{ path: current.cwd, label: current.worktree?.branch ?? current.git?.branch ?? "this folder" }]),
                    ...(current.linkedWorktrees ?? []).filter((w) => !w.removed).map((w) => ({ path: w.path, label: w.branch ?? w.path.split("/").pop()! })),
                  ]}
                />
              </div>
            </>
          )}
        </div>
        <StatusBar sessions={ordered} usage={usage} onFilter={setFilter} onNew={() => setSelected(NEW)} onPalette={() => setPalette(true)} />
      </div>
      {palette && <Palette items={paletteItems} onClose={() => setPalette(false)} />}
    </PaneContext.Provider>
  );
}
