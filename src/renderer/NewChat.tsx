import { useEffect, useRef, useState } from "react";
import { useRepo, useSettings } from "./settings";
import type { ClaudePermissionMode, CodexSandbox, CursorMode, Engine, SessionState } from "../shared/types";
import { hub } from "./App";
import { Composer } from "./Composer";

/** Default working directory for new chats. */
const ENGINE_KEY = "session-hub:last-engine";
const WORKTREE_KEY = "session-hub:worktree";

export function NewChat({ onCreated, dropZone }: { onCreated(s: SessionState): void; dropZone: React.RefObject<HTMLElement | null> }) {
  const repo = useRepo();
  const [engine, setEngine] = useState<Engine>(() => {
    try {
      return (localStorage.getItem(ENGINE_KEY) as Engine) || "claude";
    } catch {
      return "claude";
    }
  });
  const [error, setError] = useState("");
  const [models, setModels] = useState<Record<Engine, string | null>>({ claude: null, codex: null, cursor: null });
  const [permission, setPermission] = useState<ClaudePermissionMode>("bypassPermissions");
  const [effort, setEffort] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState<CodexSandbox>("danger-full-access");
  const [cursorMode, setCursorMode] = useState<CursorMode>("full");
  const [worktree, setWorktree] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WORKTREE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [creating, setCreating] = useState(false);
  // Start from Settings (default provider, its model, max permissions) until you change something here.
  const st = useSettings();
  const touched = useRef(false);
  useEffect(() => {
    if (!st || touched.current) return;
    setEngine(st.defaultEngine);
    setModels({ claude: st.models.claude ?? null, codex: st.models.codex ?? null, cursor: st.models.cursor ?? null });
    setPermission(st.bypass.sessions ? "bypassPermissions" : "default");
    setSandbox(st.bypass.sessions ? "danger-full-access" : "workspace-write");
    setCursorMode(st.bypass.sessions ? "full" : "default");
  }, [st]);

  const pick = (e: Engine) => {
    touched.current = true;
    setEngine(e);
    try {
      localStorage.setItem(ENGINE_KEY, e);
    } catch {}
  };

  const toggleWorktree = () => {
    setWorktree((w) => {
      try {
        localStorage.setItem(WORKTREE_KEY, w ? "0" : "1");
      } catch {}
      return !w;
    });
  };

  const start = async (text: string, images?: string[], files?: string[]) => {
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      const firstLine = text.split("\n")[0].trim();
      const title = firstLine ? (firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine) : "Attachment";
      onCreated(
        await hub().create({
          engine,
          cwd: repo,
          title,
          prompt: text,
          images,
          files,
          model: models[engine] ?? undefined,
          permissionMode: engine === "claude" ? permission : undefined,
          effort: engine === "codex" ? (effort ?? undefined) : undefined,
          codexSandbox: engine === "codex" ? sandbox : undefined,
          cursorMode: engine === "cursor" ? cursorMode : undefined,
          worktree,
        }),
      );
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      setCreating(false);
    }
  };

  return (
    <>
      <div className="newchat">
        <div className="seg">
          <button className={engine === "claude" ? "on" : ""} onClick={() => pick("claude")}>
            claude
          </button>
          <button className={engine === "codex" ? "on" : ""} onClick={() => pick("codex")}>
            codex
          </button>
          <button className={engine === "cursor" ? "on" : ""} onClick={() => pick("cursor")}>
            cursor
          </button>
        </div>
        <button className={`wt-toggle ${worktree ? "on" : ""}`} onClick={toggleWorktree} title="Give this session its own git branch and worktree">
          <span className="wt-box">{worktree ? "✓" : ""}</span> own branch + worktree
        </button>
        <div className="newchat-hint">
          {creating
            ? "starting…"
            : worktree
              ? "the worktree is named for your task and set up in the background · turn off for read-only questions"
              : "runs in the main checkout"}
        </div>
        {error && (
          <div className="newchat-hint" style={{ color: "var(--bad)" }}>
            {error}
          </div>
        )}
      </div>
      <Composer
        key={engine}
        draftKey="new-chat"
        engine={engine}
        model={models[engine]}
        onModel={(m) => setModels((all) => ({ ...all, [engine]: m }))}
        permissionMode={permission}
        onPermission={setPermission}
        effort={effort}
        onEffort={setEffort}
        sandbox={sandbox}
        onSandbox={setSandbox}
        cursorMode={cursorMode}
        onCursorMode={setCursorMode}
        cwd={repo}
        dropZone={dropZone}
        onSend={start}
        placeholder={`message ${engine}`}
      />
    </>
  );
}
