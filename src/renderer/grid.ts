import { useEffect, useState } from "react";

/** The chats in the Chat grid, kept across page switches and restarts (edit or clear any time). */
const KEY = "happy.grid";
let ids: string[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
})();
const listeners = new Set<(ids: string[]) => void>();
const set = (next: string[]) => {
  ids = [...new Set(next)];
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {}
  listeners.forEach((l) => l(ids));
};

export const grid = {
  ids: () => ids,
  toggle: (id: string) => set(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]),
  add: (id: string) => set([...ids.filter((x) => x !== id), id]),
  /** Put `id` in slot `i` (if it was elsewhere in the grid, it moves). */
  replace: (i: number, id: string) => {
    const next = ids.filter((x) => x !== id);
    next.splice(Math.min(i, next.length), ids[i] && ids[i] !== id ? 1 : 0, id);
    set(next);
  },
  remove: (id: string) => set(ids.filter((x) => x !== id)),
  clear: () => set([]),
  set,
};

export function useGrid(): string[] {
  const [v, setV] = useState(ids);
  useEffect(() => {
    listeners.add(setV);
    return () => void listeners.delete(setV);
  }, []);
  return v;
}
