import { existsSync, readFileSync } from "node:fs";
import type { CalendarEvent, LinearIssue, EmailThreadDetail, Inbox, CloudSnapshot, EngineLimits, ErrorGroup, GcloudStatus, NextStep, Routine, SessionProcess, TenantErrors } from "../shared/types.js";

/**
 * Demo mode (SESSION_HUB_DEMO=<demo.json>): Happy runs against a separate data folder with made-up sessions, and
 * everything that would reach your accounts (Cloud, gcloud, plan limits, routines, AI calls) comes from the file
 * instead. For README screenshots; see scripts/demo/.
 */
export interface DemoData {
  /** Data folder for this run (sessions, settings), separate from your real one. */
  dataDir: string;
  cloud?: CloudSnapshot;
  gcp?: { tenants: TenantErrors[]; groups: ErrorGroup[] };
  limits?: EngineLimits;
  gcloud?: GcloudStatus;
  routines?: Routine[];
  /** Board one-liners: by session title, branch, or error signature. */
  summaries?: Record<string, string>;
  headline?: string;
  /** Per session title. */
  nextSteps?: Record<string, NextStep[]>;
  status?: Record<string, "running" | "needs_permission">;
  processes?: Record<string, SessionProcess[]>;
  /** Mail: a made-up inbox and threads (nothing is sent, saved or archived). */
  mail?: { email: string; inbox: Inbox; threads: Record<string, EmailThreadDetail>; drafts?: Record<string, string> };
  /** Calendar events and Linear issues (made up). */
  calendar?: CalendarEvent[];
  linear?: { name: string; email: string; issues: LinearIssue[] };
  /** Screenshot run: where to save, and the window size. */
  shots?: { dir: string };
}

const file = process.env.SESSION_HUB_DEMO;
export const demo: DemoData | undefined = file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as DemoData) : undefined;
