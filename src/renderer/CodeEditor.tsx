import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { useEffect, useRef, useState } from "react";
import { hub } from "./App";
import { diffLines, withContext } from "./diff";
import { useToast } from "./toast";

function language(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"].includes(ext)) return [javascript({ typescript: /^[mc]?tsx?$/.test(ext), jsx: ext.endsWith("x") })];
  if (ext === "py") return [python()];
  if (ext === "json" || ext === "jsonl") return [json()];
  if (["css", "scss", "less"].includes(ext)) return [css()];
  if (["html", "htm", "vue", "svelte"].includes(ext)) return [html()];
  if (["md", "markdown", "mdx"].includes(ext)) return [markdown()];
  if (ext === "sql") return [sql()];
  if (["yml", "yaml"].includes(ext)) return [yaml()];
  return [];
}

/** Colors from the app theme, so the editor matches light and dark. */
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: "var(--fm)", lineHeight: "1.55" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--dim2)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--hl-bg) !important" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused": { outline: "none" },
  ".cm-panels": { backgroundColor: "var(--raise)", color: "var(--fg)" },
});

const NOTIFY_KEY = "happy.edit.notify";

/** What changed, as a short unified diff for the agent (capped so a big edit doesn't flood the chat). */
function changeNote(rel: string, before: string, after: string): string | undefined {
  const ops = diffLines(before, after);
  const added = ops.filter((o) => o.type === "add").length;
  const removed = ops.filter((o) => o.type === "del").length;
  if (!added && !removed) return undefined;
  const lines = withContext(ops, 2).map((o) => (o.type === "gap" ? "…" : `${o.type === "add" ? "+" : o.type === "del" ? "-" : " "}${o.text}`));
  const body = lines.length > 120 ? [...lines.slice(0, 120), `… (${lines.length - 120} more lines)`] : lines;
  return `I edited \`${rel}\` myself (+${added} −${removed}). Take this into account and don't overwrite it:\n\n\`\`\`diff\n${body.join("\n")}\n\`\`\``;
}

/** A real editor for one file in the side panel: ⌘S saves; saving can tell the chat's agent what you changed. */
export function CodeEditor({ path, rel, initial, sessionId, onSaved }: { path: string; rel: string; initial: string; sessionId?: string; onSaved(text: string): void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notify, setNotify] = useState(() => {
    try {
      return localStorage.getItem(NOTIFY_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const toast = useToast();

  const save = async () => {
    const v = view.current;
    if (!v || !sessionId) return;
    const text = v.state.doc.toString();
    if (text === saved.current) return;
    setBusy(true);
    try {
      await hub().writeFile(sessionId, path, text);
      const note = notifyRef.current ? changeNote(rel, saved.current, text) : undefined;
      saved.current = text;
      setDirty(false);
      onSaved(text);
      if (note) void hub().send(sessionId, note);
      toast(note ? `Saved ${rel} · told the agent` : `Saved ${rel}`);
    } catch (e) {
      toast(`Couldn't save: ${String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
    }
    setBusy(false);
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          ...language(path),
          theme,
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (void saveRef.current(), true) }]),
          EditorView.updateListener.of((u) => u.docChanged && setDirty(u.state.doc.toString() !== saved.current)),
        ],
      }),
    });
    view.current = v;
    v.focus();
    return () => v.destroy();
  }, [path]);

  return (
    <div className="code-editor">
      <div className="ce-bar">
        <span className={dirty ? "ce-dirty" : "muted"}>{dirty ? "● unsaved" : "saved"}</span>
        <label className="ce-notify" title="When you save, send the agent a short note with what you changed">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => {
              setNotify(e.target.checked);
              try {
                localStorage.setItem(NOTIFY_KEY, e.target.checked ? "1" : "0");
              } catch {}
            }}
          />{" "}
          tell the agent
        </label>
        <button className="kb" disabled={!dirty || busy || !sessionId} onClick={() => void save()}>
          {busy ? "saving…" : "save ⌘S"}
        </button>
      </div>
      <div className="ce-host" ref={host} />
    </div>
  );
}
