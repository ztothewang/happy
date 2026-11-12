import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | { type?: "item"; label: string; onSelect?: () => void; checked?: boolean; danger?: boolean; hint?: string; submenu?: MenuItem[]; /** Single-key shortcut while the menu is open. */ key?: string }
  | { type: "separator" }
  | { type: "header"; label: string }
  | { type: "input"; placeholder: string; onSubmit: (value: string) => void };

interface OpenMenu {
  items: MenuItem[];
  x: number;
  y: number;
  /** Open upward from y (for controls at the bottom of the window). */
  above?: boolean;
  /** Right-align to x (for controls at the right edge). */
  alignRight?: boolean;
}

type OpenFn = (m: OpenMenu) => void;
const MenuContext = createContext<OpenFn>(() => {});

/** Open a context menu at the mouse, or a dropdown anchored to an element. */
export function useMenu() {
  const open = useContext(MenuContext);
  return {
    atMouse: (e: React.MouseEvent, items: MenuItem[]) => {
      e.preventDefault();
      e.stopPropagation();
      open({ items, x: e.clientX, y: e.clientY });
    },
    at: (x: number, y: number, items: MenuItem[]) => open({ items, x, y }),
    below: (el: HTMLElement, items: MenuItem[], alignRight = false) => {
      const r = el.getBoundingClientRect();
      open({ items, x: alignRight ? r.right : r.left, y: r.bottom + 4, alignRight });
    },
    above: (el: HTMLElement, items: MenuItem[]) => {
      const r = el.getBoundingClientRect();
      open({ items, x: r.left, y: r.top - 4, above: true });
    },
  };
}

export function MenuProvider({ children }: { children: React.ReactNode }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const close = useCallback(() => setMenu(null), []);
  // The browser pane is a native view drawn over the page: it swaps itself for a snapshot while a menu is open.
  const open = !!menu;
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("happy:overlay", { detail: open }));
  }, [open]);
  return (
    <MenuContext.Provider value={setMenu}>
      {children}
      {menu && <MenuLayer menu={menu} onClose={close} />}
    </MenuContext.Provider>
  );
}

function MenuLayer({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.tagName === "INPUT") return;
      const hit = menu.items.find((it) => (!it.type || it.type === "item") && it.key && it.key.toLowerCase() === e.key.toLowerCase() && !it.submenu);
      if (hit && (!hit.type || hit.type === "item")) {
        e.preventDefault();
        onClose();
        hit.onSelect?.();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, menu.items]);
  return (
    <div className="menu-backdrop" onMouseDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())}>
      <MenuPanel items={menu.items} x={menu.x} y={menu.y} above={menu.above} alignRight={menu.alignRight} onClose={onClose} />
    </div>
  );
}

function MenuPanel(props: { items: MenuItem[]; x: number; y: number; above?: boolean; alignRight?: boolean; /** Submenus: the parent's left edge, to open on that side when there's no room on the right. */ flipX?: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y, ready: false });
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number } | null>(null);

  // Clamp into the viewport once we know our size.
  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    let left = props.alignRight ? props.x - width : props.x;
    if (props.flipX != null && left + width > window.innerWidth - 8) left = props.flipX - width + 2;
    let top = props.above ? props.y - height : props.y;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    setPos({ left, top, ready: true });
  }, [props.x, props.y, props.above, props.alignRight]);

  return (
    <>
      <div
        ref={ref}
        className="menu"
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {props.items.map((it, i) => {
          if (it.type === "separator") return <div key={i} className="menu-sep" />;
          if (it.type === "header") return <div key={i} className="menu-header">{it.label}</div>;
          if (it.type === "input")
            return (
              <input
                key={i}
                className="menu-input"
                placeholder={it.placeholder}
                autoFocus
                onMouseEnter={() => setSub(null)}
                onKeyDown={(e) => {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (e.key === "Enter" && v) {
                    it.onSubmit(v);
                    props.onClose();
                  }
                }}
              />
            );
          return (
            <button
              key={i}
              className={`menu-item ${it.danger ? "danger" : ""} ${sub?.index === i ? "open" : ""}`}
              onMouseEnter={(e) => {
                if (!it.submenu) return setSub(null);
                const r = e.currentTarget.getBoundingClientRect();
                setSub({ index: i, x: r.right - 2, y: r.top - 5, flipX: ref.current!.getBoundingClientRect().left });
              }}
              onClick={() => {
                if (it.submenu) return;
                it.onSelect?.();
                props.onClose();
              }}
            >
              <span className="menu-check">{it.checked ? "✓" : ""}</span>
              <span className="menu-label">{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
              {it.key && !it.hint && !it.submenu && <span className="menu-key">{it.key.toUpperCase()}</span>}
              {it.submenu && <span className="menu-arrow">›</span>}
            </button>
          );
        })}
      </div>
      {sub && (props.items[sub.index] as { submenu?: MenuItem[] }).submenu && (
        <MenuPanel
          key={sub.index}
          items={(props.items[sub.index] as { submenu: MenuItem[] }).submenu}
          x={sub.x}
          y={sub.y}
          flipX={sub.flipX}
          onClose={props.onClose}
        />
      )}
    </>
  );
}
