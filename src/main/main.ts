import { app, powerSaveBlocker, BrowserWindow, dialog, ipcMain, Menu, net, Notification, protocol, shell } from "electron";
import { demo } from "./demo.js";
import { runDemoShots } from "./demoShots.js";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserManager } from "./browser.js";
import { BrowserMcpHttp } from "./browserTools.js";
import { Hub } from "./hub.js";
import { gitChanges, gitDiff, listFiles, readDir, readFileForPreview, resolveLink } from "./media.js";
import { readCodexModels, readCursorModels } from "./limits.js";
import { dropToken } from "./cloud.js";
import { loadSettings, saveSettings, settings } from "./settings.js";
import { REMOTE_PORT, RemoteServer } from "./remote.js";
import { tailscaleServe, tailscaleStatus, type TailscaleStatus } from "./tailscale.js";
import { parseEvent, parseIssue } from "./assist.js";
import { gcloudLogin, gcloudStatus, writeBrowserHelper } from "./gcloudAuth.js";
import { runSmoke } from "./smoke.js";
import { linkPreview } from "./linkPreview.js";
import { listRoutines } from "./routines.js";
import { projectConfig, setUserConfigDir } from "./projectConfig.js";
import { codexPrices, refreshCodexPrices } from "./codexPrices.js";
import { Terminals, plainText } from "./terminals.js";
import type { AnalyticsQuery, BrowserEdit, BrowserMenu, BrowserState, DeployJob, SessionState } from "../shared/types.js";

const here = dirname(fileURLToPath(import.meta.url));

// hubfile://local/<encoded absolute path> serves local files (images, PDFs) to the renderer.
protocol.registerSchemesAsPrivileged([
  { scheme: "hubfile", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Apps launched from Finder get a minimal PATH; agents need the user's real one (git, npm, brew…).
function adoptLoginShellPath() {
  try {
    const sh = process.env.SHELL || "/bin/zsh";
    const path = execFileSync(sh, ["-ilc", 'printf %s "$PATH"'], { encoding: "utf8", timeout: 5000 }).trim();
    if (path) process.env.PATH = path;
  } catch {
    process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
  }
}

// The app is called Happy, but keep sessions where they've always lived (~/Library/Application Support/session-hub).
app.setName("Happy");
// The Agent SDK warns on every bypass-mode session that canUseTool is skipped; that's expected here (questions and
// plan approvals go through a PreToolUse hook), so drop just that warning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const code = typeof rest[0] === "object" && rest[0] ? (rest[0] as { code?: string }).code : rest[1];
  if (code === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" || String(warning).includes("canUseTool will not be invoked")) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
app.setPath("userData", join(app.getPath("appData"), "session-hub"));
// Demo mode: its own data folder (browser logins, tokens, sessions), never your real one; no phone server.
if (demo) {
  app.setPath("userData", join(demo.dataDir, "userData"));
  process.env.SESSION_HUB_DATA = demo.dataDir;
  process.env.SESSION_HUB_REMOTE_PORT ||= "47899";
  process.env.SESSION_HUB_NO_SERVE = "1";
}

let win: BrowserWindow | null = null;
/** Every renderer action, by channel: bound to Electron IPC for the window and to the remote WebSocket for the phone. */
export const handlers = new Map<string, (...args: any[]) => unknown>();
(globalThis as { __happyHandlers?: typeof handlers }).__happyHandlers = handlers; // smoke tests
function handle(channel: string, fn: (...args: any[]) => unknown) {
  handlers.set(channel, fn);
  ipcMain.handle(channel, (_e, ...args) => fn(...args));
}
/** Events to the window and to connected phones. */
const remoteListeners = new Set<(channel: string, payload: unknown) => void>();
export function onBroadcast(fn: (channel: string, payload: unknown) => void) {
  remoteListeners.add(fn);
  return () => remoteListeners.delete(fn);
}
function send(channel: string, payload?: unknown) {
  win?.webContents.send(channel, payload);
  for (const l of remoteListeners) l(channel, payload);
}

let hub: Hub;
let browsers: BrowserManager;
let browserHttp: BrowserMcpHttp;

// Coalesce rapid transcript updates into ≤ ~20 sends/sec per session.
const pendingUpdates = new Map<string, SessionState>();
let flushTimer: NodeJS.Timeout | undefined;
function queueUpdate(s: SessionState) {
  pendingUpdates.set(s.id, s);
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    for (const st of pendingUpdates.values()) send("hub:update", st);
    pendingUpdates.clear();
  }, 50);
}

/** App menu: the standard one, with zoom steps that are saved (and that the browser pane follows). */
function setAppMenu() {
  const zoom = (delta: number | null) => {
    const wc = win?.webContents;
    if (!wc) return;
    const level = delta === null ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + delta));
    wc.setZoomLevel(level);
    saveSettings({ zoom: level });
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => zoom(null) },
          { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => zoom(0.5) },
          { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", visible: false, acceleratorWorksWhenHidden: true, click: () => zoom(0.5) },
          { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => zoom(-0.5) },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

/** Open a web link in Chrome, else the default browser. */
function openInChrome(url: string) {
  try {
    execFileSync("open", ["-a", "Google Chrome", url]);
  } catch {
    void shell.openExternal(url);
  }
}

function createWindow() {
  setAppMenu();
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#212121",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, plugins: true },
  });
  win.loadFile(join(here, "renderer", "index.html"));
  // Zoom (⌘+ / ⌘− / ⌘0) is remembered across restarts.
  win.webContents.on("did-finish-load", () => win?.webContents.setZoomLevel(settings().zoom ?? 0));
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  // Never let the app window itself navigate away (e.g. a dropped file or stray link).
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("closed", () => (win = null));
  browsers?.attachAll();
}

