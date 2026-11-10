import { useEffect, useRef, useState } from "react";
import type { GcloudStatus } from "../shared/types";
import { hub } from "./App";

let shared: { status?: GcloudStatus; listeners: Set<(s: GcloudStatus) => void> } = { listeners: new Set() };
async function recheck() {
  const st = await hub().gcloudStatus();
  shared.status = st;
  shared.listeners.forEach((l) => l(st));
  return st;
}

/** Start a gcloud login from anywhere (e.g. the errors card); the chip shows progress. */
export function startGcloudLogin(kind: "user" | "adc") {
  window.dispatchEvent(new CustomEvent("gcloud-login", { detail: kind }));
}

/** Top-bar chip: gcloud login + application-default credential status, one-click re-auth with live output. */
export function GcloudChip() {
  const [st, setSt] = useState<GcloudStatus | undefined>(shared.status);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<"user" | "adc" | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    shared.listeners.add(setSt);
    if (!shared.status) void recheck();
    const t = setInterval(() => void recheck(), 10 * 60_000);
    const offLog = hub().onGcloudLog((line) => setLog((l) => [...l.slice(-60), line]));
    const onStart = (e: Event) => void login((e as CustomEvent<"user" | "adc">).detail);
    window.addEventListener("gcloud-login", onStart);
    return () => {
      shared.listeners.delete(setSt);
      clearInterval(t);
      offLog();
      window.removeEventListener("gcloud-login", onStart);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !running && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open, running]);

  async function login(kind: "user" | "adc") {
    setOpen(true);
    setRunning(kind);
    setLog([`$ gcloud auth ${kind === "adc" ? "application-default " : ""}login`, "a sign-in window will open…"]);
    const ok = await hub().gcloudLogin(kind);
    setLog((l) => [...l, ok ? "✓ done" : "✗ login didn't complete"]);
    setRunning(null);
    await recheck();
  }

  const tone = !st ? "unk" : !st.installed ? "bad" : st.userOk && st.adcOk ? "ok" : st.userOk || st.adcOk ? "part" : "bad";
  return (
    <div className="gc" ref={ref}>
      <button className="stat-btn gc-chip" onClick={() => setOpen(!open)} title="Google Cloud login">
        <span className={`gc-dot ${tone}`} />
        gcloud
      </button>
      {open && (
        <div className="gc-panel">
          {!st ? (
            <div className="muted small">checking…</div>
          ) : !st.installed ? (
            <div className="small">gcloud isn't installed or isn't on your PATH.</div>
          ) : (
            <>
              <div className="gc-row">
                <span className="muted">account</span>
                <span className="mono">{st.account ?? "not logged in"}</span>
              </div>
              <div className="gc-row">
                <span className={`gc-dot ${st.userOk ? "ok" : "bad"}`} />
                <span>gcloud CLI login</span>
                <span className="muted small">{st.userOk ? "valid" : "expired / missing"}</span>
                <button className="kb" disabled={!!running} onClick={() => void login("user")}>
                  {running === "user" ? "signing in…" : "log in"}
                </button>
              </div>
              <div className="gc-row">
                <span className={`gc-dot ${st.adcOk ? "ok" : "bad"}`} />
                <span>application default</span>
                <span className="muted small">{st.adcOk ? "valid" : "expired / missing"}</span>
                <button className="kb" disabled={!!running} onClick={() => void login("adc")}>
                  {running === "adc" ? "signing in…" : "log in"}
                </button>
              </div>
            </>
          )}
          {log.length > 0 && <pre className="gc-log">{log.join("\n")}</pre>}
          <div className="gc-foot">
            <span className="muted small">{st ? `checked ${new Date(st.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span>
            <button className="link-btn" onClick={() => void recheck()} disabled={!!running}>
              re-check
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
