import { BrowserWindow, WebContentsView, type Rectangle } from "electron";
import type { BrowserEdit, BrowserMenu, BrowserState } from "../shared/types.js";

const HIDDEN_BOUNDS: Rectangle = { x: 0, y: 0, width: 1280, height: 800 };
const MAX_CONSOLE = 200;

interface ConsoleLine {
  level: string;
  text: string;
}

/** One embedded Chromium view per session. Driven via CDP so it works while the window is unfocused or the view hidden. */
class SessionBrowser {
  readonly view: WebContentsView;
  console: ConsoleLine[] = [];
  private attached = false;

  constructor(
    readonly sessionId: string,
    private onState: (s: BrowserState) => void,
    private onMenu: (p: Electron.ContextMenuParams) => void,
  ) {
    this.view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, partition: "persist:session-hub-browser" },
    });
    this.view.setBounds(HIDDEN_BOUNDS);
    this.view.setVisible(false);
    const wc = this.view.webContents;
    const emit = () => this.onState(this.state());
    wc.on("did-navigate", emit);
    wc.on("did-navigate-in-page", emit);
    wc.on("page-title-updated", emit);
    wc.on("did-start-loading", emit);
    wc.on("did-stop-loading", emit);
    wc.on("context-menu", (_e, p) => this.onMenu(p));
    wc.on("console-message", (e) => {
      this.console.push({ level: e.level, text: `${e.message}  (${e.sourceId}:${e.lineNumber})` });
      if (this.console.length > MAX_CONSOLE) this.console.shift();
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      // Real popups (window.open with a size, e.g. "Sign in with Google") need their opener to hand the result back,
      // so they get a small window of their own in the same session; it closes itself when the sign-in finishes.
      if (disposition === "new-window")
        return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, title: "Sign in" } };
      void wc.loadURL(url); // links that open a new tab stay in this one
      return { action: "deny" };
    });
  }

  state(): BrowserState {
    const wc = this.view.webContents;
    return {
      sessionId: this.sessionId,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  async cdp<T = any>(method: string, params?: object): Promise<T> {
    const dbg = this.view.webContents.debugger;
    if (!this.attached || !dbg.isAttached()) {
      dbg.attach("1.3");
      dbg.on("detach", () => (this.attached = false));
      this.attached = true;
    }
    return dbg.sendCommand(method, params) as Promise<T>;
  }

  async navigate(url: string) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = /^(localhost|127\.|\[::1\])/.test(url) ? `http://${url}` : `https://${url}`;
    const wc = this.view.webContents;
    try {
      await wc.loadURL(url);
    } catch (err) {
      // Aborted redirects (ERR_ABORTED) still land somewhere useful; surface real failures.
      if (!String(err).includes("ERR_ABORTED")) throw err;
    }
  }

  /** PNG of the viewport in CSS pixels, so coordinates in the image match click coordinates. */
  async screenshot(): Promise<Buffer> {
    const m = await this.cdp<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics");
    const { clientWidth: w, clientHeight: h } = m.cssLayoutViewport;
    const r = await this.cdp<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
    });
    return Buffer.from(r.data, "base64");
  }

  async click(x: number, y: number) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await this.cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }

  async scroll(x: number, y: number, dx: number, dy: number) {
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
  }

  async type(text: string) {
    await this.cdp("Input.insertText", { text });
  }

  async press(key: string) {
    const k = KEYS[key.toLowerCase()];
    if (!k) throw new Error(`Unsupported key "${key}". Supported: ${Object.keys(KEYS).join(", ")}`);
    await this.cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k, text: k.text });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  }

  eval<T = unknown>(js: string): Promise<T> {
    return this.view.webContents.executeJavaScript(js, true);
  }

  /** The agent's cursor, drawn into the page (pointer-events off) so you can watch what it does. */
  last?: { x: number; y: number };
  async pointer(p: AgentPointer) {
    const from = this.last ?? p;
    this.last = { x: p.x, y: p.y };
    await this.eval(`(${AGENT_CURSOR_JS})(${JSON.stringify({ ...p, from })})`).catch(() => {});
  }

  /** Hide or show the cursor, e.g. so the agent's own screenshots don't include it. */
  pointerVisible(on: boolean) {
    return this.eval(`{const h=document.getElementById('happy-agent-cursor');if(h)h.style.visibility='${on ? "visible" : "hidden"}'}`).catch(() => {});
  }
}

export interface AgentPointer {
  x: number;
  y: number;
  action: "move" | "click" | "type" | "scroll";
}