app.whenReady().then(async () => {
  adoptLoginShellPath();
  // Smiley Dock icon in dev (the packaged app gets it from build/icon via electron-builder).
  if (process.platform === "darwin") {
    try {
      app.dock?.setIcon(join(here, "..", "build", "icon.png"));
    } catch {}
  }

  protocol.handle("hubfile", (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname.slice(1));
    return net.fetch(pathToFileURL(path).toString());
  });

  browsers = new BrowserManager(() => win, {
    state: (s: BrowserState) => send("browser:state", s),
    activity: (id: string) => send("browser:activity", id),
    menu: (m: BrowserMenu) => send("browser:menu", m),
  }, (id) => {
    let engine: string | undefined;
    try {
      engine = hub?.get(id).meta.engine;
    } catch {}
    return engine === "codex" ? { name: "Codex", color: "#1f8a5b" } : engine === "cursor" ? { name: "Cursor", color: "#4b5563" } : { name: "Claude", color: "#6d5ce8" };
  });
  browserHttp = new BrowserMcpHttp(browsers);
  await browserHttp.start();
  // Google sign-ins (gcloud, Gmail) open in a small Happy window (Chrome user agent so Google allows the sign-in page).
  let authWin: BrowserWindow | null = null;
  const openAuthWindow = (url: string, title = "Sign in to Google") => {
    if (!authWin || authWin.isDestroyed()) {
      authWin = new BrowserWindow({
        width: 520,
        height: 720,
        title,
        parent: win ?? undefined,
        webPreferences: { partition: "persist:happy-auth", sandbox: true, contextIsolation: true },
      });
      authWin.on("closed", () => (authWin = null));
    }
    const w = authWin;
    const chromeUA = w.webContents.getUserAgent().replace(/\s?(Electron|Happy|session-hub)\/[\S]+/g, "");
    void w.loadURL(url, { userAgent: chromeUA });
    w.show();
    return { close: () => !w.isDestroyed() && w.close() };
  };
  // gcloud sign-in opens in Chrome (your Google session is there); gcloud's local redirect finishes the login.
  browserHttp.onOpenUrl = (url) => openInChrome(url);
  const browserHelper = writeBrowserHelper(app.getPath("userData"), browserHttp.port, browserHttp.token);
  handle("gcloud:status", () => (demo ? (demo.gcloud ?? { installed: true, userOk: true, adcOk: true, checkedAt: Date.now() }) : gcloudStatus()));
  handle("gcloud:login", async (kind: "user" | "adc") => {
    const ok = await gcloudLogin(kind, browserHelper, (line) => send("gcloud:log", line));
    if (authWin && !authWin.isDestroyed()) authWin.close();
    if (ok && kind === "user") {
      dropToken();
      void hub?.cloud(true);
    }
    return ok;
  });

  loadSettings(process.env.SESSION_HUB_DATA || app.getPath("userData"));
  setUserConfigDir(process.env.SESSION_HUB_DATA || app.getPath("userData"));
  hub = new Hub(
    process.env.SESSION_HUB_DATA || app.getPath("userData"),
    {
      update: queueUpdate,
      removed: (id) => send("hub:removed", id),
      groups: (g) => send("hub:groups", g),
      usage: (u) => send("hub:usage", u),
      limits: (l) => send("hub:limits", l),
      overview: (o) => send("hub:overview", o),
      cloud: (c) => send("hub:cloud", c),
      tasks: (t) => send("hub:tasks", t),
      inbox: (i) => send("email:inbox", i),
      triage: (r) => send("email:triage", r),
      reminder: (s, t) => {
        const n = new Notification({ title: `Reminder · ${s.title}`, body: t.text });
        n.on("click", () => {
          win?.show();
          win?.webContents.send("hub:focusSession", s.id);
        });
        n.show();
        remote.pushNote(`Reminder · ${s.title}`, t.text, `/#session=${s.id}`);
      },
    },
    browsers,
    browserHttp,
    openAuthWindow,
  );

  // App-owned chats pick up the current permission/model settings on launch too.
  hub.applySettings();
  handle("hub:list", () => hub.list());
  handle("hub:create", async (input) => (await hub.createSessionAsync(input)).snapshot());
  handle("hub:removeWorktree", (id: string) => hub.removeWorktree(id));
  handle("hub:fork", (id: string) => hub.forkSession(id).snapshot());
  handle("hub:stopProcess", (id: string, proc) => hub.stopProcess(id, proc));
  handle("hub:listWorktrees", (id: string) => hub.listWorktrees(id));
  handle("hub:linkWorktree", (id: string, path: string) => hub.linkWorktree(id, path));
  handle("hub:unlinkWorktree", (id: string, path: string) => hub.unlinkWorktree(id, path));
  handle("hub:send", (id: string, text: string, images?: string[], files?: string[]) =>
    (hub.freshenGit(id), hub.get(id).post(text, images, files)),
  );
  handle("hub:setModel", (id: string, model: string | null) => hub.setModel(id, model));
  handle("hub:setCodexSandbox", (id: string, mode) => hub.setCodexSandbox(id, mode));
  handle("hub:setEffort", (id: string, effort: string | null) => hub.setEffort(id, effort));
  handle("hub:codexModels", () => readCodexModels());
  handle("hub:cursorModels", () => readCursorModels());
  handle("hub:setCursorMode", (id: string, mode) => hub.setCursorMode(id, mode));
  handle("hub:setTags", (id: string, tags: string[]) => hub.setTags(id, tags));
  handle("hub:setArchived", (id: string, archived: boolean) => hub.setArchived(id, archived));
  handle("hub:setQaDone", (id: string, heads: string[] | null) => hub.get(id).update({ qaDone: heads ? { heads, at: Date.now() } : undefined }));
  handle("hub:moveToGroup", (id: string, groupId: string | null) => hub.moveToGroup(id, groupId));
  handle("hub:groups", () => hub.groups());
  handle("hub:createGroup", (name: string) => hub.createGroup(name));
  handle("hub:renameGroup", (id: string, name: string) => hub.renameGroup(id, name));
  handle("hub:deleteGroup", (id: string) => hub.deleteGroup(id));
  handle("hub:setGroupCollapsed", (id: string, c: boolean) => hub.setGroupCollapsed(id, c));
  handle("hub:interrupt", (id: string) => hub.get(id).stopTurn());
  handle("hub:remove", (id: string) => hub.remove(id));
  handle("hub:rename", (id: string, title: string) => hub.rename(id, title));
  handle("hub:setPermissionMode", (id: string, mode) => hub.setPermissionMode(id, mode));
  handle("hub:respondPermission", (requestId: string, decision, extra) => hub.respondPermission(requestId, decision, extra));
  handle("hub:listClaudeSessions", () => hub.listClaudeSessions());
  handle("claude:models", () => (demo ? [] : hub.claudeModels()));
  handle("hub:saveAttachment", (dataUrl: string) => hub.media.saveDataUrl(dataUrl));
  handle("hub:readFile", (path: string) => readFileForPreview(path));
  handle("fs:list", (root: string) => listFiles(root));
  handle("fs:write", (sessionId: string, path: string, text: string) => hub.writeSessionFile(sessionId, path, text));
  handle("hub:resolveLink", async (sessionId: string, raw: string) => resolveLink(raw, await hub.linkRoots(sessionId), (name) => hub.pathHints(sessionId, name)));
  handle("hub:readDir", (path: string) => readDir(path));
  handle("hub:gitChanges", (cwd: string) => gitChanges(cwd));
  handle("hub:usageToday", () => hub.usageToday());
  handle("hub:limits", () => hub.limits());
  handle("hub:cloud", (refresh?: boolean) => hub.cloud(refresh));
  // ── phone access (Tailscale) ──
  let ts: TailscaleStatus = { installed: false, running: false };
  let awakeId: number | undefined;
  let serveMessage: string | undefined;
  const remote = new RemoteServer(process.env.SESSION_HUB_DATA || app.getPath("userData"), {
    handlers,
    onBroadcast,
    rendererDir: join(here, "renderer"),
    ownerLogin: () => ts.login,
  });
  const keepAwake = (on: boolean) => {
    // Like `caffeinate -d`: the display stays on, so the Mac doesn't idle-sleep either.
    if (on && awakeId === undefined) awakeId = powerSaveBlocker.start("prevent-display-sleep");
    if (!on && awakeId !== undefined) (powerSaveBlocker.stop(awakeId), (awakeId = undefined));
  };
  const remoteStatus = async () => {
    ts = await tailscaleStatus();
    const r = settings().remote;
    return {
      enabled: r.enabled,
      serving: remote.running,
      url: ts.dnsName ? `https://${ts.dnsName}` : undefined,
      tailscale: ts,
      pairingCode: remote.currentCode(),
      devices: remote.devices(),
      keepAwake: r.keepAwake,
      message: serveMessage,
    };
  };
  const applyRemote = async () => {
    const r = settings().remote;
    ts = await tailscaleStatus();
    if (r.enabled) {
      await remote.start();
      const res = process.env.SESSION_HUB_NO_SERVE ? { ok: true, message: undefined } : ts.running ? await tailscaleServe(REMOTE_PORT, true) : { ok: false, message: ts.error ?? "Tailscale isn't running" };
      serveMessage = res.ok ? undefined : res.message;
    } else {
      if (remote.running && !process.env.SESSION_HUB_NO_SERVE) await tailscaleServe(REMOTE_PORT, false);
      remote.stop();
      serveMessage = undefined;
    }
    keepAwake(r.keepAwake); // on its own, not only with phone access
  };
  // Restart (optionally rebuilding from source first). Works from the phone too; it reconnects when Happy is back.
  // Packaged: rebuild Happy.app from the source checkout it was built from, then swap it in via a detached helper.
  handle("app:restart", async (rebuild: boolean) => {
    const { execFile, spawn } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const run = (cmd: string, args: string[], cwd: string, timeout: number) =>
      new Promise<{ ok: boolean; log: string }>((resolve) =>
        execFile(cmd, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
          resolve({ ok: !err, log: `${stdout}\n${stderr}`.split("\n").filter((l) => /error|Error|✓|failed/.test(l)).slice(-8).join("\n") }),
        ),
      );
    if (rebuild && app.isPackaged) {
      const source: string | undefined = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")).happySource;
      if (!source) throw new Error("This build doesn't know its source checkout; run scripts/package-app.sh once.");
      const script = join(source, "scripts", "package-app.sh");
      const out = await run("bash", [script, "build"], source, 600_000);
      if (!out.ok) throw new Error(`Build failed, not restarting:\n${out.log}`);
      hub.saveNow();
      spawn("bash", [script, "install", String(process.pid)], { cwd: source, detached: true, stdio: "ignore" }).unref();
      setTimeout(() => app.exit(0), 300);
      return true;
    }
    if (rebuild) {
      const out = await run("npm", ["run", "build"], app.getAppPath(), 180_000);
      if (!out.ok) throw new Error(`Build failed, not restarting:\n${out.log}`);
    }
    hub.saveNow();
    setTimeout(() => {
      // Relaunch with the app's absolute path (dev runs as `electron .`) and a marker the new process can see.
      const args = process.argv.slice(1).filter((a) => a !== "--relaunched" && a !== ".");
      app.relaunch({ args: [...(app.isPackaged ? [] : [app.getAppPath()]), ...args.filter((a) => a !== app.getAppPath()), "--relaunched"] });
      app.exit(0);
    }, 300);
    return true;
  });
  handle("remote:status", () => remoteStatus());
  handle("remote:enable", async (on: boolean) => {
    saveSettings({ remote: { ...settings().remote, enabled: on } });
    await applyRemote();
    if (on && !remote.devices().length) remote.newCode();
    return remoteStatus();
  });
  handle("remote:newCode", () => (remote.newCode(), remoteStatus()));
  handle("remote:removeDevice", (id: string) => (remote.removeDevice(id), remoteStatus()));
  if (settings().remote.enabled) void applyRemote();
  app.on("before-quit", () => keepAwake(false));

  handle("settings:get", () => settings());
  handle("settings:save", (patch) => {
    const next = saveSettings(patch);
    hub.applySettings();
    if (patch.remote) void applyRemote();
    send("settings:changed", next);
    return next;
  });
  handle("gmail:status", () => (demo?.mail ? { hasClient: true, connected: true, email: demo.mail.email, filters: true, calendar: true, contacts: true } : hub.gmail.status()));
  const calChanged = () => send("cal:changed", true);
  handle("cal:events", (timeMin: string, timeMax: string) =>
    demo?.calendar ? demo.calendar.filter((e) => e.end > timeMin && e.start < timeMax) : hub.calendar.events(timeMin, timeMax),
  );
  handle("cal:save", async (input, opts) => {
    const ev = await hub.calendar.save(input, opts);
    calChanged();
    return ev;
  });
  handle("cal:delete", async (id: string, notify: boolean) => {
    await hub.calendar.remove(id, notify);
    calChanged();
  });
  handle("cal:respond", async (id: string, response) => {
    await hub.calendar.respond(id, response);
    calChanged();
  });
  handle("cal:parse", (text: string) => parseEvent(text, new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone));
  handle("gmail:setClient", (id: string, secret: string) => hub.gmail.setClient(id, secret));
  handle("gmail:signIn", async () => {
    const st = await hub.gmail.signIn();
    send("gmail:status", st);
    void hub.inbox(true);
    void hub.contacts.refresh(true).catch(() => {});
    return st;
  });
  handle("gmail:signOut", () => hub.gmail.signOut());
  const demoInbox = (query = "") => ({ ...demo!.mail!.inbox, query, fetchedAt: Date.now(), ...(query ? { threads: [], starred: [], total: 0 } : {}) });
  handle("email:inbox", (refresh?: boolean) => (demo?.mail ? demoInbox() : hub.inbox(refresh)));
  handle("email:inboxPage", (query: string, page: number) => (demo?.mail ? demoInbox(query) : hub.inboxPage(query, page)));
  handle("email:thread", (id: string) => (demo?.mail ? demo.mail.threads[id] : hub.emailThread(id)));
  handle("email:attachment", (messageId: string, att) => hub.gmail.attachment(messageId, att));
  handle("email:star", (id: string, on: boolean) => hub.emailStar(id, on));
  handle("email:archive", (ids: string[]) => hub.emailArchive(ids));
  handle("email:spam", (ids: string[]) => hub.emailSpam(ids));
  handle("email:autoArchive", (from: string, archiveExisting: boolean) => hub.emailAutoArchive(from, archiveExisting));
  handle("email:archiveAll", (keepStarred: boolean) => hub.emailArchiveAll(keepStarred));
  handle("email:draft", (threadId: string, instruction?: string, to?: string[]) => (demo?.mail ? (demo.mail.drafts?.[threadId] ?? "") : hub.emailDraft(threadId, instruction, to)));
  handle("email:replyDefaults", (threadId: string) => (demo?.mail ? { to: [demo.mail.threads[threadId]?.messages.at(-1)?.fromEmail ?? ""].filter(Boolean), cc: [] } : hub.gmail.replyDefaults(threadId)));
  handle("email:saveDraft", (threadId: string, body: string, rcpt, draftId?: string, subject?: string, from?: string, html?: string) => hub.gmail.saveDraft(threadId, body, rcpt, draftId, hub.contacts.nameFor, subject, from, html));
  handle("email:sendAs", () => (demo?.mail ? (demo.mail.sendAs ?? []) : hub.gmail.sendAs()));
  handle("contacts:list", () => hub.contacts.list());
  handle("email:send", async (draftId: string) => {
    await hub.gmail.sendDraft(draftId);
    void hub.inbox(true);
  });
  handle("email:triage", () => hub.emailTriage());
  handle("email:triageRun", () => hub.triageRun ?? null);
  handle("email:triagePick", (picked: string[]) => hub.triagePick(picked));
  handle("email:triageClear", () => hub.triageClear());
  handle("linear:status", () => (demo?.linear ? { connected: true, name: demo.linear.name, email: demo.linear.email } : hub.linear.status()));
  handle("linear:setKey", async (key: string) => {
    const st = await hub.linear.setKey(key);
    void hub.tasks("mine", true);
    return st;
  });
  handle("linear:clearKey", () => hub.linear.clearKey());
  handle("hub:tasks", (scope, refresh?: boolean) => (demo?.linear ? { scope, fetchedAt: Date.now(), issues: demo.linear.issues } : hub.tasks(scope, refresh)));
  handle("linear:meta", () => hub.linear.meta());
  handle("linear:update", async (id: string, input) => {
    hub.patchTask(await hub.linear.updateIssue(id, input));
  });
  handle("linear:create", async (input) => {
    const r = await hub.linear.createIssue(input);
    void hub.tasks("mine", true);
    void hub.tasks("team", true);
    return r;
  });
  handle("linear:parse", async (text: string) => parseIssue(text, await hub.linear.meta()));
  handle("hub:taskDetail", (id: string) => hub.linear.issueDetail(id));
  handle("hub:startTask", async (issueId: string, engine) => (await hub.startTask(issueId, engine)).snapshot());
  handle("hub:newSystemChat", (id: string) => hub.newSystemChat(id).snapshot());
  handle("hub:cloudChat", () => hub.cloudChat().snapshot());
  handle("hub:emailChat", () => hub.emailChat().snapshot());
  handle("hub:emailAsk", (text: string, threadId?: string) => hub.emailAsk(text, threadId));
  handle("hub:cloudSpawn", async (input) => (await hub.cloudSpawn(input)).snapshot());
  handle("import:codexThreads", () => hub.codexThreads());
  // Terminal page: real shells, desktop only (the phone bridge refuses term:* channels).
  // Deploys started from the Manager board: running until the terminal prints the finish marker (or the shell dies).
  const deployJobs: DeployJob[] = [];
  const sendJobs = () => win?.webContents.send("deploy:jobs", deployJobs);
  const finishJob = (match: (j: DeployJob) => boolean, code: number) => {
    const j = deployJobs.find((x) => x.status === "running" && match(x));
    if (!j) return;
    j.status = code === 0 ? "success" : "failed";
    j.exitCode = code;
    j.finishedAt = Date.now();
    sendJobs();
    // New deploy tags: refresh the board now instead of waiting for the next fetch.
    if (j.status === "success") void hub.refreshDeploys();
  };
  const terminals = new Terminals({
    data: (id, data) => win?.webContents.send("term:data", { id, data }),
    exit: (id) => {
      win?.webContents.send("term:exit", id);
      finishJob((j) => j.termId === id, 1);
    },
    marker: (_id, job, code) => finishJob((j) => j.id === job, code),
    ran: (_id, run, code, output) => {
      const r = chatRuns.get(run);
      chatRuns.delete(run);
      if (!r) return;
      // Drop the echoed command line (and its printf wrapper); keep the end if it's long.
      const lines = plainText(output).split("\n");
      const i = lines.findIndex((l) => l.includes("HappyRun="));
      let text = (i >= 0 ? lines.slice(i + 1) : lines.slice(1)).join("\n").trim();
      if (text.length > 6000) text = `…\n${text.slice(-6000)}`;
      const msg = `I ran this in the terminal (exit ${code}):\n\n\`\`\`\n${r.command}\n\`\`\`\n\nOutput:\n\n\`\`\`\n${text || "(no output)"}\n\`\`\``;
      void hub.get(r.sessionId).post(msg).catch(() => {});
    },
  });
  /** Commands a chat's Run button started: run id → session + command (the result goes back to that chat). */
  const chatRuns = new Map<string, { sessionId: string; command: string }>();
  handle("term:run", (sessionId: string, command: string) => {
    const s = hub.get(sessionId);
    const termId = `s-${sessionId}`;
    if (!terminals.has(termId)) terminals.create(termId, s.meta.cwd, 100, 30);
    const run = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    chatRuns.set(run, { sessionId, command });
    // A fresh shell needs a moment to show its prompt before typing into it.
    setTimeout(() => terminals.run(termId, run, command), terminals.idle().includes(termId) ? 0 : 500);
    return termId;
  });
  handle("deploy:started", (job: Omit<DeployJob, "status" | "startedAt">) => {
    deployJobs.push({ ...job, status: "running", startedAt: Date.now() });
    if (deployJobs.length > 50) deployJobs.splice(0, deployJobs.length - 50);
    sendJobs();
  });
  handle("deploy:jobs", () => deployJobs);
  handle("deploy:dismiss", (id: string) => {
    const i = deployJobs.findIndex((j) => j.id === id);
    if (i >= 0) deployJobs.splice(i, 1);
    sendJobs();
  });
  handle("term:create", (id: string, cwd: string, cols: number, rows: number, command?: string) => terminals.create(id, cwd, cols, rows, command));
  handle("term:list", () => terminals.list());
  handle("term:idle", () => terminals.idle());
  handle("term:write", (id: string, data: string) => terminals.write(id, data));
  handle("term:resize", (id: string, cols: number, rows: number) => terminals.resize(id, cols, rows));
  handle("term:kill", (id: string) => terminals.kill(id));
  app.on("before-quit", () => terminals.killAll());
  handle("prices:get", () => codexPrices());
  handle("prices:refresh", async () => {
    saveSettings({ codexPricesAt: 0 });
    const models = (await readCodexModels()).models.map((m) => m.slug).filter((x) => x.startsWith("gpt-"));
    return refreshCodexPrices(models);
  });
  handle("link:preview", (url: string) => linkPreview(url));
  handle("routines:list", () => (demo ? (demo.routines ?? []) : listRoutines()));
  handle("routines:runs", (id: string) => hub.routineRuns(id));
  handle("routines:show", (id: string, runId: string | null) => hub.showRoutineRun(id, runId));
  handle("hub:projectConfig", () => projectConfig(settings().repo));
  handle("hub:analytics", (q: AnalyticsQuery) => (demo ? { connected: false, fetchedAt: Date.now(), envs: [], people: [], top: [], feed: [] } : hub.posthog.snapshot(projectConfig(settings().repo), q)));
  handle("hub:analyticsEvent", (id: string, ts: number) => hub.posthog.event(id, ts));
  handle("posthog:status", () => (demo ? { connected: false } : hub.posthog.status()));
  handle("posthog:connect", (key: string, host: string) => hub.posthog.connect(key, host));
  handle("posthog:disconnect", () => hub.posthog.disconnect());
  handle("posthog:setProject", (id: number) => hub.posthog.setProject(id));
  handle("link:chrome", (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error("Only web links");
    openInChrome(url);
  });
  handle("hub:stats", (refresh?: boolean, range?: "3m" | "6m" | "1y" | "all") => hub.stats(refresh, range));
  handle("hub:pin", (id: string, itemId: string, pinned: boolean) => hub.get(id).setItemField(itemId, { pinned: pinned || undefined }));
  handle("queue:edit", (id: string, qid: string, text: string) => hub.get(id).editQueued(qid, text));
  handle("queue:remove", (id: string, qid: string) => hub.get(id).removeQueued(qid));
  handle("queue:sendNow", (id: string, qid: string) => hub.get(id).sendQueuedNow(qid));
  handle("todo:add", (id: string, t) => hub.addTodo(id, t));
  handle("todo:update", (id: string, todoId: string, patch) => hub.updateTodo(id, todoId, patch));
  handle("todo:remove", (id: string, todoId: string) => hub.removeTodo(id, todoId));
  handle("import:codex", (ids: string[]) => hub.importCodex(ids));
  handle("hub:cloudAsk", (text: string, board: string) => hub.cloudAsk(text, board));
  handle("hub:overview", (refresh?: boolean) => hub.overview(refresh, refresh));
  handle("hub:gitDiff", (cwd: string, path: string) => gitDiff(cwd, path));
  handle("hub:revealFile", (path: string) => shell.showItemInFolder(path));
  handle("hub:openFile", async (path: string) => void (await shell.openPath(path)));
  handle("hub:pickFolder", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle("hub:pickFile", async (cwd?: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile"], defaultPath: cwd });
    return r.canceled ? null : r.filePaths[0];
  });
  handle("hub:pickFiles", async (cwd?: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"], defaultPath: cwd });
    return r.canceled ? [] : r.filePaths;
  });
  handle("hub:simplify", (sessionId: string, itemId: string) => hub.simplify(sessionId, itemId));
  handle("app:setBadge", (n: number) => {
    if (process.platform === "darwin") app.dock?.setBadge(n > 0 ? String(n) : "");
  });
  handle("app:attention", () => {
    if (process.platform === "darwin" && !win?.isFocused()) app.dock?.bounce("informational");
  });
  handle("browser:setBounds", (id: string, rect) => browsers.setBounds(id, rect));
  handle("browser:navigate", (id: string, url: string) => browsers.userNavigate(id, url));
  handle("browser:nav", (id: string, action) => browsers.nav(id, action));
  handle("browser:state", (id: string) => browsers.state(id));
  handle("browser:snapshot", (id: string) => browsers.snapshot(id));
  handle("browser:edit", (id: string, action: BrowserEdit, x?: number, y?: number) => browsers.edit(id, action, x, y));

  createWindow();
  app.on("activate", () => {
    if (!win) createWindow();
  });

  if (process.env.SESSION_HUB_SMOKE) void runSmoke(hub, () => win, process.env.SESSION_HUB_SMOKE);
  if (demo?.shots) void runDemoShots(() => win, demo.shots.dir);
});

app.on("before-quit", () => {
  hub?.dispose();
  browserHttp?.stop();
});
app.on("window-all-closed", () => {
  // Sessions keep running in the background on macOS until you quit.
  if (process.platform !== "darwin") app.quit();
});
