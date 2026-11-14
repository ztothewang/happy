import { useSyncExternalStore } from "react";
import { hub } from "./App";

/**
 * Browser recordings, app-wide (not tied to the pane being mounted): you or the agent start and stop them per chat.
 * A stopped recording becomes a draft that the editor opens for trimming, then saving or discarding.
 */
export interface RecordingDraft {
  sessionId: string;
  path: string;
  /** In-memory copy for playback (the file protocol can't stream video). */
  url: string;
  /** Who stopped it: the agent's drafts say so in the editor. */
  byAgent?: boolean;
}

interface Active {
  started: number;
  stop(byAgent?: boolean): void;
}

const active = new Map<string, Active>();
let drafts: RecordingDraft[] = [];
let version = 0;
const listeners = new Set<() => void>();
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Where errors go (App wires this to a toast). */
export let reportRecordingError: (msg: string) => void = (m) => console.warn(m);
export const setRecordingErrorHandler = (fn: (msg: string) => void) => (reportRecordingError = fn);

export async function startRecording(sessionId: string) {
  if (active.has(sessionId)) return;
  try {
    await hub().browserRecordStart(sessionId);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    const type = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const r = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    let byAgent = false;
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      active.delete(sessionId);
      changed();
      try {
        const blob = new Blob(chunks, { type: r.mimeType });
        const path = await hub().saveRecordingDraft(await blob.arrayBuffer(), r.mimeType.includes("mp4") ? "mp4" : "webm");
        drafts = [...drafts, { sessionId, path, url: URL.createObjectURL(blob), byAgent }];
        changed();
      } catch (e) {
        reportRecordingError(`Couldn't keep the recording: ${(e as Error).message}`);
      } finally {
        void hub().browserRecordStop(sessionId);
      }
    };
    // The page going away ends the stream, and with it the recording.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => r.state === "recording" && r.stop());
    r.start(1000);
    active.set(sessionId, {
      started: Date.now(),
      stop: (agent) => {
        byAgent = !!agent;
        if (r.state === "recording") r.stop();
      },
    });
    changed();
  } catch (e) {
    void hub().browserRecordStop(sessionId);
    reportRecordingError(`Couldn't start recording: ${(e as Error).message}`);
  }
}

export const stopRecording = (sessionId: string, byAgent?: boolean) => active.get(sessionId)?.stop(byAgent);

export function dropDraft(path: string) {
  drafts.filter((d) => d.path === path).forEach((d) => URL.revokeObjectURL(d.url));
  drafts = drafts.filter((d) => d.path !== path);
  changed();
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** Re-renders on any recording change. */
export function useRecordings() {
  useSyncExternalStore(subscribe, () => version);
  return {
    startedAt: (sessionId: string) => active.get(sessionId)?.started,
    drafts,
  };
}
