/**
 * Chats on screen outside their own page: cards visible in the chat grid and the chat open on the Chat wall.
 * They count as looked at, like the selected chat: no "done" mark while you watch, and a mark clears when one comes into view.
 */
const shown = new Map<string, number>();

const seen = (id: string) => document.hasFocus() && window.dispatchEvent(new CustomEvent("happy:seen", { detail: id }));

export const viewing = {
  has: (id: string) => (shown.get(id) ?? 0) > 0,
  /** Returns the matching remove. */
  add(id: string) {
    shown.set(id, (shown.get(id) ?? 0) + 1);
    seen(id);
    return () => {
      const n = (shown.get(id) ?? 1) - 1;
      if (n > 0) shown.set(id, n);
      else shown.delete(id);
    };
  },
};

// Coming back to the window counts as looking at whatever is on screen.
window.addEventListener("focus", () => shown.forEach((_, id) => seen(id)));
