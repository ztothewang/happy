import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteItem {
  id: string;
  kind: string; // "session", "action", …
  label: string;
  hint?: string;
  run(): void;
}

/** ⌘K command palette: fuzzy-ish subsequence match over sessions and actions. */
export function Palette({ items, onClose }: { items: PaletteItem[]; onClose(): void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return items.slice(0, 60);
    const score = (s: string) => {
      const t = s.toLowerCase();
      if (t.includes(query)) return 100 - t.indexOf(query);
      let i = 0;
      for (const ch of t) if (ch === query[i]) i++;
      return i === query.length ? 10 : -1;
    };
    return items
      .map((it) => ({ it, s: Math.max(score(it.label), score(`${it.kind} ${it.label}`) - 5) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.it);
  }, [q, items]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.on")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const run = (it?: PaletteItem) => {
    if (!it) return;
    onClose();
    it.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          placeholder="search sessions and commands"
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") run(results[idx]);
          }}
        />
        <div className="palette-list" ref={listRef}>
          {results.map((it, i) => (
            <div key={it.id} className={`palette-item ${i === idx ? "on" : ""}`} onMouseEnter={() => setIdx(i)} onClick={() => run(it)}>
              <span className="pi-kind">{it.kind}</span>
              <span className="pi-label">{it.label}</span>
              {it.hint && <span className="pi-hint">{it.hint}</span>}
            </div>
          ))}
          {results.length === 0 && <div className="palette-empty">no matches</div>}
        </div>
      </div>
    </div>
  );
}
