import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The Tailscale CLI: Homebrew/PATH, or the one inside the Mac app. */
export function tailscaleBinary(): string | undefined {
  for (const p of ["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) if (existsSync(p)) return p;
  return undefined;
}

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  /** e.g. zs-macbook.tail1234.ts.net */
  dnsName?: string;
  login?: string;
  error?: string;
}

export async function tailscaleStatus(): Promise<TailscaleStatus> {
  const bin = tailscaleBinary();
  if (!bin) return { installed: false, running: false };
  try {
    const { stdout } = await run(bin, ["status", "--json"], { timeout: 10_000 });
    const j = JSON.parse(stdout);
    const self = j.Self ?? {};
    const user = j.User?.[String(self.UserID)] ?? Object.values(j.User ?? {})[0];
    return {
      installed: true,
      running: j.BackendState === "Running",
      dnsName: String(self.DNSName ?? "").replace(/\.$/, "") || undefined,
      login: (user as any)?.LoginName,
      error: j.BackendState !== "Running" ? `Tailscale is ${String(j.BackendState).toLowerCase()}; open the Tailscale app and sign in.` : undefined,
    };
  } catch (e) {
    return { installed: true, running: false, error: String((e as any).stderr || (e as Error).message).trim().split("\n")[0] };
  }
}

/** Publish (or stop publishing) a local port to your tailnet over HTTPS at https://<machine>.<tailnet>.ts.net */
export async function tailscaleServe(port: number, on: boolean): Promise<{ ok: boolean; message?: string }> {
  const bin = tailscaleBinary();
  if (!bin) return { ok: false, message: "Tailscale isn't installed" };
  try {
    const args = on ? ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`] : ["serve", "--https=443", "off"];
    const { stdout, stderr } = await run(bin, args, { timeout: 30_000 });
    return { ok: true, message: `${stdout}${stderr}`.trim() || undefined };
  } catch (e) {
    // Common first-time case: HTTPS certificates aren't enabled for the tailnet; Tailscale prints the admin link.
    const out = `${(e as any).stdout ?? ""}${(e as any).stderr ?? ""}`.trim() || (e as Error).message;
    return { ok: false, message: out.split("\n").slice(0, 4).join(" ") };
  }
}
