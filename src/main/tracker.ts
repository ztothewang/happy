import type { LinearIssue, LinearIssueDetail, LinearIssueInput, LinearMeta, LinearStatus, TaskScope } from "../shared/types.js";

/**
 * Where tasks come from: Linear or GitHub Issues (Tasks page toggle). Both speak the same issue shape, so the board,
 * the edit form, comments and "hand to an agent" work the same for either.
 */
export interface Tracker {
  /** Shown in the UI and prompts ("Linear", "GitHub"). */
  readonly label: string;
  status(): Promise<LinearStatus>;
  openIssues(scope: TaskScope): Promise<LinearIssue[]>;
  meta(): Promise<LinearMeta>;
  updateIssue(id: string, input: LinearIssueInput): Promise<LinearIssue>;
  createIssue(input: LinearIssueInput): Promise<{ id: string; identifier: string; url: string }>;
  addComment(issueId: string, body: string): Promise<void>;
  editComment(id: string, body: string): Promise<void>;
  deleteComment(id: string): Promise<void>;
  issueDetail(id: string): Promise<LinearIssueDetail>;
  /** Swap links the agent can't open (private uploads) for local copies. */
  localizeUploads(text: string): Promise<string>;
}

/** The first message for an agent picking up an issue. */
export function taskPrompt(issue: LinearIssue, detail: LinearIssueDetail, source: string): string {
  const parts = [
    `Work on ${source} issue ${issue.identifier}: ${issue.title}`,
    `Link: ${issue.url}`,
    issue.parent && `Sub-issue of ${issue.parent}${issue.parentTitle ? `: ${issue.parentTitle}` : ""} (keep the change to this part of it).`,
    [`Priority: ${issue.priorityLabel}`, `Status: ${issue.status}`, issue.project && `Project: ${issue.project}`, issue.labels.length && `Labels: ${issue.labels.map((l) => l.name).join(", ")}`]
      .filter(Boolean)
      .join(" · "),
    detail.description.trim() ? `## Description\n${detail.description.trim()}` : "(No description.)",
  ].filter((x): x is string => !!x);
  if (detail.children.length) parts.push(`## Sub-issues\n${detail.children.map((c) => `- ${c.identifier} ${c.title} (${c.status})`).join("\n")}`);
  if (detail.comments.length) parts.push(`## Comments\n${detail.comments.map((c) => `**${c.author}:** ${c.body.trim()}`).join("\n\n")}`);
  if (detail.attachments.length) parts.push(`## Attachments\n${detail.attachments.map((a) => `- ${a.title}: ${a.url}`).join("\n")}`);
  parts.push(
    [
      "## How to work",
      "1. Investigate first. Where the issue depends on real data or behavior, check the primary sources (the database, logs, the data sources involved) instead of guessing from the code alone.",
      "2. If the task is unclear or there's more than one reasonable reading, ask me clarifying questions before building. Don't assume.",
      `3. Implement following the repo's instructions (AGENTS.md / CLAUDE.md). Mention ${issue.identifier} in your commit messages.`,
      "4. Once the code is done, spawn an expert code-review subagent to review the change for best practices, bugs, breaking changes and test coverage, then revise based on what it finds. (If you can't spawn subagents, do that review as a separate, deliberate pass yourself.)",
      "5. When you're done, summarize what changed, what the review caught, and what's left.",
    ].join("\n"),
  );
  return parts.join("\n\n");
}
