import { settings } from "./settings.js";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import webpush from "web-push";
import { WebSocketServer, type WebSocket } from "ws";
import type { RemoteDevice, SessionState } from "../shared/types.js";

export const REMOTE_PORT = Number(process.env.SESSION_HUB_REMOTE_PORT) || 47821;

/** Channels the phone may not call: native dialogs, the laptop's window, the embedded browser view. */
const DENY = new Set(["hub:pickFolder", "hub:pickFile", "hub:pickFiles", "hub:revealFile", "app:setBadge", "app:attention", "gcloud:login"]);
const DENY_PREFIX = ["browser:"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

interface Stored {
  devices: Array<RemoteDevice & { tokenHash: string }>;
  vapid?: { publicKey: string; privateKey: string };
  subscriptions: Array<{ deviceId: string; sub: webpush.PushSubscription }>;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Happy over the network, for your phone: serves the same UI and bridges its calls to the main-process handlers over a
 * WebSocket. Listens on 127.0.0.1 only; `tailscale serve` publishes it to your tailnet over HTTPS. Every request needs a
 * paired-device cookie, and when Tailscale identifies the caller it must be the owner's login.
 */
export class RemoteServer {
  private server?: Server;
  private wss?: WebSocketServer;
  private file: string;
  private store: Stored = { devices: [], subscriptions: [] };
  private code?: { value: string; expires: number };
  private clients = new Set<WebSocket>();
  private lastStatus = new Map<string, string>();
  private offBroadcast?: () => void;

  constructor(
    dataDir: string,
    private opts: {
      handlers: Map<string, (...args: any[]) => unknown>;
      onBroadcast: (fn: (channel: string, payload: unknown) => void) => () => void;
      rendererDir: string;
      /** Tailscale login allowed to connect (from `tailscale status`), when known. */
      ownerLogin: () => string | undefined;
    },
  ) {
    this.file = join(dataDir, "remote.json");
    try {
      if (existsSync(this.file)) this.store = { devices: [], subscriptions: [], ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch {}
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.store), { mode: 0o600 });
  }

  get running() {
    return !!this.server;
  }

  devices(): RemoteDevice[] {
    return this.store.devices.map(({ tokenHash: _t, ...d }) => d);
  }

  /** A fresh 6-digit pairing code, valid for 10 minutes. */
  newCode() {
    this.code = { value: String(randomInt(0, 1_000_000)).padStart(6, "0"), expires: Date.now() + 10 * 60_000 };
    return this.code;
  }
  currentCode() {
    return this.code && this.code.expires > Date.now() ? this.code : undefined;
  }

  removeDevice(id: string) {
    this.store.devices = this.store.devices.filter((d) => d.id !== id);
    this.store.subscriptions = this.store.subscriptions.filter((s) => s.deviceId !== id);
    this.save();
    for (const ws of this.clients) if ((ws as any).deviceId === id) ws.close(4401, "unpaired");
  }

  // ── auth ─────────────────────────────────────────────────────
  private cookie(req: IncomingMessage, name: string) {
    const m = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : undefined;
  }

  /** The paired device for this request, or undefined. Also enforces the Tailscale identity when present. */
  private device(req: IncomingMessage) {
    const login = req.headers["tailscale-user-login"];
    const owner = this.opts.ownerLogin();
    if (login && owner && String(login).toLowerCase() !== owner.toLowerCase()) return undefined;
    const token = this.cookie(req, "happy_token");
    if (!token) return undefined;
    const h = Buffer.from(sha(token));
    const d = this.store.devices.find((x) => {
      const b = Buffer.from(x.tokenHash);
      return b.length === h.length && timingSafeEqual(b, h);
    });
    if (d) d.lastSeen = Date.now();
    return d;
  }

  // ── http ─────────────────────────────────────────────────────
  private json(res: ServerResponse, status: number, body?: unknown) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(body === undefined ? "" : JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(c as Buffer);
      if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) throw new Error("too large");
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  private serveFile(res: ServerResponse, path: string, cache = false) {
    try {
      const st = statSync(path);
      if (!st.isFile()) return void res.writeHead(404).end();
      res.writeHead(200, {
        "Content-Type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": st.size,
        "Cache-Control": cache ? "public, max-age=31536000, immutable" : "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      createReadStream(path).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname;

    // Pairing: the 6-digit code shown in Happy's Settings on the laptop.
    if (p === "/api/pair" && req.method === "POST") {
      const login = req.headers["tailscale-user-login"];
      const owner = this.opts.ownerLogin();
      if (login && owner && String(login).toLowerCase() !== owner.toLowerCase()) return this.json(res, 403, { error: "Not your Tailscale account" });
      const { code, name } = await this.body(req).catch(() => ({}));
      const cur = this.currentCode();
      if (!cur || typeof code !== "string" || code.trim() !== cur.value) return this.json(res, 401, { error: "That code is wrong or expired. Make a new one in Happy → Settings on your laptop." });
      this.code = undefined;
      const token = randomBytes(32).toString("base64url");
      const id = randomBytes(8).toString("hex");
      this.store.devices.push({ id, name: String(name || req.headers["user-agent"] || "phone").slice(0, 80), createdAt: Date.now(), lastSeen: Date.now(), tokenHash: sha(token) });
      this.save();
      res.setHeader("Set-Cookie", `happy_token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`);
      return this.json(res, 200, { ok: true });
    }
    if (p === "/api/me") return this.json(res, 200, { paired: !!this.device(req) });

    // Static app shell and assets are public (no data in them); everything else needs a paired device.
    if (p === "/" || p === "/index.html") return this.serveFile(res, join(this.opts.rendererDir, "index.html"));
    if (p.startsWith("/assets/")) return this.serveFile(res, join(this.opts.rendererDir, normalize(p).replace(/^(\.\.[/\\])+/, "")), true);
    if (["/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png", "/icon-1024.png", "/apple-touch-icon.png"].includes(p)) return this.serveFile(res, join(this.opts.rendererDir, p.slice(1)));

    const dev = this.device(req);
    if (!dev) return this.json(res, 401, { error: "not paired" });

    if (p === "/api/push/key") return this.json(res, 200, { key: this.vapid().publicKey });
    if (p === "/api/push/subscribe" && req.method === "POST") {
      const { subscription } = await this.body(req).catch(() => ({}));
      if (!subscription?.endpoint) return this.json(res, 400, { error: "bad subscription" });
      this.store.subscriptions = this.store.subscriptions.filter((s) => s.sub.endpoint !== subscription.endpoint);
      this.store.subscriptions.push({ deviceId: dev.id, sub: subscription });
      this.save();
      return this.json(res, 200, { ok: true });
    }
    // Local files referenced in transcripts (images, PDFs): the phone's version of hubfile://.
    if (p.startsWith("/hubfile/")) return this.serveFile(res, decodeURIComponent(p.slice("/hubfile/".length)));
    res.writeHead(404).end();
  }

  // ── websocket bridge ─────────────────────────────────────────
  private onSocket(ws: WebSocket, deviceId: string) {
    (ws as any).deviceId = deviceId;
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("message", async (raw) => {
      let msg: { id: number; ch: string; args?: unknown[] };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const reply = (body: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ id: msg.id, ...body }));
      // Shell access stays on the laptop: the phone can't open or type into terminals.
      // The phone can't open shells or write files.
      const fn = String(msg.ch).startsWith("term:") || msg.ch === "fs:write" ? undefined : this.opts.handlers.get(msg.ch);
      if (!fn || DENY.has(msg.ch) || DENY_PREFIX.some((x) => msg.ch.startsWith(x))) return reply({ error: "Not available from your phone" });
      try {
        reply({ result: (await fn(...(msg.args ?? []))) ?? null });
      } catch (e) {
        reply({ error: (e as Error).message });
      }
    });
  }

  private broadcast(channel: string, payload: unknown) {
    if (!this.clients.size && channel !== "hub:update") return;
    if (channel === "hub:update") this.maybePush(payload as SessionState);
    const data = JSON.stringify({ ev: channel, payload: payload ?? null });
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  // ── push notifications ───────────────────────────────────────
  private vapid() {
    if (!this.store.vapid) {
      this.store.vapid = webpush.generateVAPIDKeys();
      this.save();
    }
    return this.store.vapid;
  }

  /** Notify phones when a session finishes, needs you, or fails. */
  private maybePush(s: SessionState) {
    const prev = this.lastStatus.get(s.id);
    this.lastStatus.set(s.id, s.status);
    if (!prev || prev === s.status || s.isManager || s.isCloud || !this.store.subscriptions.length) return;
    const body = s.status === "needs_permission" ? "needs you" : s.status === "error" ? "failed" : prev === "running" && s.status === "idle" ? "done" : null;
    if (!body) return;
    this.pushNote(s.title, body, `/#session=${s.id}`);
  }

  /** A push notification to every paired phone that turned them on. */
  pushNote(title: string, body: string, url: string) {
    if (!this.store.subscriptions.length) return;
    const { publicKey, privateKey } = this.vapid();
    const payload = JSON.stringify({ title, body, url });
    for (const { sub } of [...this.store.subscriptions]) {
      webpush.sendNotification(sub, payload, { vapidDetails: { subject: `mailto:${settings().profile.email || "happy@example.com"}`, publicKey, privateKey }, TTL: 3600 }).catch((e) => {
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          this.store.subscriptions = this.store.subscriptions.filter((x) => x.sub.endpoint !== sub.endpoint);
          this.save();
        }
      });
    }
  }

  // ── lifecycle ────────────────────────────────────────────────
  async start() {
    if (this.server) return;
    const server = createServer((req, res) => void this.route(req, res).catch(() => res.writeHead(500).end()));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      const dev = new URL(req.url ?? "/", "http://local").pathname === "/ws" ? this.device(req) : undefined;
      if (!dev) {
        // Let the client tell "not paired" apart from a network error.
        wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, "not paired"));
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, dev.id));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(REMOTE_PORT, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.wss = wss;
    this.offBroadcast = this.opts.onBroadcast((ch, payload) => this.broadcast(ch, payload));
  }

  stop() {
    this.offBroadcast?.();
    for (const ws of this.clients) ws.close(1001, "remote off");
    this.clients.clear();
    this.wss?.close();
    this.server?.close();
    this.server = undefined;
    this.wss = undefined;
  }
}
