import { useEffect, useRef, useState } from "react";

/**
 * Unsent text per chat, kept when you switch pages or chats (and across reloads for text). Memory first, then
 * localStorage so a window reload doesn't lose it either.
 */
const mem = new Map<string, unknown>();
const KEY = (k: string) => `happy.draft.${k}`;

export function useDraft<T extends string | string[]>(key: string | undefined, empty: T): [T, (v: T | ((prev: T) => T)) => void] {
  const read = (): T => {
    if (!key) return empty;
    if (mem.has(key)) return mem.get(key) as T;
    try {
      const raw = localStorage.getItem(KEY(key));
      if (raw != null) return JSON.parse(raw) as T;
    } catch {}
    return empty;
  };
  const [v, setV] = useState<T>(read);
  const cur = useRef(v);
  cur.current = v;
  const keyRef = useRef(key);
  // Switching to another chat in the same component: load that chat's draft.
  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      setV(read());
    }
  }, [key]);
  const set = (arg: T | ((prev: T) => T)) => {
    const next = typeof arg === "function" ? (arg as (prev: T) => T)(cur.current) : arg;
    cur.current = next;
    setV(next);
    if (!key) return;
    const isEmpty = Array.isArray(next) ? next.length === 0 : next === "";
    if (isEmpty) mem.delete(key);
    else mem.set(key, next);
    try {
      if (isEmpty) localStorage.removeItem(KEY(key));
      else localStorage.setItem(KEY(key), JSON.stringify(next));
    } catch {}
  };
  return [v, set];
}
