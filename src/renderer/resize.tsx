import { useState } from "react";

/** A panel width remembered per key. */
export function usePanelWidth(key: string, initial: number): [number, (w: number) => void] {
  const [w, setW] = useState(() => {
    try {
      const v = Number(localStorage.getItem(`happy.width.${key}`));
      return v > 0 ? v : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: number) => {
    setW(v);
    try {
      localStorage.setItem(`happy.width.${key}`, String(Math.round(v)));
    } catch {}
  };
  return [w, set];
}

/**
 * Drag handle between two panes. `side` is where the resized panel sits relative to the handle
 * ("right": panel is to the right, dragging left widens it). Double-click resets.
 */
export function ResizeHandle({ width, onWidth, side, min = 240, max = 900, reset }: { width: number; onWidth(w: number): void; side: "left" | "right"; min?: number; max?: number; reset?: number }) {
  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - x0;
      onWidth(Math.max(min, Math.min(max, side === "right" ? w0 - dx : w0 + dx)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return <div className="resizer" onMouseDown={start} onDoubleClick={() => reset && onWidth(reset)} title="Drag to resize · double-click to reset" />;
}
