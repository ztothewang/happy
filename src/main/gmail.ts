import { saveSettings, settings } from "./settings.js";
import { safeStorage } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { EmailAttachment, EmailMessage, EmailThread, EmailThreadDetail, GmailStatus } from "../shared/types.js";

const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly"];
const CONTACT_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
];
const FILTER_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify", FILTER_SCOPE, ...CALENDAR_SCOPES, ...CONTACT_SCOPES, "openid", "email"];
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface Stored {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  email?: string;
  /** Scopes Google granted at the last sign-in. */
  scopes?: string[];
}

/** Run `fn` over items with at most `n` in flight. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** RFC 2047 encode a header value when it isn't plain ASCII. */
const encodeHeader = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** "Ada Lovelace <ada@x.com>" → { name, email }. */
export function parseAddress(raw = ""): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2], email: m[2].trim().toLowerCase() };
  return { name: raw.trim(), email: raw.trim().toLowerCase() };
}
const splitAddresses = (raw = "") => raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((a) => a.trim()).filter(Boolean);

/** Strip HTML to readable text (emails without a text/plain part). */
function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => (t.replace(/<[^>]+>/g, "").trim() === href ? href : `${t} (${href})`))
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drop the quoted history ("On … wrote:" and below, "> " lines) so each message shows only what's new. */
export function stripQuoted(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex(
    (l, i) => /^On .+wrote:\s*$/.test(l.trim()) || (/^On .+/.test(l.trim()) && /wrote:\s*$/.test(lines[i + 1]?.trim() ?? "")) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/.test(l) && /^(Sent|Date): /.test(lines[i + 1] ?? ""),
  );
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((l) => !/^>/.test(l));
  return kept.join("\n").trim();
}

function bodyOf(payload: any): { text: string; html?: string; attachments: EmailAttachment[] } {
  let plain = "";
  let html = "";
  const attachments: EmailAttachment[] = [];
  const walk = (p: any) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) attachments.push({ name: p.filename, mimeType: p.mimeType ?? "application/octet-stream", size: Number(p.body.size ?? 0), id: p.body.attachmentId });
    else if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = fromB64url(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data && !html) html = fromB64url(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return { text: plain || htmlToText(html), html: html || undefined, attachments };
}

const header = (m: any, name: string) => m.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value as string | undefined;

/**
 * Direct Gmail API client for one account. Uses your own Desktop OAuth client (from the happy-desktop project);
 * client id/secret and the refresh token are encrypted with the OS keychain. Never sends mail on its own.
 */
export class Gmail {
  private file: string;
  private cfg?: Stored;
  private access?: { token: string; exp: number };
  /** Called with every "Name <email>" seen, so the contact book learns names from mail. */
  onAddress?: (name: string, email: string) => void;
  /** Thread summaries / full threads keyed by id, valid while Gmail's historyId for the thread is unchanged. */
  private summaries = new Map<string, { historyId: string; t: EmailThread }>();
  private details = new Map<string, { historyId: string; t: EmailThreadDetail }>();

  constructor(private dataDir: string, private openAuthWindow: (url: string, title: string) => { close(): void }) {
    this.file = join(dataDir, "gmail-auth.bin");
    try {
      if (existsSync(this.file) && safeStorage.isEncryptionAvailable()) this.cfg = JSON.parse(safeStorage.decryptString(readFileSync(this.file)));
    } catch {
      this.cfg = undefined;
    }
  }

  private persist() {
    if (!this.cfg) return rmSync(this.file, { force: true });
    if (!safeStorage.isEncryptionAvailable()) throw new Error("The OS keychain isn't available to encrypt Gmail credentials");
    writeFileSync(this.file, safeStorage.encryptString(JSON.stringify(this.cfg)), { mode: 0o600 });
  }

  status(): GmailStatus {
    const granted = this.cfg?.scopes ?? [];
    return {
      hasClient: !!this.cfg?.clientId,
      connected: !!this.cfg?.refreshToken,
      email: this.cfg?.email,
      calendar: !!this.cfg?.refreshToken && CALENDAR_SCOPES.every((sc) => granted.includes(sc)),
      contacts: !!this.cfg?.refreshToken && CONTACT_SCOPES.every((sc) => granted.includes(sc)),
      filters: !!this.cfg?.refreshToken && granted.includes(FILTER_SCOPE),
    };
  }

