import { useState } from "react";
import { makeApi } from "../shared/api";
import type { HubApi } from "../shared/types";

/** True when running in a phone browser (served by Happy's remote server) instead of the desktop window. */
export const isWeb = typeof window !== "undefined" && !(window as { hub?: HubApi }).hub;

type Pending = { resolve(v: unknown): void; reject(e: Error): void };

/**
 * The phone's transport: the same API as the desktop window, carried over a WebSocket to the laptop. Reconnects on
 * its own (phones drop connections when locked); calls made while disconnected wait for the connection.
 */
export function createRemoteHub(onUnpaired: () => void, onConnection: (up: boolean) => void): HubApi {
  let ws: WebSocket | null = null;
  let seq = 0;
  let backoff = 500;
  const pending = new Map<number, Pending>();
  const queue: string[] = [];
  const listeners = new Map<string, Set<(v: unknown) => void>>();

  const connect = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      backoff = 500;
      onConnection(true);
      while (queue.length) ws!.send(queue.shift()!);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.ev) listeners.get(msg.ev)?.forEach((l) => l(msg.payload));
      else if (pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
      }
    };
    ws.onclose = (e) => {
      onConnection(false);
      if (e.code === 4401) return onUnpaired();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };
  };
  connect();
  // Coming back from the lock screen: reconnect right away instead of waiting out the backoff.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ws && ws.readyState > 1) connect();
  });

  const invoke = (ch: string, ...args: unknown[]) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      const data = JSON.stringify({ id, ch, args });
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      else queue.push(data);
    });
  const listen = <T,>(ch: string, cb: (v: T) => void) => {
    if (!listeners.has(ch)) listeners.set(ch, new Set());
    const set = listeners.get(ch)!;
    const f = cb as (v: unknown) => void;
    set.add(f);
    return () => void set.delete(f);
  };
  const api = makeApi(invoke, listen, { pathForFile: () => "" });
  return { ...api, isRemote: true };
}

/** First visit from a phone: enter the 6-digit code shown in Happy → Settings on the laptop. */
export function PairScreen() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: navigator.userAgent.includes("iPhone") ? "iPhone" : navigator.platform || "phone" }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      location.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="pair">
      <img src="./icon-192.png" alt="" width={72} height={72} />
      <h1>Connect to Happy</h1>
      <p>On your laptop, open Happy → Settings → Phone access and enter the 6-digit code shown there.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input id="pair-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
        <button className="tk-go" type="submit" disabled={busy || code.length !== 6}>
          {busy ? "connecting…" : "connect"}
        </button>
      </form>
      {err && <div className="tk-err">{err}</div>}
    </div>
  );
}

/** Ask for notification permission and register this phone for pushes (works when added to the home screen). */
export async function enablePush(): Promise<string> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "On iPhone, add Happy to your Home Screen first (Share → Add to Home Screen), then open it from there.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notifications are blocked for Happy in your phone's settings.";
  const reg = await navigator.serviceWorker.register("./sw.js");
  const { key } = await (await fetch("/api/push/key")).json();
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
  const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
  return r.ok ? "Notifications on. You'll get a ping when a session finishes or needs you." : "Couldn't register for notifications.";
}
