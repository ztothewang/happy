import { useEffect, useState } from "react";
import type { TagDef, AppSettings, CodexThreadInfo, Engine, RemoteStatus } from "../shared/types";
import { hub } from "./App";
import { enablePush } from "./remote";
import { useCodexModels, useCursorModels } from "./controlMenus";
import { CLAUDE_MODELS, num } from "./models";
import { useSettings } from "./settings";

const ENGINES: Engine[] = ["claude", "codex", "cursor"];
const SECTIONS: Array<{ key: keyof AppSettings["show"]; label: string; hint: string }> = [
  { key: "manager", label: "Manager", hint: "board of active, done and unmerged work, plus its chat" },
  { key: "cloud", label: "Cloud", hint: "GCP health per tenant, with a board-aware chat" },
  { key: "tasks", label: "Tasks", hint: "open Linear issues, hand one to an agent" },
  { key: "email", label: "Email", hint: "Gmail inbox, Claude drafts, zero inbox" },
  { key: "calendar", label: "Calendar", hint: "Google Calendar week view, create with Claude" },
  { key: "terminal", label: "Terminal", hint: "up to 4 shells side by side, in your main repo" },
];
const BYPASS: Array<{ key: keyof AppSettings["bypass"]; label: string; hint: string }> = [
  { key: "sessions", label: "New chats", hint: "sessions you start from + New" },
  { key: "tasks", label: "Task agents", hint: "agents started from Tasks" },
  { key: "manager", label: "Manager chat", hint: "can create and message sessions" },
  { key: "email", label: "Mail chat", hint: "acts on mail without asking; sending always asks" },
  { key: "cloud", label: "Cloud chat", hint: "the board chat and Cloud Ask chats" },
];

