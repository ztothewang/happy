import { app, nativeTheme, type BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Demo screenshot run: drive the window through the README shots and save them as PNGs, then quit. */
export async function runDemoShots(
  getWin: () => BrowserWindow | null,
  dir: string,
) {
  mkdirSync(dir, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Never hand page objects back (they can't cross to the main process).
  const js = (code: string) => getWin()!.webContents.executeJavaScript(`void (${code})`);
  const clickRow = (title: string) =>
    js(
      `[...document.querySelectorAll('.r')].find(r => r.textContent.includes(${JSON.stringify(title)}))?.click()`,
    );
  const clickNav = (label: string) =>
    js(
      `[...document.querySelectorAll('.nav-row')].find(r => r.textContent.includes(${JSON.stringify(label)}))?.click()`,
    );
  const clickButton = (title: string) =>
    js(
      `document.querySelector('button[title=${JSON.stringify(title)}]')?.click()`,
    );
  // Every shot in both themes: <name>-dark.png and <name>-light.png (GitHub picks one with prefers-color-scheme).
  const runAll = async (theme: "dark" | "light") => {
    nativeTheme.themeSource = theme;
    const shot = async (name: string) => {
      await wait(1500);
      writeFileSync(
        join(dir, `${name}-${theme}.png`),
        (await getWin()!.webContents.capturePage()).toPNG(),
      );
      console.log(`[demo] ${name}-${theme}.png`);
    };
    const win = getWin()!;
    win.setMinimumSize(900, 600);
    win.setSize(1680, 1050);
    await wait(theme === "dark" ? 9000 : 2500); // git checks + board (first pass)
    // Two shells on the Terminal page, so its sidebar count is real.
    if (theme === "dark") {
      await clickNav("Terminal");
      await wait(1500);
      await js(
        `[...document.querySelectorAll('.term-bar button')].find(b => b.textContent.includes('split'))?.click()`,
      );
      await wait(1500);
    }
    // The window's traffic lights are drawn by macOS outside the page; put them where they sit (desktop shots only).
    await js(
      `(() => { if (document.getElementById('demo-lights')) return; const d = document.createElement('div'); d.id = 'demo-lights'; d.style.cssText = 'position:fixed;left:14px;top:14px;display:flex;gap:8px;z-index:9999;pointer-events:none'; for (const c of ['#ff5f57','#febc2e','#28c840']) { const b = document.createElement('span'); b.style.cssText = 'width:12px;height:12px;border-radius:50%;background:' + c + ';box-shadow:inset 0 0 0 0.5px rgba(0,0,0,0.25)'; d.appendChild(b); } document.body.appendChild(d); })()`,
    );
    const main =
      process.env.SESSION_HUB_DEMO_MAIN ??
      "Fix duplicate invoice emails on retry";
    await clickRow(main);
    await wait(1200);
    // Open the side panel (⌘\\) on the chat's uncommitted changes.
    await js(
      `document.querySelector('.pane') || [...document.querySelectorAll('button')].find(b => (b.title || '').startsWith('Toggle side pane'))?.click()`,
    );
    await wait(800);
    // The right panel shows the chat's pinned replies.
    await clickButton("Pinned replies (opens in the side pane)");
    await shot("sessions");
    // Chat wall with four chats ticked for the grid (one per engine plus the backfill), then the grid itself.
    await clickNav("Chat wall");
    await wait(1200);
    const gridChats = [
      main,
      "Add EU VAT reverse charge to checkout",
      "Speed up the invoice list",
      "Dunning schedule backfill for past-due accounts",
    ];
    for (const t of gridChats)
      await js(
        `(() => { const c = [...document.querySelectorAll('.ac-card')].find(c => c.querySelector('.ac-title')?.textContent === ${JSON.stringify(t)}); const b = c?.querySelector('.ac-check'); if (b && !b.classList.contains('on')) b.click(); })()`,
      );
    await shot("wall");
    await js(
      `[...document.querySelectorAll('.ac-bar button')].find(b => b.textContent.includes('open chat grid'))?.click()`,
    );
    await wait(1500);
    await shot("grid");
    await clickNav("Manager");
    await shot("manager");
    await clickNav("Cloud");
    await wait(1500);
    await js(
      `[...document.querySelectorAll('.cl-tab')].find(b => b.textContent.trim().startsWith('eu'))?.click()`,
    );
    await wait(800);
    await js(
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Ask about'))?.click()`,
    );
    await shot("cloud");
    // Mail: open the thread and have Claude draft the reply (the demo file supplies the draft).
    await clickNav("Mail");
    await wait(2000);
    const subject =
      process.env.SESSION_HUB_DEMO_MAIL ?? "Charged twice for INV-2041?";
    await js(
      `[...document.querySelectorAll('.em-row')].find(r => r.textContent.includes(${JSON.stringify(subject)}))?.click()`,
    );
    await wait(1500);
    await js(
      `(() => { const i = document.getElementById('email-instruction'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'apologize, confirm the refund, mention the fix ships today'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    await wait(300);
    await js(
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('draft with Claude'))?.click()`,
    );
    await wait(1200);
    await shot("mail");
    await clickRow(main);
    await js(`document.getElementById('demo-lights')?.remove()`);
    win.setMinimumSize(320, 480);
    win.setSize(430, 932);
    await wait(2500);
    // Phone: the Chats list (sessions with status, stages and tags, and the tab bar with everything else).
    await js(
      `[...document.querySelectorAll('.mx-tabbar button')].find(b => b.textContent.includes('Chats'))?.click()`,
    );
    await shot("phone");
  };
  try {
    await runAll("dark");
    await runAll("light");
  } catch (e) {
    console.error("[demo] shots failed", e);
  }
  app.quit();
}