/** Draws (or moves) the agent cursor (blue, so it's never mistaken for yours). Lives in a shadow root on <html>, so page styles can't touch it and page text/refs ignore it. */
const AGENT_CURSOR_JS = String.raw`function (o) {
  const ID = 'happy-agent-cursor';
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' +
      '.c{position:fixed;left:0;top:0;transition:transform .35s cubic-bezier(.3,.7,.3,1),opacity .4s;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}' +
      '.c svg{display:block}' +
      '.r{position:fixed;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;border:2px solid;animation:r .55s ease-out forwards}' +
      '@keyframes r{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}' +
      '</style><div class="c"><svg width="20" height="22" viewBox="0 0 20 22"><path d="M2 1.5v17l4.6-4.3 3 6.6 3-1.4-3-6.4h6.2z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div>';
    document.documentElement.appendChild(host);
  }
  const COLOR = '#2f7cf6';
  const root = host.shadowRoot, c = root.querySelector('.c');
  root.querySelector('path').setAttribute('fill', COLOR);
  host.style.visibility = 'visible';
  if (!c.dataset.on) {
    c.style.transition = 'none';
    c.style.transform = 'translate(' + (o.from.x - 2) + 'px,' + (o.from.y - 1) + 'px)';
    c.getBoundingClientRect();
    c.style.transition = '';
    c.dataset.on = '1';
  }
  c.style.opacity = '1';
  c.style.transform = 'translate(' + (o.x - 2) + 'px,' + (o.y - 1) + 'px)';
  if (o.action === 'click') setTimeout(() => {
    const r = document.createElement('div');
    r.className = 'r';
    r.style.left = o.x + 'px'; r.style.top = o.y + 'px'; r.style.borderColor = COLOR;
    root.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }, 330);
  clearTimeout(host._fade);
  host._fade = setTimeout(() => { c.style.opacity = '0'; }, 6000);
}`;

const KEYS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
};

/** Injected into the page: tags interactive elements with data-hub-ref and returns an outline + text. */
const READ_PAGE_JS = `(() => {
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=""],[contenteditable=true]';
  const out = [];
  let n = 0;
  document.querySelectorAll('[data-hub-ref]').forEach(e => e.removeAttribute('data-hub-ref'));
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue;
    const ref = ++n;
    el.setAttribute('data-hub-ref', String(ref));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const extra = tag === 'input' ? ' type=' + (el.type || 'text') : tag === 'a' ? ' -> ' + el.getAttribute('href') : '';
    const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    out.push('[' + ref + '] ' + role + ' "' + label + '"' + extra + (inView ? '' : ' (offscreen)'));
    if (n >= 300) break;
  }
  const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 12000);
  return { url: location.href, title: document.title, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, viewport: [innerWidth, innerHeight], elements: out, text };
})()`;

