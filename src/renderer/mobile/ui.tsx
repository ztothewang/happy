import { CalendarDays, ChevronLeft, ChevronRight, Cloud, LayoutDashboard, ListTodo, Mail, MessagesSquare, type LucideIcon } from "lucide-react";
import { num } from "../models";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** Phone building blocks: navigation bar, large title, grouped lists, bottom sheets, chips, tab bar. */

export const ago = (ts?: number) => {
  if (!ts) return "";
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
export const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function Nav({ title, onBack, right }: { title?: ReactNode; onBack?(): void; right?: ReactNode }) {
  return (
    <div className="mx-nav">
      {onBack ? (
        <button className="mx-back" onClick={onBack} aria-label="Back">
          <ChevronLeft size={26} strokeWidth={2.2} />
        </button>
      ) : (
        <span className="mx-back-sp" />
      )}
      <h3>{title}</h3>
      <div className="mx-nav-r">{right}</div>
    </div>
  );
}

export function IconBtn({ children, onClick, label }: { children: ReactNode; onClick?(): void; label: string }) {
  return (
    <button className="mx-ico" onClick={onClick} aria-label={label} title={label}>
      {children}
    </button>
  );
}

export function BigTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mx-big">
      <h1>
        <img className="logo" src="apple-touch-icon.png" alt="" />
        {children}
      </h1>
      {sub && <div className="mx-big-sub">{sub}</div>}
    </div>
  );
}

export function Group({ title, action, children }: { title?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-group">
      {(title || action) && (
        <div className="mx-group-h">
          <span>{title}</span>
          {action}
        </div>
      )}
      <div className="mx-list">{children}</div>
    </div>
  );
}

export function Row({ title, sub, right, lead, onClick, wrap, chevron = true }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; lead?: ReactNode; onClick?(): void; wrap?: boolean; chevron?: boolean }) {
  return (
    <button className="mx-row" onClick={onClick} disabled={!onClick}>
      {lead}
      <span className="mx-row-main">
        <span className={`mx-row-t ${wrap ? "wrap" : ""}`}>{title}</span>
        {sub && <span className="mx-row-s">{sub}</span>}
      </span>
      {right && <span className="mx-row-r">{right}</span>}
      {onClick && chevron && <ChevronRight className="mx-chev" size={18} />}
    </button>
  );
}

export function Pill({ tone, children }: { tone?: "run" | "need" | "bad" | "cool"; children: ReactNode }) {
  return <span className={`mx-pill ${tone ?? ""}`}>{children}</span>;
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<[NoInfer<T>, ReactNode]>; onChange(v: NoInfer<T>): void }) {
  return (
    <div className="mx-seg">
      {options.map(([v, l]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ value, options, onChange }: { value: T; options: Array<[NoInfer<T>, ReactNode]>; onChange(v: NoInfer<T>): void }) {
  return (
    <div className="mx-chips">
      {options.map(([v, l]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Fab({ children, onClick, round }: { children: ReactNode; onClick(): void; round?: boolean }) {
  return (
    <button className={`mx-fab ${round ? "round" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="mx-empty">{children}</div>;
}

/** Bottom sheet over the current screen. `full` takes most of the height (files, long forms). */
export function Sheet({ onClose, children, full }: { onClose(): void; children: ReactNode; full?: boolean }) {
  const [closing, setClosing] = useState(false);
  const close = () => {
    setClosing(true);
    setTimeout(onClose, 160);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <div className={`mx-sheet-wrap ${closing ? "closing" : ""}`}>
      <div className="mx-dim" onClick={close} />
      <div className={`mx-sheet ${full ? "full" : ""}`} role="dialog">
        <button className="mx-grab" onClick={close} aria-label="Close" />
        <SheetClose.Provider value={close}>{children}</SheetClose.Provider>
      </div>
    </div>
  );
}
export const SheetClose = createContext<() => void>(() => {});
export const useSheetClose = () => useContext(SheetClose);

export function KV({ rows }: { rows: Array<[ReactNode, ReactNode] | false | null | undefined | "" | 0> }) {
  return (
    <div className="mx-kv">
      {rows.filter(Boolean).map((r, i) => (
        <div key={i}>
          <span>{(r as [ReactNode, ReactNode])[0]}</span>
          <span>{(r as [ReactNode, ReactNode])[1]}</span>
        </div>
      ))}
    </div>
  );
}

export function Actions({ items }: { items: Array<{ label: ReactNode; onClick(): void; danger?: boolean; hint?: ReactNode } | false | null | undefined | "" | 0> }) {
  return (
    <div className="mx-actions">
      {items.filter(Boolean).map((it, i) => {
        const x = it as { label: ReactNode; onClick(): void; danger?: boolean; hint?: ReactNode };
        return (
          <button key={i} className={x.danger ? "danger" : ""} onClick={x.onClick}>
            {x.label}
            {x.hint && <span>{x.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

export type Tab = "chats" | "board" | "cloud" | "tasks" | "mail" | "cal";
export const TABS: Array<[Tab, LucideIcon, string]> = [
  ["chats", MessagesSquare, "Chats"],
  ["board", LayoutDashboard, "Board"],
  ["cloud", Cloud, "Cloud"],
  ["tasks", ListTodo, "Tasks"],
  ["mail", Mail, "Mail"],
  ["cal", CalendarDays, "Cal"],
];

export function TabBar({ tab, onTab, badges, tabs }: { tab: Tab; onTab(t: Tab): void; badges: Partial<Record<Tab, number>>; tabs: Tab[] }) {
  return (
    <nav className="mx-tabbar" style={{ gridTemplateColumns: `repeat(${num(tabs.length)}, 1fr)` }}>
      {TABS.filter(([t]) => tabs.includes(t)).map(([t, Icon, label]) => (
        <button key={t} className={t === tab ? "on" : ""} onClick={() => onTab(t)}>
          <Icon size={22} strokeWidth={t === tab ? 2.2 : 1.8} />
          {label}
          {!!badges[t] && <span className={`mx-badge ${t === "chats" ? "hot" : ""}`}>{badges[t]}</span>}
        </button>
      ))}
    </nav>
  );
}
