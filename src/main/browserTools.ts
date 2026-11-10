import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { BrowserManager } from "./browser.js";

type Result = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
type Shape = Record<string, z.ZodTypeAny>;

interface BrowserTool<S extends Shape = Shape> {
  name: string;
  description: string;
  shape: S;
  /** Read-only tools run without a permission prompt. */
  readOnly: boolean;
  run(ops: ReturnType<BrowserManager["agent"]>, args: z.infer<z.ZodObject<S>>): Promise<Result>;
}

const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });
const where = (ops: ReturnType<BrowserManager["agent"]>) => {
  const s = ops.state();
  return `Now at: ${s.title || "(untitled)"} — ${s.url}`;
};

function defineTool<S extends Shape>(t: BrowserTool<S>): BrowserTool {
  return t as unknown as BrowserTool;
}

export const BROWSER_TOOLS: BrowserTool[] = [
  defineTool({
    name: "navigate",
    description:
      "Open a URL in this session's browser (visible to the user in Happy's browser pane). Use for web research, docs, or testing a local dev server.",
    shape: { url: z.string().describe("URL, e.g. https://example.com or localhost:3000") },
    readOnly: true,
    async run(ops, a) {
      await ops.navigate(a.url);
      return text(where(ops));
    },
  }),
  defineTool({
    name: "back",
    description: "Go back in browser history.",
    shape: {},
    readOnly: true,
    async run(ops) {
      ops.back();
      await ops.waitForLoad();
      return text(where(ops));
    },
  }),
  defineTool({
    name: "read_page",
    description:
      "Read the current page: URL, title, visible text, and a numbered list of interactive elements. Use the [n] refs with click/type. Refs reset on every read_page and navigation.",
    shape: {},
    readOnly: true,
    async run(ops) {
      const p = await ops.readPage();
      return text(
        `URL: ${p.url}\nTitle: ${p.title}\nViewport: ${p.viewport.join("x")}, scrollY ${p.scrollY}/${p.pageHeight}\n\n` +
          `Interactive elements:\n${p.elements.join("\n") || "(none)"}\n\nPage text:\n${p.text}`,
      );
    },
  }),
  defineTool({
    name: "screenshot",
    description: "Screenshot the browser viewport. Image pixels = CSS pixels, so you can click at coordinates you see.",
    shape: {},
    readOnly: true,
    async run(ops) {
      const png = await ops.screenshot();
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, { type: "text", text: where(ops) }] };
    },
  }),
  defineTool({
    name: "scroll",
    description: "Scroll the page vertically by a number of pixels (negative = up).",
    shape: { dy: z.number().describe("Pixels to scroll; e.g. 600 down, -600 up") },
    readOnly: true,
    async run(ops, a) {
      await ops.scroll(a.dy);
      return text("scrolled");
    },
  }),
  defineTool({
    name: "console_logs",
    description: "Return the last 50 console messages from the page (useful for debugging a web app).",
    shape: {},
    readOnly: true,
    async run(ops) {
      const lines = ops.console();
      return text(lines.length ? lines.map((l) => `[${l.level}] ${l.text}`).join("\n") : "(no console output)");
    },
  }),
  defineTool({
    name: "click",
    description: "Click an element by its [ref] from read_page, or at x,y viewport coordinates from a screenshot.",
    shape: { ref: z.number().int().optional(), x: z.number().optional(), y: z.number().optional() },
    readOnly: false,
    async run(ops, a) {
      await ops.click(a);
      await new Promise((r) => setTimeout(r, 300));
      await ops.waitForLoad();
      return text(`clicked. ${where(ops)}`);
    },
  }),
  defineTool({
    name: "type",
    description: "Type text. If ref is given, clicks/focuses that element first; otherwise types into the focused element.",
    shape: { text: z.string(), ref: z.number().int().optional() },
    readOnly: false,
    async run(ops, a) {
      await ops.type(a.text, a.ref);
      return text("typed");
    },
  }),
  defineTool({
    name: "press_key",
    description: "Press a key: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, PageUp, PageDown.",
    shape: { key: z.string() },
    readOnly: false,
    async run(ops, a) {
      await ops.press(a.key);
      await new Promise((r) => setTimeout(r, 200));
      await ops.waitForLoad();
      return text(`pressed ${a.key}. ${where(ops)}`);
    },
  }),
  defineTool({
    name: "evaluate",
    description: "Run a JavaScript expression in the page and return its JSON-serializable result.",
    shape: { expression: z.string() },
    readOnly: false,
    async run(ops, a) {
      const v = await ops.evaluate(a.expression);
      return text(JSON.stringify(v, null, 2)?.slice(0, 20000) ?? "undefined");
    },
  }),
];

const READ_ONLY = new Set(BROWSER_TOOLS.filter((t) => t.readOnly).map((t) => t.name));

async function invoke(browsers: BrowserManager, sessionId: string, t: BrowserTool, args: any): Promise<Result> {
  try {
    return await t.run(browsers.agent(sessionId), args ?? {});
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
  }
}

/** In-process MCP server for a Claude session. Tool names surface as mcp__browser__<name>. */
export function claudeBrowserServer(browsers: BrowserManager, sessionId: string) {
  return createSdkMcpServer({
    name: "browser",
    version: "0.1.0",
    tools: BROWSER_TOOLS.map((t) => tool(t.name, t.description, t.shape, (a) => invoke(browsers, sessionId, t, a))),
  });
}

export const isReadOnlyBrowserTool = (claudeToolName: string) =>
  claudeToolName.startsWith("mcp__browser__") && READ_ONLY.has(claudeToolName.slice("mcp__browser__".length));

/**
 * Localhost streamable-HTTP MCP endpoint for Codex sessions: POST /mcp/<sessionId>
 * with `Authorization: Bearer <token>`. Stateless — a fresh server per request.
 */
export class BrowserMcpHttp {
  readonly token = randomBytes(24).toString("hex");
  private server?: Server;
  port = 0;

  /** Called by the gcloud BROWSER helper with a sign-in URL. */
  onOpenUrl?: (url: string) => void;

  constructor(private browsers: BrowserManager) {}

  async start() {
    this.server = createServer(async (req, res) => {
      if (req.url === "/open-url" && req.method === "POST") {
        if (req.headers.authorization !== `Bearer ${this.token}`) return void res.writeHead(401).end();
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const url = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("url");
        if (url && /^https:\/\//.test(url)) this.onOpenUrl?.(url);
        return void res.writeHead(204).end();
      }
      const m = req.url?.match(/^\/mcp\/([\w-]+)/);
      if (!m || req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(m ? 401 : 404).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const sessionId = m[1];
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const mcp = new McpServer({ name: "browser", version: "0.1.0" });
      for (const t of BROWSER_TOOLS)
        mcp.registerTool(t.name, { description: t.description, inputSchema: t.shape }, (a: any) => invoke(this.browsers, sessionId, t, a) as any);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  urlFor(sessionId: string) {
    return `http://127.0.0.1:${this.port}/mcp/${sessionId}`;
  }

  stop() {
    this.server?.close();
  }
}
