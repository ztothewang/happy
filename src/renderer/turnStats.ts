import { useSyncExternalStore } from "react";
import type { TranscriptItem, TurnStats } from "../shared/types";

/**
 * Which replies show their turn's stats (right-click a reply). Remembered across restarts, and shared by every view
 * of a chat, so two chats side by side in the grid can be compared.
 */
const KEY = "happy.turnStats";
interface Shown {
  items: string[];
  /** Chats that show stats on every reply. */
  chats: string[];
}
let shown: Shown = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "");
    return { items: v.items ?? [], chats: v.chats ?? [] };
  } catch {
    return { items: [], chats: [] };
  }
})();
const listeners = new Set<() => void>();
const set = (next: Shown) => {
  shown = { items: next.items.slice(-500), chats: next.chats };
  try {
    localStorage.setItem(KEY, JSON.stringify(shown));
  } catch {}
  listeners.forEach((l) => l());
};
const flip = (list: string[], id: string, on: boolean) => (on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id));

export const showItemStats = (itemId: string, on: boolean) => set({ ...shown, items: flip(shown.items, itemId, on) });
export const showChatStats = (sessionId: string, on: boolean) => set({ ...shown, chats: flip(shown.chats, sessionId, on) });

export function useShownStats() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => shown,
  );
}

/** A turn's stats as recorded; for replies from before stats were recorded, the time and tool calls from the transcript. */
export function turnStatsFor(items: TranscriptItem[], index: number): (TurnStats & { estimated?: boolean }) | undefined {
  let start = index;
  while (start > 0 && items[start - 1].kind !== "user") start--;
  let end = index;
  while (end + 1 < items.length && items[end + 1].kind !== "user") end++;
  const turn = items.slice(start, end + 1);
  const recorded = turn.find((i) => i.stats)?.stats;
  if (recorded) return recorded;
  const asked = items[start - 1];
  const last = turn[turn.length - 1];
  if (!asked || !last) return undefined;
  return { ms: Math.max(0, last.ts - asked.ts), tools: turn.filter((i) => i.kind === "tool").length, tokens: 0, costUsd: 0, estimated: true };
}