const REF_CENTER_JS = (ref: number) => `(() => {
  const el = document.querySelector('[data-hub-ref="${ref}"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (el.matches('input,textarea,[contenteditable]')) el.focus();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

export class BrowserManager {
  private browsers = new Map<string, SessionBrowser>();
  private shown?: string;

  constructor(
    private getWindow: () => BrowserWindow | null,
    private emit: { state(s: BrowserState): void; activity(sessionId: string): void; menu(m: BrowserMenu): void },
  ) {}

  private get(sessionId: string): SessionBrowser {
    let b = this.browsers.get(sessionId);
    if (!b) {
      b = new SessionBrowser(
        sessionId,
        (s) => this.emit.state(s),
        (p) => {
          // Page coords → the app page's CSS pixels (the view sits at its bounds, scaled by the app's zoom).
          const z = this.getWindow()?.webContents.getZoomFactor() ?? 1;
          const at = b!.view.getBounds();
          const st = b!.state();
          this.emit.menu({
            sessionId,
            x: (at.x + p.x) / z,
            y: (at.y + p.y) / z,
            pageX: p.x,
            pageY: p.y,
            linkURL: p.linkURL,
            srcURL: p.srcURL,
            mediaType: p.mediaType,
            selectionText: p.selectionText,
            isEditable: p.isEditable,
            canGoBack: st.canGoBack,
            canGoForward: st.canGoForward,
          });
        },
      );
      this.browsers.set(sessionId, b);
      this.getWindow()?.contentView.addChildView(b.view);
    }
    return b;
  }

  /** Re-attach views after the window is recreated. */
  attachAll() {
    const win = this.getWindow();
    if (win) for (const b of this.browsers.values()) win.contentView.addChildView(b.view);
  }

  has(sessionId: string) {
    return this.browsers.has(sessionId);
  }

  state(sessionId: string): BrowserState | null {
    return this.browsers.get(sessionId)?.state() ?? null;
  }

  /** Show a session's view at `rect` (window content coords), or hide it with null. */
  setBounds(sessionId: string, rect: Rectangle | null) {
    if (rect) {
      if (this.shown && this.shown !== sessionId) this.hide(this.shown);
      const b = this.get(sessionId);
      // The rect is in the app page's CSS pixels; with the app zoomed (⌘+ / ⌘−) the window's are bigger or smaller.
      const z = this.getWindow()?.webContents.getZoomFactor() ?? 1;
      b.view.setBounds({
        x: Math.round(rect.x * z),
        y: Math.round(rect.y * z),
        width: Math.max(1, Math.round(rect.width * z)),
        height: Math.max(1, Math.round(rect.height * z)),
      });
      b.view.setVisible(true);
      this.shown = sessionId;
    } else if (this.shown === sessionId) this.hide(sessionId);
  }

  private hide(sessionId: string) {
    const b = this.browsers.get(sessionId);
    if (b) {
      b.view.setVisible(false);
      // Keep a real viewport so the agent can still render/screenshot while hidden.
      const { width, height } = b.view.getBounds();
      if (width < 400 || height < 300) b.view.setBounds(HIDDEN_BOUNDS);
    }
    if (this.shown === sessionId) this.shown = undefined;
  }

  /** What the pane shows right now, as a data URL. */
  async snapshot(sessionId: string): Promise<string | null> {
    const b = this.browsers.get(sessionId);
    if (!b || this.shown !== sessionId) return null;
    try {
      return (await b.view.webContents.capturePage()).toDataURL();
    } catch {
      return null;
    }
  }

  edit(sessionId: string, action: BrowserEdit, x?: number, y?: number) {
    const wc = this.browsers.get(sessionId)?.view.webContents;
    if (!wc) return;
    if (action === "inspect") wc.inspectElement(Math.round(x ?? 0), Math.round(y ?? 0));
    else wc[action]();
  }

  // ── user controls (toolbar) ──
  async userNavigate(sessionId: string, url: string) {
    await this.get(sessionId).navigate(url);
  }
  nav(sessionId: string, action: "back" | "forward" | "reload" | "stop") {
    const wc = this.get(sessionId).view.webContents;
    if (action === "back") wc.navigationHistory.goBack();
    else if (action === "forward") wc.navigationHistory.goForward();
    else if (action === "reload") wc.reload();
    else wc.stop();
  }

  // ── agent operations ──
  agent(sessionId: string) {
    this.emit.activity(sessionId);
    const b = this.get(sessionId);
    // Show the cursor move, then act once it arrives (only worth the wait while you can see the browser).
    const show = async (x: number, y: number, action: AgentPointer["action"]) => {
      await b.pointer({ x, y, action });
      if (this.shown === sessionId) await new Promise((r) => setTimeout(r, action === "click" ? 380 : 200));
    };
    return {
      navigate: (url: string) => b.navigate(url),
      back: () => b.view.webContents.navigationHistory.goBack(),
      screenshot: async () => {
        await b.pointerVisible(false);
        try {
          return await b.screenshot();
        } finally {
          await b.pointerVisible(true);
        }
      },
      readPage: () => b.eval<ReadPageResult>(READ_PAGE_JS),
      click: async (target: { ref?: number; x?: number; y?: number }) => {
        let pt = target.x != null && target.y != null ? { x: target.x, y: target.y } : null;
        if (target.ref != null) {
          pt = await b.eval<{ x: number; y: number } | null>(REF_CENTER_JS(target.ref));
          if (!pt) throw new Error(`No element with ref ${target.ref}. Call read_page again — refs change after navigation.`);
        }
        if (!pt) throw new Error("Provide either ref or x and y.");
        await show(pt.x, pt.y, "click");
        await b.click(pt.x, pt.y);
      },
      type: async (text: string, ref?: number) => {
        if (ref != null) {
          const pt = await b.eval<{ x: number; y: number } | null>(REF_CENTER_JS(ref));
          if (!pt) throw new Error(`No element with ref ${ref}.`);
          await show(pt.x, pt.y, "click");
          await b.click(pt.x, pt.y);
        }
        await b.type(text);
      },
      press: (key: string) => b.press(key),
      scroll: async (dy: number) => {
        const [w, h] = await b.eval<[number, number]>("[innerWidth, innerHeight]");
        await show(w / 2, h / 2, "scroll");
        await b.scroll(w / 2, h / 2, 0, dy);
      },
      evaluate: (js: string) => b.eval(js),
      console: () => b.console.slice(-50),
      waitForLoad: async (timeoutMs = 10000) => {
        const wc = b.view.webContents;
        const start = Date.now();
        while (wc.isLoading() && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 100));
      },
      state: () => b.state(),
    };
  }

  dispose(sessionId: string) {
    const b = this.browsers.get(sessionId);
    if (!b) return;
    this.getWindow()?.contentView.removeChildView(b.view);
    b.view.webContents.close();
    this.browsers.delete(sessionId);
    if (this.shown === sessionId) this.shown = undefined;
  }
}

export interface ReadPageResult {
  url: string;
  title: string;
  scrollY: number;
  pageHeight: number;
  viewport: [number, number];
  elements: string[];
  text: string;
}
