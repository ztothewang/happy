import { baseName } from "./pane";

/**
 * Codex writes app-specific markup into its replies (the Codex app renders it as cards and chips). We turn each into
 * Markdown/HTML before parsing. Seen in practice (Oct 2026 rollouts):
 *   :codex-file-citation{path purpose sheet range page_number}   file references (output / source)
 *   ::git-stage / ::git-commit / ::git-push / ::git-create-branch{cwd branch}   git actions it took
 *   ::code-comment{title body file start end priority confidence}   review findings
 *   ::inbox-item{title summary}   notifications
 *   :::writing{variant recipient subject cc} … :::   drafts (email)
 *   visualize{"path","title","mode"}   an HTML preview it made
 */

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

/** Attributes like key="quoted \"value\"" or key=123, in order. */
function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/(\w+)=(?:"((?:[^"\\]|\\.)*)"|([^\s}]+))/g)) out[m[1]] = (m[2] ?? m[3] ?? "").replace(/\\"/g, '"');
  return out;
}

/** Find `::name{…}` directives, honoring quotes (bodies can contain braces). */
function replaceDirectives(text: string, colons: string, fn: (name: string, attrs: Record<string, string>) => string | null): string {
  let out = "";
  let i = 0;
  const re = new RegExp(`(?<![\\w:])${colons}([a-z][\\w-]*)\\{`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let j = m.index + m[0].length;
    let quoted = false;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === "\\" && quoted) j++;
      else if (c === '"') quoted = !quoted;
      else if (c === "}" && !quoted) break;
    }
    if (j >= text.length) break;
    const raw = text.slice(m.index, j + 1);
    out += text.slice(i, m.index) + (fn(m[1], parseAttrs(text.slice(m.index + m[0].length, j))) ?? raw);
    i = j + 1;
    re.lastIndex = i;
  }
  return out + text.slice(i);
}

const inlineCode = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

function fileCitation(a: Record<string, string>): string {
  const path = a.path;
  if (!path || path.startsWith("<")) return "";
  const line = a.line_range_start;
  const where = a.sheet ? ` · ${a.sheet}${a.range ? `!${a.range}` : ""}` : a.page_number ? ` · p. ${a.page_number}` : line ? `:${line}` : "";
  return `<code class="path-link" data-path="${esc(line ? `${path}:${line}` : path)}" title="${esc(home(path))}">${esc(baseName(path))}${esc(where)}</code>`;
}

function gitAction(name: string, a: Record<string, string>): string {
  const what =
    name === "git-stage" ? "staged changes" : name === "git-commit" ? "committed" : name === "git-push" ? `pushed ${a.branch ?? ""}` : name === "git-create-branch" ? `created branch ${a.branch ?? ""}` : name.replace(/^git-/, "git ");
  return `<span class="cx-git" title="${esc(a.cwd ?? "")}">⎇ ${esc(what.trim())}${a.cwd ? ` <span class="cx-dim">· ${esc(baseName(a.cwd))}</span>` : ""}</span>`;
}

function codeComment(a: Record<string, string>): string {
  const prio = a.priority ?? a.title?.match(/^\[P(\d)\]/)?.[1];
  const title = (a.title ?? "").replace(/^\[P\d\]\s*/, "");
  const lines = a.start ? `:${a.start}${a.end && a.end !== a.start ? `–${a.end}` : ""}` : "";
  const file = a.file
    ? `<code class="path-link" data-path="${esc(a.start ? `${a.file}:${a.start}` : a.file)}" title="${esc(home(a.file))}">${esc(baseName(a.file))}${esc(lines)}</code>`
    : "";
  return `\n\n<div class="cx-card cx-review"><div class="cx-card-h">${prio ? `<span class="cx-prio p${esc(prio)}">P${esc(prio)}</span>` : ""}<b>${esc(title)}</b></div>${file ? `<div>${file}</div>` : ""}${a.body ? `<div class="cx-body">${inlineCode(a.body)}</div>` : ""}</div>\n\n`;
}

const inboxItem = (a: Record<string, string>) =>
  `\n\n<div class="cx-card cx-inbox"><b>${esc(a.title ?? "")}</b>${a.summary ? `<div class="cx-body">${inlineCode(a.summary)}</div>` : ""}</div>\n\n`;

/** `:::writing{…} body :::` as a quoted card with a header line. */
function blocks(text: string): string {
  return text.replace(/:::([a-z][\w-]*)\{([^}]*)\}\s*([\s\S]*?)\s*:::/g, (_m, kind: string, attrs: string) => {
    const body = _m.replace(/^:::[a-z][\w-]*\{[^}]*\}\s*/, "").replace(/\s*:::$/, "");
    const a = parseAttrs(attrs);
    const label = a.variant === "email" ? "Email draft" : a.variant || kind;
    const head = [`**${label}**`, a.recipient && `to ${a.recipient}`, a.cc && `cc ${a.cc}`, a.subject && `“${a.subject}”`].filter(Boolean).join(" · ");
    return `\n\n${[head, "", ...body.split("\n")].map((l) => `> ${l}`).join("\n")}\n\n`;
  });
}

/** `visualize{json}`: an HTML preview card that opens the file (rendered) in the pane. */
function visualizations(text: string): string {
  return text.replace(/([\w-]+)?([^]*)/g, (_m, name: string, json: string) => {
    let a: { path?: string; title?: string } = {};
    try {
      a = JSON.parse(json);
    } catch {}
    if (name !== "visualize" || !a.path) return "";
    return `\n\n<div class="cx-card cx-viz path-link" data-path="${esc(a.path)}" title="${esc(home(a.path))}"><b>${esc(a.title || baseName(a.path))}</b><span class="cx-dim">preview · open</span></div>\n\n`;
  });
}

export function codexMarkup(text: string): string {
  if (text.includes("")) text = visualizations(text);
  if (text.includes(":::")) text = blocks(text);
  if (text.includes("::"))
    text = replaceDirectives(text, "::", (name, a) =>
      name.startsWith("git-") ? gitAction(name, a) : name === "code-comment" ? codeComment(a) : name === "inbox-item" ? inboxItem(a) : name === "codex-file-citation" ? fileCitation(a) : null,
    );
  if (text.includes("codex-file-citation")) text = replaceDirectives(text, ":", (name, a) => (name === "codex-file-citation" ? fileCitation(a) : null));
  return text;
}
