import { execFile, spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GcloudStatus } from "../shared/types.js";

const run = promisify(execFile);

/** Exit code only — token output is discarded, never stored or shown. */
async function succeeds(args: string[]): Promise<boolean> {
  try {
    await run("gcloud", args, { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

export async function gcloudStatus(): Promise<GcloudStatus> {
  let account: string | undefined;
  try {
    account = (await run("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { timeout: 15_000 })).stdout.trim() || undefined;
  } catch {
    return { installed: false, userOk: false, adcOk: false, checkedAt: Date.now() };
  }
  const [userOk, adcOk] = await Promise.all([
    account ? succeeds(["auth", "print-access-token", "--quiet"]) : Promise.resolve(false),
    succeeds(["auth", "application-default", "print-access-token", "--quiet"]),
  ]);
  return { installed: true, account, userOk, adcOk, checkedAt: Date.now() };
}

/**
 * A BROWSER helper for gcloud: instead of opening the default browser, it hands the sign-in URL to Happy
 * (which shows it in its own window). gcloud's local redirect server then completes the login by itself.
 */
export function writeBrowserHelper(dir: string, port: number, token: string): string {
  const path = join(dir, "happy-open-url.sh");
  writeFileSync(
    path,
    `#!/bin/sh\n# Opens a URL in Happy's sign-in window (used as BROWSER for gcloud auth).\ncurl -s -o /dev/null -X POST -H "Authorization: Bearer ${token}" --data-urlencode "url=$1" "http://127.0.0.1:${port}/open-url"\n`,
  );
  chmodSync(path, 0o700);
  return path;
}

/** Run `gcloud auth login` or `gcloud auth application-default login`, streaming its output. */
export function gcloudLogin(kind: "user" | "adc", browserHelper: string, onLine: (line: string) => void): Promise<boolean> {
  const args = kind === "user" ? ["auth", "login", "--launch-browser"] : ["auth", "application-default", "login", "--launch-browser"];
  return new Promise((resolve) => {
    const child = spawn("gcloud", args, { env: { ...process.env, BROWSER: browserHelper }, stdio: ["ignore", "pipe", "pipe"] });
    const emit = (d: Buffer) =>
      String(d)
        .split("\n")
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .forEach(onLine);
    child.stdout.on("data", emit);
    child.stderr.on("data", emit);
    const timer = setTimeout(() => child.kill("SIGTERM"), 5 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      onLine(`couldn't run gcloud: ${e.message}`);
      resolve(false);
    });
  });
}
