import { useEffect, useState } from "react";
import type { AutoState } from "../shared/types";
import { hub } from "./App";

/** The Auto pipeline's state, shared by the Auto page and the session menus. */
let state: AutoState = { items: [], autoMerge: false, autoDeploy: false, paused: false };
const listeners = new Set<(a: AutoState) => void>();
let started = false;
const start = () => {
  if (started) return;
  started = true;
  void hub()
    .autoState()
    .then((a) => ((state = a), listeners.forEach((l) => l(a))));
  hub().onAuto((a) => ((state = a), listeners.forEach((l) => l(a))));
};

export function useAuto(): AutoState {
  const [v, setV] = useState(state);
  useEffect(() => {
    start();
    listeners.add(setV);
    setV(state);
    return () => void listeners.delete(setV);
  }, []);
  return v;
}

export const autoHas = (id: string) => state.items.some((i) => i.sessionId === id);
