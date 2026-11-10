import { app, type BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "./hub.js";
import { settings } from "./settings.js";
import type { Session } from "./session.js";

/**
 * Live end-to-end smoke test (SESSION_HUB_SMOKE=<dir>): drives a real Claude session and a real
 * Codex session through browser tools, image reads, file writes and a permission prompt, then
 * dumps state + window screenshots into <dir> and quits. <dir> must contain sample.png.
 */
export async function runSmoke(hub: Hub, getWin: () => BrowserWindow | null, dir: string) {
  const log = (m: string) => console.log(`[smoke] ${m}`);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const settle = (s: Session, sec: number) =>
    Promise.race([s.waitUntilSettled(), wait(sec * 1000)]).then(() => s.status);
  const shot = async (name: string) => {
    const win = getWin();
    if (!win) return;
    await wait(1200);
    writeFileSync(join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    log(`screenshot ${name}`);
  };
  const clickRow = async (title: string) => {
    await wait(800);
    return getWin()!.webContents.executeJavaScript(
      `[...document.querySelectorAll('.r')].find(r => r.textContent.includes(${JSON.stringify(title)}))?.click()`,
    );
  };
  const results: Record<string, unknown> = {};
  /** A real repo to anchor sessions in: SESSION_HUB_SMOKE_REPO, else your main repo, else the smoke dir. */
  const REPO = process.env.SESSION_HUB_SMOKE_REPO || settings().repo || dir;

  try {
    await wait(1500);

    if (process.env.SESSION_HUB_SMOKE_ONLY === "restart") {
      const H = (globalThis as any).__happyHandlers as Map<string, (...a: any[]) => any>;
      const { appendFileSync } = await import("node:fs");
      appendFileSync(join(dir, "restart.log"), `${process.argv.includes("--relaunched") ? "second" : "first"} pid=${process.pid}\n`);
      if (!process.argv.includes("--relaunched")) await H.get("app:restart")!(false);
      else throw new Error("restart-only run");
      await wait(5000);
      return;
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "mcloud") {
      const { BrowserWindow: BW } = await import("electron");
      const H = (globalThis as any).__happyHandlers as Map<string, (...a: any[]) => any>;
      hub.createSession({ engine: "claude", cwd: REPO, title: "anchor" });
      await hub.cloud(true);
      const st = await H.get("remote:enable")!(true);
      const base = `http://127.0.0.1:${process.env.SESSION_HUB_REMOTE_PORT || 47821}`;
      const phone = new BW({ width: 390, height: 844, show: false, webPreferences: { partition: "remote-smoke2" } });
      await phone.loadURL(base);
      await wait(1000);
      await phone.webContents.executeJavaScript(`fetch("/api/pair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:${JSON.stringify(st.pairingCode.value)}})}).then(r=>r.status)`);
      await phone.loadURL(base);
      await wait(2500);
      const js = (c: string) => phone.webContents.executeJavaScript(c);
      const snap = async (n: string) => (await wait(1500), writeFileSync(join(dir, `${n}.png`), (await phone.webContents.capturePage()).toPNG()));
      await js(`[...document.querySelectorAll('.mx-tabbar button')].find(b=>b.textContent.includes('Cloud'))?.click()`);
      await snap("c-cloud");
      await js(`document.querySelectorAll('.mx-row')[1]?.click()`);
      await snap("c-tenant");
      await js(`document.querySelector('.mx-scroll').scrollTop = 700`);
      await snap("c-tenant-2");
      await js(`[...document.querySelectorAll('.mx-row')].find(r=>r.textContent.startsWith('ingestion'))?.click()`);
      await snap("c-service");
      await js(`[...document.querySelectorAll('.mx-tabbar button')].find(b=>b.textContent.includes('Chats'))?.click()`);
      await snap("c-chats");
      writeFileSync(join(dir, "desk.png"), (await getWin()!.webContents.capturePage()).toPNG());
      phone.destroy();
      await H.get("remote:enable")!(false);
      throw new Error("mcloud-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "remote") {
      const { BrowserWindow: BW } = await import("electron");
      const H = (globalThis as any).__happyHandlers as Map<string, (...a: any[]) => any>;
      hub.createSession({ engine: "claude", cwd: dir, title: "phone probe session" });
      const st = await H.get("remote:enable")!(true);
      results.enable = { enabled: st.enabled, serving: st.serving, url: st.url, code: !!st.pairingCode, ts: st.tailscale };
      const base = `http://127.0.0.1:${process.env.SESSION_HUB_REMOTE_PORT || 47821}`;
      results.unpaired = await (await fetch(`${base}/api/me`)).json();
      results.denied = (await fetch(`${base}/hubfile/${encodeURIComponent("/etc/hosts")}`)).status;
      const phone = new BW({ width: 390, height: 844, show: false, webPreferences: { partition: "remote-smoke" } });
      await phone.loadURL(base);
      await wait(1500);
      writeFileSync(join(dir, "phone-pair.png"), (await phone.webContents.capturePage()).toPNG());
      results.pair = await phone.webContents.executeJavaScript(`fetch("/api/pair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:${JSON.stringify(st.pairingCode.value)},name:"smoke phone"})}).then(r=>r.status)`);
      await phone.loadURL(base);
      await wait(3000);
      const js = (code: string) => phone.webContents.executeJavaScript(code);
      const snap = async (name: string) => (await wait(1200), writeFileSync(join(dir, `${name}.png`), (await phone.webContents.capturePage()).toPNG()));
      const tab = (label: string) => js(`[...document.querySelectorAll('.mx-tabbar button')].find(b=>b.textContent.includes(${JSON.stringify(label)}))?.click()`);
      await snap("m-chats");
      results.rows = await js(`[...document.querySelectorAll('.mx-row .mx-row-t')].map(e=>e.textContent)`);
      await js(`[...document.querySelectorAll('.mx-row')].find(r=>r.textContent.includes('phone probe'))?.click()`);
      await snap("m-session");
      await js(`document.querySelector('.mx-ico[aria-label="Session info"]')?.click()`);
      await snap("m-session-info");
      await js(`document.querySelector('.mx-grab')?.click()`);
      await wait(400);
      await js(`document.querySelector('.mx-back')?.click()`);
      for (const [label, name] of [["Board", "m-board"], ["Cloud", "m-cloud"], ["Tasks", "m-tasks"], ["Mail", "m-mail"], ["Cal", "m-cal"]] as const) {
        await tab(label);
        await snap(name);
      }
      await tab("Chats");
      await js(`document.querySelector('.mx-fab')?.click()`);
      await snap("m-new");
      results.devices = (await H.get("remote:status")!()).devices.map((d: any) => d.name);
      results.deniedCall = await phone.webContents.executeJavaScript(`window.hub.pickFolder().then(()=>"allowed",e=>e.message)`);
      phone.destroy();
      await H.get("remote:enable")!(false);
      throw new Error("remote-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "ui5") {
      const s = hub.createSession({ engine: "claude", cwd: dir, title: "error card probe" });
      (s as any).engineError("Turn ended: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null");
      await wait(2000);
      await clickRow("error card probe");
      await shot("ui5-error");
      await clickRow("Manager");
      await shot("ui5-manager");
      results.resizers = await getWin()!.webContents.executeJavaScript(`document.querySelectorAll('.resizer').length`);
      throw new Error("ui5-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "settings") {
      await clickRow("Calendar");
      await shot("calendar-connect");
      await getWin()!.webContents.executeJavaScript(`document.querySelector('[title^="Settings"]').click()`);
      await wait(800);
      await getWin()!.webContents.executeJavaScript(`document.getElementById('show-cloud').click()`);
      await wait(800);
      results.cloudRowVisible = await getWin()!.webContents.executeJavaScript(`[...document.querySelectorAll('.r .r-title')].some(e => e.textContent === 'Cloud')`);
      results.settingsFile = (await import("./settings.js")).settings();
      await shot("settings");
      throw new Error("settings-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "email") {
      await clickRow("Email");
      await shot("email");
      throw new Error("email-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "tasks") {
      await clickRow("Tasks");
      await shot("tasks");
      results.linear = await hub.linear.status();
      throw new Error("tasks-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "cloud") {
      hub.createSession({ engine: "claude", cwd: REPO, title: "repo anchor" });
      const snap = await hub.cloud(true);
      results.cloud = { authOk: snap?.authOk, tenants: snap?.tenants.map((t) => [t.tenant, t.issues.map((i) => `${i.ref} ${i.text}`)]) };
      await clickRow("Cloud");
      await shot("cloud-all");
      await getWin()!.webContents.executeJavaScript(`document.querySelectorAll('.cl-tab')[2]?.click()`);
      await shot("cloud-nov");
      await getWin()!.webContents.executeJavaScript(`document.querySelector('.cl-scroll').scrollTop = 99999`);
      await shot("cloud-nov-bottom");
      await getWin()!.webContents.executeJavaScript(`document.querySelector('.cl-chatbar')?.click()`);
      await wait(1500);
      await shot("cloud-chat");
      results.context = (await import("./cloud.js")).boardContext(snap ?? undefined, "nov");
      results.chatHidden = hub.list().filter((s) => s.isCloud).length;
      throw new Error("cloud-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "cursor") {
      await wait(2500);
      const c = hub.createSession({ engine: "cursor", cwd: dir, title: "cursor probe", prompt: "Read note.txt, run the shell command 'echo cursor-ok', then reply in one short line with both." });
      await clickRow("cursor probe");
      await settle(c, 150);
      await c.send("What was the exact file content you read? One line.");
      await wait(1500);
      await settle(c, 150);
      results.cursor = { status: c.status, sessionId: c.meta.engineSessionId, tokens: c.tokens, items: c.items.map((i) => [i.kind, i.tool ?? "", i.status ?? "", i.result ?? "", i.text.slice(0, 80)]) };
      await wait(800);
      await shot("cursor");
      throw new Error("cursor-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "ov") {
      await wait(3000);
      await clickRow("Manager");
      await hub.overview(true, true);
      for (let i = 0; i < 60 && !(await hub.overview()).annotatedAt; i++) await wait(2000);
      await wait(1500);
      await shot("ov-top");
      await getWin()!.webContents.executeJavaScript(`document.querySelector('.mgr .ov').scrollTop = 99999`);
      await shot("ov-bottom");
      results.ov = await hub.overview();
      throw new Error("ov-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "ask") {
      await wait(2500);
      const c = hub.createSession({
        engine: "claude",
        cwd: dir,
        title: "ask probe",
        model: "claude-haiku-5-5",
        permissionMode: "bypassPermissions",
        prompt: "Use the AskUserQuestion tool to ask me one question: which color do I prefer, with options Red and Blue. After I answer, reply with exactly: You picked <color>.",
      });
      await clickRow("ask probe");
      const start = Date.now();
      while (!c.pending && Date.now() - start < 90_000) await wait(300);
      results.pending = c.pending ? { tool: c.pending.tool, input: c.pending.input } : null;
      await shot("ask-card");
      if (c.pending?.tool === "AskUserQuestion") {
        const q = (c.pending.input.questions as any[])[0].question;
        hub.respondPermission(c.pending.requestId, "allow", { answers: { [q]: "Blue" } });
      }
      await settle(c, 90);
      results.reply = c.items.filter((i) => i.kind === "assistant").map((i) => i.text);
      await getWin()!.webContents.executeJavaScript(`(() => { const r = [...document.querySelectorAll('.r')].find(r => r.textContent.includes('ask probe')); r?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })()`);
      await wait(800);
      await shot("ask-hover");
      throw new Error("ask-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "ui4") {
      await wait(3000);
      const probe = async () =>
        getWin()!.webContents.executeJavaScript(`(async () => {
          const r = [...document.querySelectorAll('.r')].find(r => r.textContent.includes('smoke: claude'));
          if (!r) return 'no row';
          r.click();
          await new Promise(res => setTimeout(res, 400));
          return document.querySelector('.crumb-title')?.textContent;
        })()`);
      log("click1=" + (await probe()));
      log("click2=" + (await probe()));
      await shot("ui4-collapsed");
      await getWin()!.webContents.executeJavaScript(`document.querySelector('.tsum-btn')?.click()`);
      await shot("ui4-expanded");
      throw new Error("ui4-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "limits") {
      const c = hub.createSession({ engine: "claude", cwd: dir, title: "limits probe", model: "claude-haiku-5-5", prompt: "Reply with just: OK" });
      await clickRow("limits probe");
      await settle(c, 120);
      await wait(2500);
      results.limits = hub.limits();
      results.items = c.items.map((i) => `${i.kind}: ${i.text.slice(0, 80)}`);
      await shot("limits-topbar");
      throw new Error("limits-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "ui3") {
      // Real worktrees so branch / merge / deploy state is live; no AI calls.
      const wt = (title: string, cwd: string, engine: "claude" | "codex" = "claude") => hub.createSession({ engine, cwd, title });
      // The repo's own worktrees (at least four), so this runs against whatever repo you point it at.
      const trees = ((await hub.gitWatchFor().worktrees(REPO))?.list ?? []).slice(1, 6).map((w) => w.path);
      if (trees.length < 4) throw new Error("ui3 needs a repo with at least 4 worktrees (SESSION_HUB_SMOKE_REPO)");
      const a = wt("Agents list + reply polish", trees[0]);
      const b = wt("Memo PDF formatting", trees[1]);
      const c = wt("Apollo evaluation", trees[2], "codex");
      const e = wt("User background models", trees[3]);
      const g = hub.createGroup("Prod ops");
      hub.moveToGroup(b.id, g.id);
      hub.moveToGroup(c.id, g.id);
      hub.setTags(e.id, ["backfill"]);
      void a;
      if (trees[4]) await hub.linkWorktree(b.id, trees[4]);
      await wait(25000); // first git fetch + sweep
      await clickRow("Memo PDF formatting");
      await getWin()!.webContents.executeJavaScript(`(() => { const r = [...document.querySelectorAll('.r')].find(r => r.textContent.includes('Memo PDF')); r?.querySelector('.r-git')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })()`);
      await shot("ui3-hover");
      await clickRow("smoke: claude");
      await shot("ui3-main");
      await getWin()!.webContents.executeJavaScript(`document.querySelectorAll('.t-row')[1]?.querySelector('.ta')?.click()`);
      await shot("ui3-pane");
      await clickRow("smoke: permission");
      await getWin()!.webContents.executeJavaScript(`(() => { const t = document.querySelector('.crow textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, '/'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await shot("ui3-slash");
      throw new Error("ui3-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "ui2") {
      // Seed a realistic sidebar without any AI calls.
      const mk = (title: string, engine: "claude" | "codex") => hub.createSession({ engine, cwd: REPO, title });
      const a = mk("Fix login 500 on staging", "claude");
      const b = mk("Backfill offices for EU customers", "claude");
      const c = mk("Review outreach bounce PR", "codex");
      const d = mk("Market update prompt v3", "claude");
      const e = mk("Old experiment", "codex");
      const g = hub.createGroup("Prod ops");
      hub.moveToGroup(b.id, g.id);
      hub.moveToGroup(c.id, g.id);
      hub.setTags(b.id, ["backfill"]);
      hub.setTags(d.id, ["prompts"]);
      hub.setArchived(e.id, true);
      a.note("Seeded session for UI review.");
      await wait(1500);
      await clickRow("Backfill company_offices");
      await wait(500);
      log("rows=" + (await getWin()!.webContents.executeJavaScript(`[...document.querySelectorAll('.r')].map(r=>r.className+':'+r.textContent.slice(0,30)).join(' | ')`)));
      log("probe=" + (await getWin()!.webContents.executeJavaScript(`(async () => {
        const out = [];
        document.addEventListener('click', e => out.push('doc-click:' + e.target.className), true);
        const r = [...document.querySelectorAll('.r')].find(r => r.textContent.includes('Fix login'));
        r.click();
        await new Promise(res => setTimeout(res, 600));
        out.push('h1=' + document.querySelector('.session-head h1')?.textContent);
        return out.join(' ; ');
      })()`)));
      log("head=" + (await getWin()!.webContents.executeJavaScript(`document.querySelector('.session-head h1')?.textContent`)));
      await shot("ui2-main");
      const js = (code: string) => getWin()!.webContents.executeJavaScript(code);
      await js(`(() => { const r=[...document.querySelectorAll('.r')].find(r=>r.textContent.includes('Fix login')); r.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:330})); })()`);
      await wait(300);
      await js(`[...document.querySelectorAll('.menu-item')].find(b=>b.textContent.includes('Tags'))?.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
      await shot("ui2-context-menu");
      await js(`document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
      await js(`[...document.querySelectorAll('.composer-bar .chip')][1]?.click()`);
      await shot("ui2-model-menu");
      throw new Error("ui2-only run");
    }
    if (process.env.SESSION_HUB_SMOKE_ONLY === "ui") {
      await shot("ui-new-chat");
      await getWin()!.webContents.executeJavaScript(`document.querySelector('.engine-pick button:last-child')?.click()`);
      await shot("ui-new-chat-codex");
      throw new Error("ui-only run");
    }
    const permOnly = process.env.SESSION_HUB_SMOKE_ONLY === "perm";
    if (!permOnly) {
    // 1. Claude: browser + image read + file write (no prompts).
    const claude = hub.createSession({
      engine: "claude",
      cwd: dir,
      title: "smoke: claude",
      permissionMode: "bypassPermissions",
      prompt:
        "Smoke test, be brief. 1) Use mcp__browser__navigate to https://example.com, then mcp__browser__read_page, then mcp__browser__screenshot. " +
        "2) Read the image file sample.png in the current directory. 3) Write a file notes.md containing a heading '# Smoke' and one line 'hello'. " +
        "Then reply in two lines: the h1 text of example.com, and five words describing sample.png.",
    });
    await clickRow("smoke: claude");
    log("claude started");

    // 2. Codex: browser via the HTTP MCP bridge.
    const codex = hub.createSession({
      engine: "codex",
      cwd: dir,
      title: "smoke: codex",
      prompt:
        "Use the browser MCP tools: call navigate with https://example.org, then read_page, then screenshot. Reply with only the page's h1 text.",
    });
    log("codex started");

    results.claudeStatus = await settle(claude, 300);
    log(`claude settled: ${results.claudeStatus}`);
    await shot("02-claude-transcript");

    // Open the pane on the edited file and on the browser.
    await getWin()!.webContents.executeJavaScript(
      `[...document.querySelectorAll('.tool-file')].find(b => b.textContent.includes('notes.md'))?.click()`,
    );
    await shot("03-file-pane");
    await getWin()!.webContents.executeJavaScript(`document.querySelector('[data-tab-kind="browser"]')?.click()`);
    await shot("04-browser-pane");

    results.codexStatus = await settle(codex, 300);
    log(`codex settled: ${results.codexStatus}`);
    await clickRow("smoke: codex");
    await shot("05-codex-transcript");
    await getWin()!.webContents.executeJavaScript(`document.querySelector('[data-tab-kind="browser"]')?.click()`);
    await shot("05b-codex-browser");

    }
    // 3. Permission flow: default mode + a writing Bash command should prompt.
    const perm = hub.createSession({
      engine: "claude",
      cwd: dir,
      title: "smoke: permission",
      permissionMode: "default",
      prompt: "Run the shell command `touch smoke-perm.txt && echo smoke-ok` with Bash and reply with its output only.",
    });
    await clickRow("smoke: permission");
    const start = Date.now();
    while (!perm.pending && perm.status !== "idle" && perm.status !== "error" && Date.now() - start < 120_000) await wait(250);
    results.permissionPrompted = perm.pending ? { tool: perm.pending.tool, input: perm.pending.input } : null;
    await shot("06-permission-card");
    if (perm.pending) hub.respondPermission(perm.pending.requestId, "allow");
    results.permissionStatus = await settle(perm, 120);

    for (const s of [perm]) {
      results[s.meta.title] = s.items.map((i) => ({
        kind: i.kind,
        tool: i.tool,
        status: i.status,
        text: i.text.slice(0, 300),
        images: i.images?.length,
        path: i.path,
        diff: !!i.diff,
      }));
    }
  } catch (err) {
    results.error = String((err as Error).stack ?? err);
  }
  writeFileSync(join(dir, "smoke-state.json"), JSON.stringify(results, null, 2));
  log("done");
  hub.saveNow();
  app.quit();
}
