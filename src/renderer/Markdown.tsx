import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { memo, useMemo } from "react";
import { codexMarkup } from "./codexMarkup";
import { fileUrl, looksLikePath, usePane } from "./pane";
import { openLightbox } from "./Lightbox";
import { useLinkMenu } from "./linkMenu";

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      const html = language ? hljs.highlight(text, { language }).value : escapeHtml(text);
      // Shell blocks get a Run button: the command runs in the chat's terminal and its output goes back to the agent.
      const shell = /^(sh|bash|zsh|shell|console|terminal)$/i.test(lang ?? "");
      const cmd = shell ? text.replace(/^\$ /gm, "").trim() : "";
      const run = cmd ? `<button class="run-cmd" data-cmd="${escapeHtml(cmd)}" title="Run in this chat's terminal; the output goes back to the agent">▶ Run</button>` : "";
      return `<pre class="code">${run}<code class="hljs">${html}</code></pre>`;
    },
    image({ href, text }) {
      // Local files (Codex shows its outputs this way) load through Happy's file route; videos get a player.
      const local = /^(\/|~\/|file:\/\/)/.test(href);
      const src = local ? fileUrl(href.replace(/^file:\/\//, "").replace(/^~\//, "/Users/")) : href;
      if (/\.(mp4|mov|webm|m4v)$/i.test(href)) return `<video class="md-video" controls preload="metadata" src="${escapeHtml(src)}"></video>`;
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text ?? "")}" />`;
    },
    codespan({ text }) {
      // marked passes escaped text; un-escape to test, keep escaped for output.
      const raw = unescapeHtml(text);
      return looksLikePath(raw)
        ? `<code class="path-link" data-path="${text}">${text}</code>`
        : `<code>${text}</code>`;
    },
  },
});

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function unescapeHtml(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** Real HTML tags replies use on purpose; anything else in angle brackets is a placeholder. */
const HTML_TAGS = new Set("a b i u s em strong small mark sup sub kbd code pre br hr p div span img video table thead tbody tfoot tr td th ul ol li details summary blockquote h1 h2 h3 h4 h5 h6 del ins abbr".split(" "));

/**
 * Agents write placeholders like <uuid>, <tenant> or <memo uuid> in prose; as raw HTML they'd be stripped (vanish).
 * Escape any angle-bracket "tag" that isn't real HTML, outside code spans and fences.
 */
function keepPlaceholders(text: string): string {
  if (!text.includes("<")) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/<(\/?)([a-zA-Z][\w-]*)([^<>]*)>/g, (m, _slash, name: string) => (HTML_TAGS.has(name.toLowerCase()) ? m : m.replace(/</g, "&lt;").replace(/>/g, "&gt;")))))
    .join("");
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const linkMenu = useLinkMenu();
  const pane = usePane();
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(keepPlaceholders(codexMarkup(text)), { async: false }) as string, { ADD_ATTR: ["data-path", "data-cmd", "title", "controls", "preload"], ADD_TAGS: ["video"], ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|hubfile):|\/hubfile\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i }),
    [text],
  );
  return (
    <div
      className={`md ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onContextMenu={(e) => {
        const href = (e.target as HTMLElement).closest("a")?.getAttribute("href");
        if (href) linkMenu(e, href);
      }}
      onClick={(e) => {
        const el = e.target as HTMLElement;
        const run = el.closest<HTMLElement>(".run-cmd");
        if (run?.dataset.cmd) return pane.runCommand?.(run.dataset.cmd);
        if (el instanceof HTMLImageElement && !el.closest("a")) return openLightbox(el.src);
        const a = el.closest("a");
        if (a) {
          e.preventDefault();
          const href = a.getAttribute("href");
          if (href) pane.openLink(href);
          return;
        }
        const p = el.closest<HTMLElement>(".path-link");
        if (p?.dataset.path) pane.openLink(unescapeHtml(p.dataset.path));
      }}
    />
  );
});

export function highlight(code: string, path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_LANG[ext] ?? (hljs.getLanguage(ext) ? ext : undefined);
  if (!lang || code.length > 400_000) return null;
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  html: "xml",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "makefile",
  lua: "lua",
  r: "r",
  pl: "perl",
  graphql: "graphql",
};
