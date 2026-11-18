import { Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hub } from "./App";
import { dropDraft, type RecordingDraft } from "./recorder";
import { useToast } from "./toast";

const fmt = (t: number) => {
  if (!Number.isFinite(t)) return "0:00.0";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

/** A stopped recording: watch it, trim the start and end, then save it to ~/Movies/Happy or discard it. */
export function RecordingEditor({ draft, title }: { draft: RecordingDraft; title?: string }) {
  const toast = useToast();
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(0);
  const [t, setT] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [name, setName] = useState("");

  // The native browser view would cover this dialog: have it show a picture of itself meanwhile.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("happy:overlay", { detail: true }));
    return () => void window.dispatchEvent(new CustomEvent("happy:overlay", { detail: false }));
  }, []);

  // MediaRecorder files often report an unknown (Infinity) duration until you seek past the end once.
  const onMeta = () => {
    const v = video.current!;
    const ready = (d: number) => {
      setDur(d);
      setRange([0, d]);
      v.currentTime = 0;
    };
    if (Number.isFinite(v.duration) && v.duration > 0) return ready(v.duration);
    const fix = () => {
      v.removeEventListener("timeupdate", fix);
      ready(v.duration);
    };
    v.addEventListener("timeupdate", fix);
    v.currentTime = 1e7;
  };

  // Playback stays inside the kept range.
  const onTime = () => {
    const v = video.current!;
    setT(v.currentTime);
    if (dur && v.currentTime >= range[1] - 0.02 && !v.paused) {
      v.pause();
      v.currentTime = range[1];
    }
  };

  // Move the playhead every frame while playing (timeupdate only fires a few times a second).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const step = () => {
      const v = video.current;
      if (v) {
        setT(v.currentTime);
        if (dur && v.currentTime >= range[1] - 0.02) {
          v.pause();
          v.currentTime = range[1];
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, dur, range]);

  const toggle = () => {
    const v = video.current!;
    if (v.paused) {
      if (v.currentTime >= range[1] - 0.05 || v.currentTime < range[0]) v.currentTime = range[0];
      void v.play();
    } else v.pause();
  };

  const seek = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    const at = Math.min(Math.max(0, (x - r.left) / r.width), 1) * dur;
    const v = video.current!;
    v.pause();
    v.currentTime = at; // shows that exact frame
    setT(at);
    return at;
  };

  const drag = (which: 0 | 1 | "head") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev: PointerEvent) => {
      const at = seek(ev.clientX);
      if (which === "head") return;
      setRange(([a, b]) => (which === 0 ? [Math.min(at, b - 0.2), b] : [a, Math.max(at, a + 0.2)]));
    };
    move(e.nativeEvent);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const trimmed = dur > 0 && (range[0] > 0.05 || range[1] < dur - 0.05);

  const save = async () => {
    setBusy(true);
    try {
      const path = await hub().finishRecording(draft.path, trimmed ? range[0] : undefined, trimmed ? range[1] - range[0] : undefined, name.trim() || undefined);
      dropDraft(draft.path);
      toast(`Saved “${path.split("/").pop()}” to Movies › Happy`, { label: "Show in Finder", run: () => void hub().revealFile(path) });
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!confirmDiscard) return setConfirmDiscard(true);
    await hub().discardRecording(draft.path);
    dropDraft(draft.path);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea")) return;
      if (e.key === " ") (e.preventDefault(), toggle());
      if (e.key === "i") setRange(([, b]) => [Math.min(video.current!.currentTime, b - 0.2), b]);
      if (e.key === "o") setRange(([a]) => [a, Math.max(video.current!.currentTime, a + 0.2)]);
      if (e.key === "Escape") setConfirmDiscard(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pct = (x: number) => `${dur ? (x / dur) * 100 : 0}%`;
  return (
    <div className="peek-backdrop rec-ed-back">
      <div className="rec-ed">
        <div className="rec-ed-head">
          <div className="rec-ed-names">
            <input
              className="rec-ed-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy && dur) void save();
                if (e.key === "Escape") (e.target as HTMLInputElement).blur();
              }}
              placeholder="Name this video"
              spellCheck={false}
              autoFocus
            />
            <div className="rec-ed-sub">
              {draft.byAgent ? "Recorded by the agent" : "Browser recording"}
              {title ? ` · ${title}` : ""}
            </div>
          </div>
          <button className="re-icon" onClick={discard} title="Discard">
            <X size={15} />
          </button>
        </div>
        <video ref={video} className="rec-ed-video" src={draft.url} onLoadedMetadata={onMeta} onTimeUpdate={onTime} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onClick={toggle} />
        <div className="rec-ed-bar">
          <button className="re-play" onClick={toggle} title="Play / pause (space)" disabled={!dur}>
            {playing ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
          </button>
          <div className="rec-ed-track" ref={track} onPointerDown={drag("head")}>
            <div className="rec-ed-cut" style={{ left: 0, width: pct(range[0]) }} />
            <div className="rec-ed-cut" style={{ left: pct(range[1]), right: 0 }} />
            <div className="rec-ed-keep" style={{ left: pct(range[0]), width: pct(range[1] - range[0]) }} />
            <div className="rec-ed-handle" style={{ left: pct(range[0]) }} onPointerDown={drag(0)} title="Start (i sets it at the playhead)" />
            <div className="rec-ed-handle" style={{ left: pct(range[1]) }} onPointerDown={drag(1)} title="End (o sets it at the playhead)" />
            <div className="rec-ed-head-line" style={{ left: pct(t) }} />
          </div>
          <span className="rec-ed-time">
            {fmt(t)} <span>/ {fmt(dur)}</span>
          </span>
        </div>
        <div className="rec-ed-foot">
          <span className="rec-ed-hint">
            {trimmed ? `Keeping ${fmt(range[1] - range[0])} · ${fmt(range[0])} to ${fmt(range[1])}` : "Drag the ends of the timeline to trim. I and O set them at the playhead."}
          </span>
          <span className="rec-ed-acts">
            {trimmed && (
              <button className="re-btn ghost" onClick={() => setRange([0, dur])} disabled={busy}>
                Reset
              </button>
            )}
            <button className={`re-btn ${confirmDiscard ? "danger" : "ghost"}`} onClick={discard} disabled={busy}>
              {confirmDiscard ? "Discard for good?" : "Discard"}
            </button>
            <button className="re-btn primary" onClick={save} disabled={busy || !dur}>
              {busy ? "Saving…" : trimmed ? "Save trimmed" : "Save"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