function Toggle({ on, onChange, id }: { on: boolean; onChange(v: boolean): void; id: string }) {
  return <button id={id} role="switch" aria-checked={on} className={`st-toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

const ago = (ts: number) => {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** Phone access over Tailscale: on/off, address, pairing code, paired phones, keep awake. */
function PhoneAccess() {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string>();
  const onPhone = !!hub().isRemote;
  useEffect(() => {
    if (onPhone) return;
    void hub().remoteStatus().then(setSt);
    const t = setInterval(() => void hub().remoteStatus().then(setSt), 15_000);
    return () => clearInterval(t);
  }, [onPhone]);

  if (onPhone)
    return (
      <section>
        <h2>This phone</h2>
        <div className="st-row">
          <div>
            <b>Notifications</b>
            <span className="muted small">a ping when a session finishes, needs you, or fails</span>
          </div>
          <button className="kb" onClick={() => void enablePush().then(setPushMsg).catch((e) => setPushMsg(String(e.message ?? e)))}>
            enable
          </button>
        </div>
        {pushMsg && <p className="muted small">{pushMsg}</p>}
      </section>
    );
  if (!st) return null;
  const toggle = async (on: boolean) => {
    setBusy(true);
    setSt(await hub().remoteEnable(on));
    setBusy(false);
  };
  return (
    <section>
      <h2>Phone access</h2>
      <p className="muted small">Use Happy from your phone over Tailscale, while this Mac is on and awake. Only your Tailscale account and phones you pair can connect.</p>
      <div className="st-row">
        <div>
          <b>Phone access</b>
          <span className="muted small">
            {!st.tailscale.installed
              ? "install Tailscale on this Mac and your phone first"
              : !st.tailscale.running
                ? (st.tailscale.error ?? "Tailscale isn't running")
                : `Tailscale: ${st.tailscale.login} · ${st.tailscale.dnsName}`}
          </span>
        </div>
        <Toggle id="remote-enabled" on={st.enabled} onChange={(v) => void toggle(v)} />
      </div>
      {busy && <p className="muted small">setting up…</p>}
      {st.message && <p className="tk-err">{st.message}</p>}
      {st.enabled && st.serving && st.url && !st.message && (
        <>
          <div className="st-row">
            <div>
              <b>Address</b>
              <span className="muted small">open on your phone (Tailscale on), then Share → Add to Home Screen</span>
            </div>
            <span className="mono st-url" title="Select to copy">
              {st.url}
            </span>
          </div>
          <div className="st-row">
            <div>
              <b>Pairing code</b>
              <span className="muted small">{st.pairingCode ? `enter it on your phone · expires in ${Math.max(1, Math.round((st.pairingCode.expires - Date.now()) / 60_000))} min` : "make one to connect a phone"}</span>
            </div>
            {st.pairingCode ? <span className="st-code">{st.pairingCode.value}</span> : null}
            <button className="kb" onClick={() => void hub().remoteNewCode().then(setSt)}>
              {st.pairingCode ? "new code" : "make code"}
            </button>
          </div>
          {st.devices.map((d) => (
            <div key={d.id} className="st-row">
              <div>
                <b>{d.name}</b>
                <span className="muted small">paired {ago(d.createdAt)} · last seen {ago(d.lastSeen)}</span>
              </div>
              <button className="link-btn" onClick={() => void hub().remoteRemoveDevice(d.id).then(setSt)}>
                remove
              </button>
            </div>
          ))}
        </>
      )}
      <div className="st-row">
        <div>
          <b>Keep this Mac awake</b>
          <span className="muted small">keeps the display on and the Mac from sleeping while Happy runs, like caffeinate -d (closing the lid still sleeps unless it's on power with a display)</span>
        </div>
        <Toggle id="remote-awake" on={st.keepAwake} onChange={(v) => void hub().saveSettings({ remote: { enabled: st.enabled, keepAwake: v } }).then(() => hub().remoteStatus().then(setSt))} />
      </div>
    </section>
  );
}

/** Update & restart: rebuild from source, swap the app and reopen it. Works from the laptop or the phone. */
function RestartApp() {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(0);
  const [err, setErr] = useState<string>();
  const go = async () => {
    const list = await hub().list();
    const n = list.filter((s) => s.status === "running").length;
    if (n && !confirm) {
      setRunning(n);
      setConfirm(true);
      return;
    }
    setBusy(true);
    setErr(undefined);
    try {
      await hub().restartApp(true);
    } catch (e) {
      setErr(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      setBusy(false);
    }
    setConfirm(false);
  };
  return (
    <section>
      <h2>App</h2>
      <div className="st-row">
        <div>
          <b>Update &amp; restart</b>
          <span className="muted small">{busy ? "building… Happy restarts when it's done (about a minute)" : "pick up the latest code and reopen Happy"}</span>
        </div>
        <button className="kb" disabled={busy} onClick={() => void go()}>
          {confirm ? `update anyway (${running} running)` : "update"}
        </button>
      </div>
      {confirm && <p className="muted small">{running} session{running > 1 ? "s are" : " is"} working; restarting stops {running > 1 ? "them" : "it"} mid-turn (send “continue” afterwards).</p>}
      {err && <pre className="tk-err st-err">{err}</pre>}
    </section>
  );
}

/** Bring existing Codex threads into Happy: pick, import, keep talking in the same thread. */
function ImportChats() {
  const [list, setList] = useState<CodexThreadInfo[] | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const load = () => void hub().codexThreads().then(setList, (e) => setMsg(String((e as Error).message)));
  const go = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      const ids = await hub().importCodex([...pick]);
      setMsg(`Imported ${num(ids.length)} chat${ids.length === 1 ? "" : "s"}; they're in your chat list.`);
      setPick(new Set());
      load();
    } catch (e) {
      setMsg(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
    setBusy(false);
  };
  return (
    <section>
      <h2>Import</h2>
      <div className="st-row">
        <div>
          <b>Codex chats</b>
          <span className="muted small">continue threads from the Codex app here, with their recent history</span>
        </div>
        {list ? (
          <button className="kb" disabled={busy || !pick.size} onClick={() => void go()}>
            {busy ? "importing…" : `import ${pick.size || ""}`.trim()}
          </button>
        ) : (
          <button className="kb" onClick={load}>
            choose…
          </button>
        )}
      </div>
      {list &&
        list.map((t) => (
          <label key={t.id} className="st-row st-pick">
            <div>
              <b>{t.title}</b>
              <span className="muted small">
                {t.imported ? "already imported · " : ""}
                {new Date(t.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {t.cwd.replace(/^\/Users\/[^/]+/, "~")}
              </span>
            </div>
            <input
              type="checkbox"
              disabled={!!t.imported}
              checked={pick.has(t.id)}
              onChange={(e) => setPick((p) => (e.target.checked ? new Set(p).add(t.id) : new Set([...p].filter((x) => x !== t.id))))}
            />
          </label>
        ))}
      {list && !list.length && <p className="muted small">No open Codex chats.</p>}
      {msg && <p className="muted small">{msg}</p>}
    </section>
  );
}

/** Who Happy writes as, and the repo agents start in. Saved when a field loses focus. */
function YouAndRepo({ s }: { s: AppSettings }) {
  const [p, setP] = useState(s.profile);
  const [repo, setRepo] = useState(s.repo);
  useEffect(() => setP(s.profile), [s.profile]);
  useEffect(() => setRepo(s.repo), [s.repo]);
  const save = () => void hub().saveSettings({ profile: p });
  const field = (k: keyof AppSettings["profile"], label: string, hint: string, placeholder: string) => (
    <div className="st-row">
      <div>
        <b>{label}</b>
        <span className="muted small">{hint}</span>
      </div>
      <input className="st-text" value={p[k]} placeholder={placeholder} onChange={(e) => setP({ ...p, [k]: e.target.value })} onBlur={save} spellCheck={false} />
    </div>
  );
  return (
    <section>
      <h2>You</h2>
      {field("name", "Name", "how drafts and helpers refer to you", "Alex")}
      {field("email", "Email", "defaults to your Gmail account", "alex@company.com")}
      {field("company", "Role", "context for drafts", "founder at Acme")}
      {field("signoff", "Sign-off", "how emails end", "Alex")}
      <div className="st-row st-col">
        <div>
          <b>Writing style</b>
          <span className="muted small">rules for email drafts, one per line</span>
        </div>
        <textarea className="st-text st-area" value={p.style} placeholder={"- Short and direct.\n- No em dashes."} onChange={(e) => setP({ ...p, style: e.target.value })} onBlur={save} />
      </div>
      <div className="st-row">
        <div>
          <b>Main repo</b>
          <span className="muted small">where new chats, Cloud fixes and task agents start; its project config drives deploys and Cloud</span>
        </div>
        <input className="st-text mono" value={repo} onChange={(e) => setRepo(e.target.value)} onBlur={() => void hub().saveSettings({ repo: repo.trim() })} spellCheck={false} />
      </div>
    </section>
  );
}

/** Session tags: what each means, and whether the agent keeps it up to date after each reply. */
function Tags({ s }: { s: AppSettings }) {
  const [tags, setTags] = useState<TagDef[]>(s.tags);
  useEffect(() => setTags(s.tags), [s.tags]);
  const save = (next = tags) => {
    const clean = next.map((t) => ({ ...t, name: t.name.replace(/^#/, "").trim().toLowerCase().replace(/\s+/g, "-"), description: t.description.trim() })).filter((t) => t.name);
    void hub().saveSettings({ tags: clean.filter((t, i) => clean.findIndex((x) => x.name === t.name) === i) });
  };
  const edit = (i: number, patch: Partial<TagDef>) => setTags(tags.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <section>
      <h2>Chats</h2>
      <div className="st-row">
        <div>
          <b>Next steps</b>
          <span className="muted small">after each reply, ask the same agent (out of sight) for 2–4 next steps to pick from</span>
        </div>
        <Toggle id="next-steps" on={s.nextSteps} onChange={(v) => void hub().saveSettings({ nextSteps: v })} />
      </div>
      <div className="st-row">
        <div>
          <b>Tag check</b>
          <span className="muted small">after each reply, the agent adds or removes the "auto" tags below; you see a line when they change</span>
        </div>
        <Toggle id="auto-tags" on={s.autoTags} onChange={(v) => void hub().saveSettings({ autoTags: v })} />
      </div>
      <div className="st-row st-col">
        <div>
          <b>Session tags</b>
          <span className="muted small">offered in every session's menu and the palette; filter with tag:name. The description is what the agent checks.</span>
        </div>
        <div className="tag-defs">
          {tags.map((t, i) => (
            <div key={i} className="tag-def">
              <input className="st-text mono" value={t.name} placeholder="name" onChange={(e) => edit(i, { name: e.target.value })} onBlur={() => save()} spellCheck={false} />
              <input className="st-text" value={t.description} placeholder="what it means, e.g. a migration that hasn't been applied" onChange={(e) => edit(i, { description: e.target.value })} onBlur={() => save()} />
              <label className="tag-auto" title="The agent adds and removes this tag after each reply">
                <input type="checkbox" checked={t.auto} onChange={(e) => save(tags.map((x, j) => (j === i ? { ...x, auto: e.target.checked } : x)))} /> auto
              </label>
              <button className="td-x" aria-label="Remove tag" onClick={() => save(tags.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <button className="kb" onClick={() => setTags([...tags, { name: "", description: "", auto: false }])}>
            + tag
          </button>
        </div>
      </div>
    </section>
  );
}

/** Codex API-equivalent prices (USD per 1M tokens): used to estimate Codex chats' cost. Refreshed daily from the web. */
function CodexPrices({ s }: { s: AppSettings }) {
  const [prices, setPrices] = useState<Record<string, { input: number; cached: number; output: number }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  useEffect(() => void hub().codexPrices().then(setPrices), [s.codexPrices]);
  if (!prices) return null;
  const edit = (slug: string, k: "input" | "cached" | "output", v: string) => {
    const n = Number(v);
    if (!isFinite(n) || n < 0) return;
    void hub().saveSettings({ codexPrices: { ...(s.codexPrices ?? {}), [slug]: { ...prices[slug], [k]: n } } });
  };
  return (
    <section>
      <h2>Codex prices</h2>
      <p className="muted small">
        API-equivalent USD per 1M tokens, used to estimate Codex cost (Codex on ChatGPT isn't billed per token). Updated {s.codexPricesAt ? new Date(s.codexPricesAt).toLocaleDateString() : "never"} ·{" "}
        <button
          className="link-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg(undefined);
            const ok = await hub().refreshCodexPrices().catch(() => false);
            setMsg(ok ? "updated from the web" : "couldn't find newer prices; kept these");
            setBusy(false);
          }}
        >
          {busy ? "looking up…" : "refresh now"}
        </button>
        {msg && <span> · {msg}</span>}
      </p>
      <table className="st-prices">
        <thead>
          <tr>
            <th>model</th>
            <th>input</th>
            <th>cached</th>
            <th>output</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(prices).map(([slug, p]) => (
            <tr key={slug}>
              <td className="mono">{slug}</td>
              {(["input", "cached", "output"] as const).map((k) => (
                <td key={k}>
                  <input key={`${slug}-${k}-${p[k]}`} defaultValue={p[k]} onBlur={(e) => edit(slug, k, e.target.value)} inputMode="decimal" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** App settings: which sections show, where agents get max permissions, default engine/models. */
export function SettingsView() {
  const s = useSettings();
  const codex = useCodexModels();
  const cursor = useCursorModels();
  if (!s) return <div className="muted pad center mono small">loading…</div>;
  const save = (patch: Partial<AppSettings>) => void hub().saveSettings(patch);
  const modelOptions = (e: Engine): Array<{ id: string; label: string }> =>
    e === "claude"
      ? CLAUDE_MODELS.filter((m) => m.id).map((m) => ({ id: m.id!, label: m.label }))
      : e === "codex"
        ? (codex?.models ?? []).map((m) => ({ id: m.slug, label: m.name ?? m.slug }))
        : (cursor ?? []).map((m) => ({ id: m.id, label: m.name }));

  return (
    <div className="st">
      <div className="st-inner">
        <h1>Settings</h1>

        <YouAndRepo s={s} />

        <Tags s={s} />

        <PhoneAccess />

        <RestartApp />

        <ImportChats />

        <CodexPrices s={s} />

        <section>
          <h2>Sidebar</h2>
          {SECTIONS.map((x) => (
            <div key={x.key} className="st-row">
              <div>
                <b>{x.label}</b>
                <span className="muted small">{x.hint}</span>
              </div>
              <Toggle id={`show-${x.key}`} on={s.show[x.key]} onChange={(v) => save({ show: { ...s.show, [x.key]: v } })} />
            </div>
          ))}
        </section>

        <section>
          <h2>Max permissions</h2>
          <p className="muted small">On: Claude runs in bypass mode, Codex with full access, Cursor in full mode. Off: they ask before edits and commands.</p>
          {BYPASS.map((x) => (
            <div key={x.key} className="st-row">
              <div>
                <b>{x.label}</b>
                <span className="muted small">{x.hint}</span>
              </div>
              <Toggle id={`bypass-${x.key}`} on={s.bypass[x.key]} onChange={(v) => save({ bypass: { ...s.bypass, [x.key]: v } })} />
            </div>
          ))}
        </section>

        <section>
          <h2>Defaults</h2>
          <div className="st-row">
            <div>
              <b>Provider</b>
              <span className="muted small">for new chats and task agents</span>
            </div>
            <div className="tk-seg">
              {ENGINES.map((e) => (
                <button key={e} className={s.defaultEngine === e ? "on" : ""} onClick={() => save({ defaultEngine: e })}>
                  {e}
                </button>
              ))}
            </div>
          </div>
          {ENGINES.map((e) => (
            <div key={e} className="st-row">
              <div>
                <b>{e} model</b>
                <span className="muted small">{e === "claude" ? "also used by the Manager and Cloud chats" : `default for new ${e} sessions`}</span>
              </div>
              <select id={`model-${e}`} value={s.models[e] ?? ""} onChange={(x) => save({ models: { ...s.models, [e]: x.target.value || undefined } })}>
                <option value="">{e}'s default</option>
                {modelOptions(e).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="st-row">
            <div>
              <b>Helper model</b>
              <span className="muted small">email drafts, zero inbox, events from text, board summaries, simplify</span>
            </div>
            <select id="helper-model" value={s.helperModel} onChange={(x) => save({ helperModel: x.target.value })}>
              {CLAUDE_MODELS.filter((m) => m.id).map((m) => (
                <option key={m.id} value={m.id!}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </section>
      </div>
    </div>
  );
}
