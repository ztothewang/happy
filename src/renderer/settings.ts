import { useEffect, useState } from "react";
import type { AppSettings } from "../shared/types";
import { hub } from "./App";

let cached: AppSettings | null = null;
const listeners = new Set<(s: AppSettings) => void>();
let subscribed = false;

function ensure() {
  if (subscribed) return;
  subscribed = true;
  void hub()
    .settings()
    .then((s) => {
      cached = s;
      listeners.forEach((l) => l(s));
    });
  hub().onSettings((s) => {
    cached = s;
    listeners.forEach((l) => l(s));
  });
}

/** App settings, live (null until loaded). */
export function useSettings(): AppSettings | null {
  const [s, setS] = useState<AppSettings | null>(cached);
  useEffect(() => {
    ensure();
    listeners.add(setS);
    if (cached) setS(cached);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

/** The main repo new chats start in (Settings → Main repo). */
export const useRepo = (): string => useSettings()?.repo ?? "";
