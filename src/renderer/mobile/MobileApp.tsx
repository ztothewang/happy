import { Plus, Settings } from "lucide-react";
import { stageLabel } from "../Sidebar";
import { useEffect, useMemo, useState } from "react";
import type { CloudSnapshot, Inbox, SessionGroup, SessionState } from "../../shared/types";
import { hub } from "../App";
import { lastMessageAt } from "../models";
import { useSettings } from "../settings";
import { SettingsView } from "../SettingsView";
import { MCal, MMail } from "./MMail";
import { MNewChat, MSession, sessionStatus } from "./MSession";
import { MCloud } from "./MCloud";
import { MBoard, MTasks } from "./MTabs";
import { BigTitle, Empty, Fab, Group, IconBtn, Nav, Pill, Row, TabBar, ago, type Tab } from "./ui";

type Screen = { kind: "session"; id: string } | { kind: "new" } | { kind: "settings" } | { kind: "manager" } | { kind: "cloudChat"; board: string; ask?: string } | { kind: "mailChat"; threadId?: string } | { kind: "archived" };

const TAB_KEY = "happy.m.tab";
/** "What's causing C2? (slow query…)" → "slow query…" (refs like C2 change on every refresh). */
const askTitle = (q: string) => q.replace(/^What's causing [A-Z]\d+\? \((.*)\)$/s, "$1");

function ChatsTab({ sessions, onOpen, onNew, onSettings, onArchived }: { sessions: SessionState[]; onOpen(id: string): void; onNew(): void; onSettings(): void; onArchived(): void }) {
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  useEffect(() => {
    void hub().groups().then(setGroups);
    return hub().onGroups(setGroups);
  }, []);
  const n = q.trim().toLowerCase();
  const match = (s: SessionState) => !n || `${s.title} ${s.tags?.join(" ") ?? ""}`.toLowerCase().includes(n);
  const live = sessions.filter((s) => !s.archived && match(s));
  const needs = live.filter((s) => s.status === "needs_permission" || s.status === "error");
  const working = live.filter((s) => s.status === "running" || s.preparing);
  const rest = live.filter((s) => !needs.includes(s) && !working.includes(s));
  // Archived chats stay out of the list unless searching; "All archived chats" lists them.
  const archivedHits = n ? sessions.filter((s) => s.archived && match(s)) : [];
  const row = (s: SessionState) => {
    const st = sessionStatus(s);
    // Same as the desktop sidebar: status while busy, then the code stage badge, then tags.
    const stage = stageLabel(s);
    const busy = !!st.tone;
    return (
      <Row
        key={s.id}
        title={s.title}
        sub={
          <span className="mx-inline mx-rowsub">
            {busy && <Pill tone={st.tone}>{st.label}</Pill>}
            {stage && <span className={`sc-stage s-${stage}`}>{stage}</span>}
            {s.tags?.map((t) => (
              <span key={t} className="r-tag">
                #{t}
              </span>
            ))}
            {!busy && !stage && !s.tags?.length && <span className="mx-muted">{st.label}</span>}
          </span>
        }
        right={ago(lastMessageAt(s))}
        onClick={() => onOpen(s.id)}
      />
    );
  };
  return (
    <div className="mx-screen">
      <Nav
        right={
          <IconBtn label="Settings" onClick={onSettings}>
            <Settings size={18} />
          </IconBtn>
        }
      />
      <div className="mx-scroll">
        <BigTitle>Chats</BigTitle>
        <input className="mx-search" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
        {needs.length > 0 && <Group title="Needs you">{needs.map(row)}</Group>}
        {working.length > 0 && <Group title="Working">{working.map(row)}</Group>}
        {rest.filter((s) => !s.groupId || !groups.some((g) => g.id === s.groupId)).length > 0 && (
          <Group title="Sessions">{rest.filter((s) => !s.groupId || !groups.some((g) => g.id === s.groupId)).map(row)}</Group>
        )}
        {groups.map((g) => {
          const xs = rest.filter((s) => s.groupId === g.id);
          return xs.length ? (
            <Group key={g.id} title={g.name}>
              {xs.map(row)}
            </Group>
          ) : null;
        })}
        {archivedHits.length > 0 && <Group title="Archived">{archivedHits.slice(0, 10).map(row)}</Group>}
        {!live.length && !archivedHits.length && <Empty>{n ? "No matches" : "No chats yet. Tap + to start one."}</Empty>}
        <button className="mx-link mx-sub-pad" onClick={onArchived}>
          All archived chats ›
        </button>
      </div>
      <Fab round onClick={onNew}>
        <Plus size={26} />
      </Fab>
    </div>
  );
}

function ArchivedScreen({ sessions, onOpen, onBack }: { sessions: SessionState[]; onOpen(id: string): void; onBack(): void }) {
  const xs = sessions.filter((s) => s.archived).sort((a, b) => lastMessageAt(b) - lastMessageAt(a));
  return (
    <div className="mx-screen">
      <Nav onBack={onBack} title="Archived" />
      <div className="mx-scroll">
        <Group>{xs.length ? xs.map((s) => <Row key={s.id} title={s.title} sub={`${s.engine} · ${sessionStatus(s).label}`} right={ago(lastMessageAt(s))} onClick={() => onOpen(s.id)} />) : <Row title="Nothing archived" chevron={false} />}</Group>
      </div>
    </div>
  );
}

/** Happy at phone width: a tab bar of pages, a stack of screens on top, details in bottom sheets. */
export function MobileApp({ sessions }: { sessions: Record<string, SessionState> }) {
  const st = useSettings();
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem(TAB_KEY) as Tab) || "chats";
    } catch {
      return "chats";
    }
  });
  const [stack, setStack] = useState<Screen[]>([]);
  const [cloud, setCloud] = useState<CloudSnapshot | null>(null);
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [cloudChatId, setCloudChatId] = useState<string | null>(null);
  const [mailChatId, setMailChatId] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {}
  }, [tab]);
  useEffect(() => {
    void hub().cloud().then(setCloud);
    const a = hub().onCloud(setCloud);
    const b = hub().onInbox(setInbox);
    void hub().gmailStatus().then((g) => g.connected && void hub().inbox().then(setInbox));
    return () => (a(), b());
  }, []);
  // Deep links from notifications: #session=<id>
  useEffect(() => {
    const go = () => {
      const m = location.hash.match(/session=([\w-]+)/);
      if (m) setStack([{ kind: "session", id: m[1] }]);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);

  const all = useMemo(() => Object.values(sessions).sort((a, b) => lastMessageAt(b) - lastMessageAt(a)), [sessions]);
  const workers = all.filter((s) => !s.isManager && !s.isCloud && !s.isEmail);
  const manager = all.find((s) => s.isManager);
  const show = st?.show ?? { manager: true, cloud: true, tasks: true, email: true, calendar: true, terminal: true };
  const tabs: Tab[] = ["chats", ...(show.manager ? (["board"] as Tab[]) : []), ...(show.cloud ? (["cloud"] as Tab[]) : []), ...(show.tasks ? (["tasks"] as Tab[]) : []), ...(show.email ? (["mail"] as Tab[]) : []), ...(show.calendar ? (["cal"] as Tab[]) : [])];
  const push = (s: Screen) => setStack((x) => [...x, s]);
  const pop = () => setStack((x) => x.slice(0, -1));
  const top = stack[stack.length - 1];

  const openCloudChat = async (board: string, question?: string) => {
    const c = await hub().cloudChat();
    setCloudChatId(c.id);
    push({ kind: "cloudChat", board });
    if (question?.trim()) void hub().cloudAsk(question, board);
  };
  /** The Mail chat, about a thread or with a question (zero inbox). */
  const openMailChat = async (threadId?: string, ask?: string) => {
    const c = await hub().emailChat();
    setMailChatId(c.id);
    push({ kind: "mailChat", threadId });
    if (ask?.trim()) void hub().emailAsk(ask, threadId);
  };
  /** Ask/Fix on a specific Cloud item: its own session, filed under "<Tenant> cloud". The board chat (FAB) stays for free-form questions. */
  const cloudSpawn = async (mode: "ask" | "fix", board: string, title: string, prompt: string) => {
    const s = await hub().cloudSpawn({ mode, board, title, prompt });
    push({ kind: "session", id: s.id });
  };

  let screen: React.ReactNode;
  if (top?.kind === "session" && sessions[top.id]) screen = <MSession key={top.id} s={sessions[top.id]} onBack={pop} />;
  else if (top?.kind === "new") screen = <MNewChat onBack={pop} defaultEngine={st?.defaultEngine ?? "claude"} onCreated={(id) => setStack([{ kind: "session", id }])} />;
  else if (top?.kind === "settings")
    screen = (
      <div className="mx-screen">
        <Nav onBack={pop} title="Settings" />
        <div className="mx-scroll mx-settings">
          <SettingsView />
        </div>
      </div>
    );
  else if (top?.kind === "archived") screen = <ArchivedScreen sessions={workers} onBack={pop} onOpen={(id) => push({ kind: "session", id })} />;
  else if (top?.kind === "manager" && manager) screen = <MSession s={manager} onBack={pop} title="Manager" placeholder="Ask about the board: “why is E1 happening?”, “summarize D2”." />;
  else if (top?.kind === "mailChat" && mailChatId && sessions[mailChatId])
    screen = (
      <MSession
        s={sessions[mailChatId]}
        onBack={pop}
        title="Mail"
        send={(text) => void hub().emailAsk(text, top.threadId)}
        placeholder={top.threadId ? "Ask about this email, or say what to do" : "Ask about your email, or say what to do"}
      />
    );
  else if (top?.kind === "cloudChat" && cloudChatId && sessions[cloudChatId])
    screen = (
      <MSession
        s={sessions[cloudChatId]}
        onBack={pop}
        title={`Cloud · ${top.board === "all" ? "all tenants" : top.board}`}
        send={(text) => void hub().cloudAsk(text, top.board)}
        placeholder="Ask about this board: “what's causing C1?”"
      />
    );

  const badges = {
    chats: workers.filter((s) => s.status === "needs_permission" || s.status === "error").length,
    cloud: cloud?.tenants.reduce((n, t) => n + t.issues.length, 0) ?? 0,
    mail: inbox?.importantUnread ?? 0,
  };
  return (
    <div className="mx-app">
      {screen ?? (
        <>
          <div className="mx-page">
            {tab === "chats" && (
              <ChatsTab sessions={workers} onOpen={(id) => push({ kind: "session", id })} onNew={() => push({ kind: "new" })} onSettings={() => push({ kind: "settings" })} onArchived={() => push({ kind: "archived" })} />
            )}
            {tab === "board" && <MBoard onOpenSession={(id) => push({ kind: "session", id })} onChat={() => push({ kind: "manager" })} onCloud={() => setTab("cloud")} />}
            {tab === "cloud" && <MCloud actions={{ ask: (board, q) => void (q.trim() ? cloudSpawn("ask", board, askTitle(q), q) : openCloudChat(board)), fix: (board, title, prompt) => void cloudSpawn("fix", board, title, prompt) }} />}
            {tab === "tasks" && <MTasks sessions={sessions} onOpenSession={(id) => push({ kind: "session", id })} defaultEngine={st?.defaultEngine ?? "claude"} />}
            {tab === "mail" && <MMail onChat={(threadId, ask) => void openMailChat(threadId, ask)} />}
            {tab === "cal" && <MCal />}
          </div>
          <TabBar tab={tabs.includes(tab) ? tab : "chats"} onTab={setTab} badges={badges} tabs={tabs} />
        </>
      )}
    </div>
  );
}
