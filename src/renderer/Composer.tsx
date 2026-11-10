import { useEffect, useMemo, useRef, useState } from "react";
import { useDraft } from "./drafts";
import { openLightbox } from "./Lightbox";
import type { ClaudePermissionMode, CodexSandbox, CursorMode, Engine } from "../shared/types";
import { hub } from "./App";
import {
  codexModelName,
  effortLabel,
  effortMenuItems,
  modelMenuItems,
  permissionMenuItems,
  sandboxMenuItems,
  sandboxShort,
  useCodexModels,
  cursorModelItems,
  cursorModeItems,
  cursorModeShort,
  useCursorModels,
} from "./controlMenus";
import { useMenu } from "./Menu";
import { modelShort, permissionShort } from "./models";
import { baseName, fileUrl, isImagePath, usePane } from "./pane";

export interface SlashCommand {
  name: string;
  args?: string;
  help: string;
  run(arg: string): void;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/** Compact one-row composer: › prompt, attachments, model/mode chips, send/stop, and / commands. */
export function Composer(props: {
  onSend(text: string, images?: string[], files?: string[]): void;
  placeholder: string;
  engine: Engine;
  model?: string | null;
  onModel(model: string | null): void;
  permissionMode?: ClaudePermissionMode;
  onPermission?(mode: ClaudePermissionMode): void;
  effort?: string | null;
  onEffort?(effort: string | null): void;
  sandbox?: CodexSandbox;
  onSandbox?(mode: CodexSandbox): void;
  cursorMode?: CursorMode;
  onCursorMode?(mode: CursorMode): void;
  busy?: boolean;
  onInterrupt?(): void;
  cwd: string;
  dropZone?: React.RefObject<HTMLElement | null>;
  commands?: SlashCommand[];
  /** Keys typed into an empty composer (used for permission shortcuts). Return true if handled. */
  onEmptyKey?(key: string): boolean;
  /** Keeps unsent text and attachments when you leave and come back (e.g. the session id). */
  draftKey?: string;
}) {
  const [draft, setDraft] = useDraft<string>(props.draftKey, "");
  const [images, setImages] = useDraft<string[]>(props.draftKey && `${props.draftKey}:images`, []);
  const [files, setFiles] = useDraft<string[]>(props.draftKey && `${props.draftKey}:files`, []);
  const [slashIdx, setSlashIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menu = useMenu();
  const pane = usePane();
  const codex = useCodexModels();
  const cursor = useCursorModels();

  useEffect(() => inputRef.current?.focus(), []);

  // Auto-grow.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [draft]);

  const addPaths = (paths: string[]) => {
    const imgs = paths.filter(isImagePath);
    const other = paths.filter((p) => !isImagePath(p));
    if (imgs.length) setImages((a) => [...new Set([...a, ...imgs])]);
    if (other.length) setFiles((a) => [...new Set([...a, ...other])]);
    inputRef.current?.focus();
  };

  const addImageBlob = async (blob: Blob) => {
    const path = await hub().saveAttachment(await readAsDataUrl(blob));
    setImages((a) => [...a, path]);
  };

  // Drag-and-drop anywhere on the drop zone.
  useEffect(() => {
    const el = props.dropZone?.current;
    if (!el) return;
    let depth = 0;
    const set = (on: boolean) => el.classList.toggle("drop-active", on);
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      depth++;
      set(true);
    };
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) set(false);
    };
    const drop = async (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      depth = 0;
      set(false);
      const paths: string[] = [];
      for (const f of Array.from(e.dataTransfer.files)) {
        const p = hub().pathForFile(f);
        if (p) paths.push(p);
        else if (f.type.startsWith("image/")) await addImageBlob(f);
      }
      addPaths(paths);
    };
    el.addEventListener("dragenter", enter);
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("dragenter", enter);
      el.removeEventListener("dragover", over);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", drop);
      set(false);
    };
  }, [props.dropZone]);

  // Slash command suggestions while the draft is "/word".
  const slash = useMemo(() => {
    const m = draft.match(/^\/(\S*)$/);
    if (!m || !props.commands) return null;
    return props.commands.filter((c) => c.name.startsWith(m[1].toLowerCase()));
  }, [draft, props.commands]);

  useEffect(() => setSlashIdx(0), [slash?.length]);

  const runCommand = (text: string): boolean => {
    const m = text.match(/^\/(\S+)\s*(.*)$/s);
    if (!m || !props.commands) return false;
    const cmd = props.commands.find((c) => c.name === m[1].toLowerCase());
    if (!cmd) return false;
    cmd.run(m[2].trim());
    return true;
  };

  const send = () => {
    const text = draft.trim();
    if (!text && !images.length && !files.length) return;
    if (text.startsWith("/") && !images.length && !files.length && runCommand(text)) {
      setDraft("");
      return;
    }
    props.onSend(text, images.length ? images : undefined, files.length ? files : undefined);
    setDraft("");
    setImages([]);
    setFiles([]);
  };

  const hasContent = !!draft.trim() || images.length > 0 || files.length > 0;

  return (
    <div className="composer">
      {slash && slash.length > 0 && (
        <div className="slash">
          {slash.map((c, i) => (
            <div
              key={c.name}
              className={`slash-item ${i === slashIdx ? "on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setDraft(`/${c.name}${c.args ? " " : ""}`);
                if (!c.args) {
                  c.run("");
                  setDraft("");
                }
              }}
            >
              <b>
                /{c.name}
                {c.args ? ` ${c.args}` : ""}
              </b>
              <span>{c.help}</span>
            </div>
          ))}
        </div>
      )}
      {/* Attach / model / mode sit above the box so they never crowd what you're typing. */}
      <div className="copts">
        <button className="opt m-hide-web" title="Attach files" onClick={async () => addPaths(await hub().pickFiles(props.cwd))}>
          ＋ file
        </button>
        <button
          className="opt"
          title="Model"
          onClick={(e) =>
            menu.above(
              e.currentTarget,
              props.engine === "cursor" ? cursorModelItems(cursor, props.model, props.onModel) : modelMenuItems(props.engine, props.model, props.onModel, codex),
            )
          }
        >
          {props.engine === "codex" ? codexModelName(codex, props.model) : props.engine === "cursor" ? (props.model ?? "auto") : modelShort(props.engine, props.model)}
        </button>
        {props.engine === "cursor" && props.onCursorMode && (
          <button
            className={`opt ${(props.cursorMode ?? "full") === "full" ? "warn" : ""}`}
            title="Cursor mode"
            onClick={(e) => menu.above(e.currentTarget, cursorModeItems(props.cursorMode, props.onCursorMode!))}
          >
            {cursorModeShort(props.cursorMode)}
          </button>
        )}
        {props.engine === "codex" && props.onEffort && (
          <button
            className="opt"
            title="Reasoning effort"
            onClick={(e) => menu.above(e.currentTarget, effortMenuItems(codex, props.model, props.effort, props.onEffort!))}
          >
            {effortLabel(codex, props.effort)}
          </button>
        )}
        {props.engine === "codex" && props.onSandbox && (
          <button
            className={`opt ${props.sandbox === "danger-full-access" ? "warn" : ""}`}
            title="Sandbox"
            onClick={(e) => menu.above(e.currentTarget, sandboxMenuItems(props.sandbox, props.onSandbox!))}
          >
            {sandboxShort(props.sandbox)}
          </button>
        )}
        {props.engine === "claude" && props.onPermission && (
          <button
            className={`opt ${props.permissionMode === "bypassPermissions" ? "warn" : ""}`}
            title="Permission mode"
            onClick={(e) => menu.above(e.currentTarget, permissionMenuItems(props.permissionMode, props.onPermission!))}
          >
            {permissionShort(props.permissionMode).toLowerCase()}
          </button>
        )}
      </div>
      <div className="cbox">
        {(images.length > 0 || files.length > 0) && (
          <div className="attachments">
            {images.map((p) => (
              <div key={p} className="attachment" title={baseName(p)}>
                <img src={fileUrl(p)} alt="" onClick={() => openLightbox(fileUrl(p))} />
                <button onClick={() => setImages((a) => a.filter((x) => x !== p))}>×</button>
              </div>
            ))}
            {files.map((p) => (
              <div key={p} className="file-chip" title={p}>
                <span onClick={() => pane.open({ kind: "file", path: p })}>{baseName(p)}</span>
                <button onClick={() => setFiles((a) => a.filter((x) => x !== p))}>×</button>
              </div>
            ))}
          </div>
        )}
        <div className="crow">
          <span className="prompt">›</span>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={props.placeholder}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith("image/"));
              if (!imgs.length) return;
              e.preventDefault();
              imgs.forEach((i) => {
                const f = i.getAsFile();
                if (f) void addImageBlob(f);
              });
            }}
            onKeyDown={(e) => {
              if (slash?.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIdx((i) => (i + (e.key === "ArrowDown" ? 1 : slash.length - 1)) % slash.length);
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !draft.includes(" "))) {
                  e.preventDefault();
                  const c = slash[slashIdx];
                  if (c.args) setDraft(`/${c.name} `);
                  else {
                    c.run("");
                    setDraft("");
                  }
                  return;
                }
              }
              if (!draft && !images.length && !files.length && props.onEmptyKey && !e.metaKey && !e.ctrlKey && props.onEmptyKey(e.key)) {
                e.preventDefault();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape" && props.busy) {
                props.onInterrupt?.();
              }
            }}
          />
          <div className="cbar">
            {props.busy && !hasContent ? (
              <button className="go stop" title="Stop (Esc)" onClick={props.onInterrupt}>
                ■ esc
              </button>
            ) : (
              <button className="go" title={props.busy ? "Queue message" : "Send"} onClick={send} disabled={!hasContent}>
                {props.busy ? "queue ↵" : "send ↵"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