  setClient(clientId: string, clientSecret: string): GmailStatus {
    const id = clientId.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(id)) throw new Error("That doesn't look like an OAuth client ID (…apps.googleusercontent.com)");
    this.cfg = { clientId: id, clientSecret: clientSecret.trim() };
    this.access = undefined;
    this.persist();
    return this.status();
  }

  signOut() {
    this.cfg = undefined;
    this.access = undefined;
    this.persist();
  }

  /** Loopback OAuth with PKCE: Google's sign-in opens in Happy's sign-in window and redirects to a one-shot local server. */
  async signIn(): Promise<GmailStatus> {
    const cfg = this.cfg;
    if (!cfg) throw new Error("Add your OAuth client first");
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(16));
    let win: { close(): void } | undefined;
    const { code, redirect } = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        const err = u.searchParams.get("error");
        const c = u.searchParams.get("code");
        if (u.searchParams.get("state") !== state || (!c && !err)) return void res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": "text/html" }).end(`<p style="font:14px system-ui;padding:24px">${err ? "Sign-in was cancelled." : "Signed in. You can close this window."}</p>`);
        clearTimeout(timer);
        server.close();
        err ? reject(new Error(`Google sign-in: ${err}`)) : resolve({ code: c!, redirect });
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new Error("Sign-in timed out"));
      }, 5 * 60_000);
      let redirect = "";
      server.listen(0, "127.0.0.1", () => {
        redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const q = new URLSearchParams({
          client_id: cfg.clientId,
          redirect_uri: redirect,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent",
          ...(settings().profile.email ? { login_hint: settings().profile.email } : {}),
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
        });
        win = this.openAuthWindow(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, "Sign in to Gmail");
      });
    }).finally(() => setTimeout(() => win?.close(), 1200));
    const tok = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier });
    if (!tok.refresh_token) throw new Error("Google didn't return a refresh token; try signing in again");
    cfg.refreshToken = tok.refresh_token;
    cfg.scopes = (tok.scope ?? "").split(" ").filter(Boolean);
    this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
    cfg.email = (await this.api("/profile")).emailAddress;
    if (!settings().profile.email && cfg.email) saveSettings({ profile: { ...settings().profile, email: cfg.email } });
    this.persist();
    return this.status();
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.cfg!.clientId, client_secret: this.cfg!.clientSecret, ...params }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(body.error_description || body.error || `token HTTP ${res.status}`);
    return body as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  }

  private async token(): Promise<string> {
    if (this.access && Date.now() < this.access.exp) return this.access.token;
    if (!this.cfg?.refreshToken) throw new Error("Gmail isn't connected");
    try {
      const t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: this.cfg.refreshToken });
      this.access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
      return t.access_token;
    } catch (e) {
      if (/invalid_grant/i.test((e as Error).message)) {
        this.cfg.refreshToken = undefined;
        this.persist();
        throw new Error("Google sign-in expired; sign in again");
      }
      throw e;
    }
  }

  private calls: number[] = [];
  /** Keep Gmail under its per-user quota (6000 units/min; reads/modifies cost 5–10 units): ≤ 400 calls per rolling minute. */
  private async throttle() {
    for (;;) {
      const now = Date.now();
      this.calls = this.calls.filter((t) => now - t < 60_000);
      if (this.calls.length < 400) {
        this.calls.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 60_000 - (now - this.calls[0]) + 50));
    }
  }

  /** Any Google REST call with this account; backs off and retries when Google rate-limits (429, or 403 quota/rate errors). */
  async google(url: string, init: { method?: string; body?: unknown } = {}, label = "Google"): Promise<any> {
    const gmail = url.startsWith(API);
    for (let attempt = 0; ; attempt++) {
      if (gmail) await this.throttle();
      const res = await fetch(url, {
        method: init.method ?? "GET",
        headers: { Authorization: `Bearer ${await this.token()}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return res.status === 204 ? {} : res.json();
      if (res.status === 401) this.access = undefined;
      const msg = ((await res.json().catch(() => ({}))) as any).error?.message ?? res.statusText;
      const limited = res.status === 429 || (res.status === 403 && /quota|rate limit/i.test(msg));
      // Per-minute quotas: back off long enough for the window to roll over (up to ~2.5 min in total).
      if (limited && attempt < 6) {
        await new Promise((r) => setTimeout(r, Math.min(40_000, 5000 * 2 ** attempt) + Math.random() * 1000));
        continue;
      }
      throw new Error(`${label} ${res.status}: ${msg}`);
    }
  }

  private api(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
    return this.google(`${API}${path}`, init, "Gmail");
  }

  get me() {
    return this.cfg?.email ?? "";
  }

  /** Inbox threads plus starred threads, newest first (starred ones the UI pins on top). */
  /** All thread ids (with historyId) matching a query, newest first, up to `cap`. */
  private async listAll(q: string, cap: number): Promise<Array<{ id: string; historyId: string }>> {
    const out: Array<{ id: string; historyId: string }> = [];
    let pageToken: string | undefined;
    do {
      const r = await this.api(`/threads?q=${encodeURIComponent(q)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`);
      out.push(...(r.threads ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken && out.length < cap);
    return out.slice(0, cap);
  }

  /** Summaries for these thread ids (cached by historyId when known), in the given order. */
  async summariesFor(list: Array<{ id: string; historyId?: string }>): Promise<EmailThread[]> {
    const stale = list.filter((t) => !this.summaries.has(t.id) || (t.historyId && this.summaries.get(t.id)!.historyId !== t.historyId));
    await pool(stale, 4, async ({ id }) => {
      const raw = await this.api(`/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`);
      this.summaries.set(id, { historyId: raw.historyId, t: this.summarize(raw) });
    });
    return list.flatMap((t) => (this.summaries.has(t.id) ? [this.summaries.get(t.id)!.t] : []));
  }

  /** One page of threads for a Gmail search, newest first. */
  async page(query: string, pageToken: string | undefined, size: number) {
    const r = await this.api(`/threads?q=${encodeURIComponent(query)}&maxResults=${size}${pageToken ? `&pageToken=${pageToken}` : ""}`);
    const threads = await this.summariesFor(r.threads ?? []);
    return { threads, nextPageToken: r.nextPageToken as string | undefined, estimate: Number(r.resultSizeEstimate ?? threads.length) };
  }

  /** Starred threads (pinned on top), up to 100. */
  async starredThreads(): Promise<EmailThread[]> {
    const r = await this.api(`/threads?q=${encodeURIComponent("is:starred")}&maxResults=100`);
    return this.summariesFor(r.threads ?? []);
  }

  /** Inbox thread count and important-unread count, from cheap list calls (no per-thread fetches). */
  async inboxCounts(): Promise<{ total: number; importantUnread: number }> {
    const [label, imp] = await Promise.all([
      this.api("/labels/INBOX"),
      this.listAll("in:inbox is:unread (is:important OR is:starred)", 2000),
    ]);
    return { total: Number(label.threadsTotal ?? 0), importantUnread: imp.length };
  }

  /** Ids of every inbox thread (up to 2000), for zero inbox. */
  inboxIds() {
    return this.listAll("in:inbox", 2000);
  }

  private summarize(t: any): EmailThread {
    const msgs: any[] = t.messages ?? [];
    const last = msgs[msgs.length - 1] ?? {};
    const labels = new Set(msgs.flatMap((m) => m.labelIds ?? []));
    const me = this.me;
    const senders: string[] = [];
    for (const m of msgs) {
      for (const h of ["From", "To", "Cc"]) for (const raw of splitAddresses(header(m, h))) {
        const x = parseAddress(raw);
        if (x.name && x.name !== x.email) this.onAddress?.(x.name, x.email);
      }
      const a = parseAddress(header(m, "From"));
      const name = a.email === me ? "me" : a.name.split(/\s+/)[0] || a.email;
      if (!senders.includes(name)) senders.push(name);
    }
    const lastFrom = parseAddress(header(last, "From"));
    return {
      id: t.id,
      subject: header(msgs[0] ?? {}, "Subject") || "(no subject)",
      snippet: (last.snippet ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
      from: senders.slice(-3).join(", "),
      lastFrom: lastFrom.email === me ? "me" : lastFrom.name,
      lastFromMe: lastFrom.email === me,
      to: splitAddresses(header(last, "To")).map((raw) => {
        const x = parseAddress(raw);
        return x.email === me ? "me" : x.name.split(/\s+/)[0] || x.email;
      }).slice(0, 3).join(", ") || undefined,
      date: Number(last.internalDate ?? 0),
      count: msgs.length,
      unread: labels.has("UNREAD"),
      starred: labels.has("STARRED"),
      important: labels.has("IMPORTANT"),
      inInbox: labels.has("INBOX"),
    };
  }

  /** Download one attachment into Happy's data folder (once) and return the file path. */
  async attachment(messageId: string, att: EmailAttachment): Promise<string> {
    const dir = join(this.dataDir, "attachments", messageId.replace(/[^\w-]/g, ""));
    const file = join(dir, (att.name || "attachment").replace(/[/\\:]/g, "_"));
    if (existsSync(file)) return file;
    const r = await this.api(`/messages/${messageId}/attachments/${att.id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, Buffer.from(String(r.data).replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    return file;
  }

  async thread(id: string): Promise<EmailThreadDetail> {
    const known = this.summaries.get(id)?.historyId;
    const cached = this.details.get(id);
    if (cached && known && cached.historyId === known) return cached.t;
    const t = await this.api(`/threads/${id}?format=full`);
    const me = this.me;
    const isDraft = (m: any) => (m.labelIds ?? []).includes("DRAFT");
    // Drafts aren't messages in the conversation: the latest one opens in the reply box instead.
    const draftMsg = [...(t.messages ?? [])].reverse().find(isDraft);
    let draft: EmailThreadDetail["draft"];
    if (draftMsg) {
      const list = await this.api(`/drafts?maxResults=500`).catch(() => ({ drafts: [] }));
      const d = (list.drafts ?? []).find((x: any) => x.message?.id === draftMsg.id);
      if (d) {
        const emails = (h: string) => splitAddresses(header(draftMsg, h)).map((r) => parseAddress(r).email).filter(Boolean);
        draft = { id: d.id, body: bodyOf(draftMsg.payload).text.trim(), to: emails("To"), cc: emails("Cc"), subject: header(draftMsg, "Subject") ?? "" };
      }
    }
    const messages: EmailMessage[] = (t.messages ?? []).filter((m: any) => !isDraft(m)).map((m: any) => {
      const { text, html, attachments } = bodyOf(m.payload);
      const from = parseAddress(header(m, "From"));
      return {
        id: m.id,
        from: from.name,
        fromEmail: from.email,
        fromMe: from.email === me,
        to: header(m, "To") ?? "",
        cc: header(m, "Cc") ?? "",
        date: Number(m.internalDate ?? 0),
        text: stripQuoted(text) || text.trim(),
        html,
        attachments,
        unread: (m.labelIds ?? []).includes("UNREAD"),
      };
    });
    const detail = { ...this.summarize(t), messages, draft };
    this.details.set(id, { historyId: t.historyId, t: detail });
    return detail;
  }

  private async modify(id: string, add: string[], remove: string[]) {
    await this.api(`/threads/${id}/modify`, { method: "POST", body: { addLabelIds: add, removeLabelIds: remove } });
    this.summaries.delete(id);
    this.details.delete(id);
  }
  star(id: string, on: boolean) {
    return this.modify(id, on ? ["STARRED"] : [], on ? [] : ["STARRED"]);
  }
  markRead(id: string) {
    return this.modify(id, [], ["UNREAD"]);
  }
  /** Report as spam: moves threads to Spam (Gmail learns from it). */
  async spam(ids: string[]) {
    await pool(ids, 4, (id) => this.modify(id, ["SPAM"], ["INBOX"]));
  }

  /** Archive every inbox message matching a Gmail search, in bulk. Returns how many messages moved. */
  async archiveQuery(q: string): Promise<number> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.api(`/messages?q=${encodeURIComponent(`in:inbox ${q}`)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`);
      ids.push(...(r.messages ?? []).map((m: any) => m.id as string));
      pageToken = r.nextPageToken;
    } while (pageToken && ids.length < 20_000);
    for (let i = 0; i < ids.length; i += 1000) await this.api("/messages/batchModify", { method: "POST", body: { ids: ids.slice(i, i + 1000), removeLabelIds: ["INBOX"] } });
    if (ids.length) (this.summaries.clear(), this.details.clear());
    return ids.length;
  }

  /** A Gmail filter that skips the inbox for mail from `from` (an address, or "@domain.com"). Runs in Gmail itself. */
  async createArchiveFilter(from: string) {
    if (!this.status().filters) throw new Error("Sign in again to let Happy create Gmail filters");
    await this.api("/settings/filters", { method: "POST", body: { criteria: { from }, action: { removeLabelIds: ["INBOX"] } } });
  }

  async archive(ids: string[]) {
    await pool(ids, 4, (id) => this.modify(id, [], ["INBOX"]));
  }

  /** Archive everything in the inbox (optionally keeping starred) with bulk requests. Returns how many messages moved. */
  async archiveAll(keepStarred: boolean): Promise<number> {
    const q = keepStarred ? "in:inbox -is:starred" : "in:inbox";
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.api(`/messages?q=${encodeURIComponent(q)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`);
      ids.push(...(r.messages ?? []).map((m: any) => m.id as string));
      pageToken = r.nextPageToken;
    } while (pageToken && ids.length < 20_000);
    for (let i = 0; i < ids.length; i += 1000) await this.api("/messages/batchModify", { method: "POST", body: { ids: ids.slice(i, i + 1000), removeLabelIds: ["INBOX"] } });
    this.summaries.clear();
    this.details.clear();
    return ids.length;
  }

  private async replyContext(threadId: string) {
    const t = await this.api(`/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`);
    const msgs: any[] = t.messages ?? [];
    const last = [...msgs].reverse().find((m) => !(m.labelIds ?? []).includes("DRAFT")) ?? msgs[msgs.length - 1];
    return { msgs, last };
  }

  /** Reply-all recipients for the thread, minus you: { to, cc } as bare emails. */
  async replyDefaults(threadId: string): Promise<{ to: string[]; cc: string[] }> {
    const { last } = await this.replyContext(threadId);
    const me = this.me;
    const lastFrom = parseAddress(header(last, "From"));
    const seen = new Set<string>([me]);
    const take = (raws: string[]) =>
      raws
        .map((r) => parseAddress(r).email)
        .filter((e) => e && !seen.has(e) && (seen.add(e), true));
    const to = take([...splitAddresses(lastFrom.email === me ? header(last, "To") : header(last, "Reply-To") || header(last, "From")), ...splitAddresses(header(last, "To"))]);
    const cc = take(splitAddresses(header(last, "Cc")));
    return { to, cc };
  }

  /**
   * Save a reply as a Gmail draft on the thread with the given recipients (emails; display names are added from
   * `names`). Returns the draft id; pass the previous id to replace it.
   */
  async saveDraft(threadId: string, body: string, rcpt: { to: string[]; cc: string[] }, draftId?: string, names?: (email: string) => string | undefined, subjectOverride?: string): Promise<string> {
    if (!rcpt.to.length && !rcpt.cc.length) throw new Error("Add at least one recipient");
    // No thread = a new email.
    const { msgs, last } = threadId ? await this.replyContext(threadId) : { msgs: [] as any[], last: undefined as any };
    const addr = (e: string) => {
      const n = names?.(e);
      return n ? `${encodeHeader(`"${n.replace(/"/g, "")}"`)} <${e}>` : e;
    };
    // A draft that isn't a reply (a new email): keep its own subject, no reply headers.
    const standalone = !msgs.some((m) => !(m.labelIds ?? []).includes("DRAFT"));
    const subject = (standalone && subjectOverride?.trim()) || (msgs[0] ? header(msgs[0], "Subject") : "") || "";
    const msgId = standalone ? undefined : header(last, "Message-ID");
    const refs = [last ? header(last, "References") : "", msgId].filter(Boolean).join(" ");
    const raw = [
      ...(rcpt.to.length ? [`To: ${rcpt.to.map(addr).join(", ")}`] : []),
      ...(rcpt.cc.length ? [`Cc: ${rcpt.cc.map(addr).join(", ")}`] : []),
      `Subject: ${encodeHeader(standalone || /^re:/i.test(subject) ? subject : `Re: ${subject}`)}`,
      ...(msgId ? [`In-Reply-To: ${msgId}`, `References: ${refs}`] : []),
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
    ].join("\r\n");
    const payload = { message: { raw: b64url(Buffer.from(raw, "utf8")), ...(threadId ? { threadId } : {}) } };
    // Re-saving creates a fresh draft and removes Happy's previous one: editing a reply draft in place can detach it from the thread.
    const d = await this.api("/drafts", { method: "POST", body: payload });
    if (draftId && draftId !== d.id) await this.api(`/drafts/${draftId}`, { method: "DELETE" }).catch(() => {});
    return d.id as string;
  }

  /** Send a saved draft. Only ever called from an explicit Send click. */
  async sendDraft(draftId: string) {
    await this.api("/drafts/send", { method: "POST", body: { id: draftId } });
  }

  /** Thread text for Claude (newest messages, trimmed). */
  async threadText(id: string, maxChars = 12_000): Promise<string> {
    const t = await this.thread(id);
    const parts = t.messages.map((m) => `From: ${m.fromMe ? `me (${settings().profile.name || "me"})` : `${m.from} <${m.fromEmail}>`}\nDate: ${new Date(m.date).toUTCString()}\n\n${m.text}`);
    let out = `Subject: ${t.subject}\n\n${parts.join("\n\n---\n\n")}`;
    if (out.length > maxChars) out = `…(earlier messages trimmed)\n\n${out.slice(-maxChars)}`;
    return out;
  }
}
