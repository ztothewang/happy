import { safeStorage } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinearIssue, LinearIssueDetail, LinearIssueInput, LinearMeta, LinearStatus, TaskScope } from "../shared/types.js";

const API = "https://api.linear.app/graphql";

/**
 * Direct Linear GraphQL client. The personal API key is encrypted with the OS keychain (Electron safeStorage)
 * and stored in Happy's data folder; it is only ever sent to api.linear.app.
 */
const ISSUE_FIELDS = `id identifier title priority priorityLabel url branchName createdAt updatedAt dueDate estimate
  state { name type color } assignee { name } project { name } parent { identifier } team { key }
  labels { nodes { name color } }`;

function toIssue(n: any): LinearIssue {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    priority: n.priority,
    priorityLabel: n.priorityLabel,
    url: n.url,
    branchName: n.branchName,
    createdAt: Date.parse(n.createdAt),
    updatedAt: Date.parse(n.updatedAt),
    dueDate: n.dueDate ?? undefined,
    estimate: n.estimate ?? undefined,
    status: n.state?.name ?? "",
    statusType: n.state?.type ?? "",
    statusColor: n.state?.color,
    assignee: n.assignee?.name,
    project: n.project?.name,
    parent: n.parent?.identifier,
    team: n.team?.key,
    labels: (n.labels?.nodes ?? []).map((l: any) => ({ name: l.name, color: l.color })),
  };
}

export class Linear {
  private key?: string;
  private viewer?: { name: string; email: string };
  private file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "linear-key.bin");
    try {
      if (existsSync(this.file) && safeStorage.isEncryptionAvailable()) this.key = safeStorage.decryptString(readFileSync(this.file));
    } catch {
      this.key = undefined;
    }
  }

  private async gql<T = any>(query: string, variables: Record<string, unknown> = {}, key = this.key): Promise<T> {
    if (!key) throw new Error("Linear isn't connected");
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (res.status === 401 || body.errors?.some((e: any) => /auth/i.test(e.extensions?.code ?? e.message))) throw new Error("Linear rejected the API key");
    if (!res.ok || body.errors) throw new Error(body.errors?.[0]?.message ?? `Linear HTTP ${res.status}`);
    return body.data as T;
  }

  async status(): Promise<LinearStatus> {
    if (!this.key) return { connected: false };
    try {
      this.viewer ??= (await this.gql<{ viewer: { name: string; email: string } }>("{ viewer { name email } }")).viewer;
      return { connected: true, name: this.viewer.name, email: this.viewer.email };
    } catch (e) {
      return { connected: false, error: (e as Error).message };
    }
  }

  /** Validate, then store (encrypted). */
  async setKey(key: string): Promise<LinearStatus> {
    const k = key.trim();
    const v = (await this.gql<{ viewer: { name: string; email: string } }>("{ viewer { name email } }", {}, k)).viewer;
    if (!safeStorage.isEncryptionAvailable()) throw new Error("The OS keychain isn't available to encrypt the key");
    writeFileSync(this.file, safeStorage.encryptString(k), { mode: 0o600 });
    this.key = k;
    this.viewer = v;
    return { connected: true, name: v.name, email: v.email };
  }

  clearKey() {
    this.key = undefined;
    this.viewer = undefined;
    rmSync(this.file, { force: true });
  }

  /** Open issues plus ones closed (done / canceled / duplicate) in the last 30 days, so the status filter can show them. */
  async openIssues(scope: TaskScope): Promise<LinearIssue[]> {
    const filter: Record<string, unknown> = {
      or: [{ state: { type: { nin: ["completed", "canceled"] } } }, { and: [{ state: { type: { in: ["completed", "canceled"] } } }, { updatedAt: { gt: "-P30D" } }] }],
    };
    if (scope === "mine") filter.assignee = { isMe: { eq: true } };
    const out: LinearIssue[] = [];
    let after: string | undefined;
    for (let page = 0; page < 8; page++) {
      const d = await this.gql(
        `query($filter: IssueFilter, $after: String) {
          issues(first: 100, after: $after, filter: $filter, orderBy: updatedAt) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter, after },
      );
      for (const n of d.issues.nodes) out.push(toIssue(n));
      if (!d.issues.pageInfo.hasNextPage) break;
      after = d.issues.pageInfo.endCursor;
    }
    return out;
  }

  private metaCache?: { at: number; meta: LinearMeta };

  /** Teams (with workflow states, members, labels) and open projects, for the edit form. Cached 10 min. */
  async meta(): Promise<LinearMeta> {
    if (this.metaCache && Date.now() - this.metaCache.at < 10 * 60_000) return this.metaCache.meta;
    // Small separate queries: one nested query (teams × members × labels × projects) exceeds Linear's complexity limit.
    const head = await this.gql(`{ viewer { id } teams(first: 25) { nodes { id key name states { nodes { id name type color position } } } } }`);
    const teams = await Promise.all(
      head.teams.nodes.map(async (t: any) => {
        const [m, l] = await Promise.all([
          this.gql(`query($id: String!) { team(id: $id) { members(first: 100) { nodes { id name displayName } } } }`, { id: t.id }),
          this.gql(`query($id: String!) { team(id: $id) { labels(first: 100) { nodes { id name color } } } }`, { id: t.id }),
        ]);
        return {
          id: t.id,
          key: t.key,
          name: t.name,
          states: [...t.states.nodes].sort((a: any, b: any) => a.position - b.position).map((x: any) => ({ id: x.id, name: x.name, type: x.type, color: x.color })),
          members: m.team.members.nodes.map((x: any) => ({ id: x.id, name: x.displayName || x.name })),
          labels: l.team.labels.nodes.map((x: any) => ({ id: x.id, name: x.name, color: x.color })).sort((a: any, b: any) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
        };
      }),
    );
    const pr = await this.gql(`{ projects(first: 100) { nodes { id name completedAt canceledAt archivedAt teams(first: 10) { nodes { id } } } } }`);
    const meta: LinearMeta = {
      viewerId: head.viewer.id,
      teams,
      projects: pr.projects.nodes
        .filter((p: any) => !p.completedAt && !p.canceledAt && !p.archivedAt)
        .map((p: any) => ({ id: p.id, name: p.name, teamIds: p.teams.nodes.map((t: any) => t.id) })),
    };
    this.metaCache = { at: Date.now(), meta };
    return meta;
  }

  private writeError(e: unknown): never {
    const m = (e as Error).message;
    throw new Error(/permission|scope|forbidden|not authorized/i.test(m) ? "Your Linear key is read-only. Create a key with write access and reconnect." : m);
  }

  /** Save edits; returns the issue as it is now (so the board can update just that row). */
  async updateIssue(id: string, input: LinearIssueInput): Promise<LinearIssue> {
    const d = await this.gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`, { id, input }).catch((e) =>
      this.writeError(e),
    );
    if (!d.issueUpdate.success) throw new Error("Linear didn't save the change");
    return toIssue(d.issueUpdate.issue);
  }

  async createIssue(input: LinearIssueInput): Promise<{ id: string; identifier: string; url: string }> {
    if (!input.teamId || !input.title?.trim()) throw new Error("A team and a title are required");
    const d = await this.gql(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`, { input }).catch((e) => this.writeError(e));
    if (!d.issueCreate.success) throw new Error("Linear didn't create the issue");
    return d.issueCreate.issue;
  }

  async issueDetail(id: string): Promise<LinearIssueDetail> {
    const d = await this.gql(
      `query($id: String!) {
        issue(id: $id) {
          identifier description creator { name }
          team { id } state { id } assignee { id } project { id } labels { nodes { id } }
          comments(first: 50) { nodes { body createdAt user { name } } }
          attachments(first: 20) { nodes { title url } }
          children(first: 30) { nodes { identifier title state { name type } } }
        }
      }`,
      { id },
    );
    const i = d.issue;
    return {
      identifier: i.identifier,
      description: i.description ?? "",
      creator: i.creator?.name,
      teamId: i.team?.id,
      stateId: i.state?.id,
      assigneeId: i.assignee?.id,
      projectId: i.project?.id,
      labelIds: (i.labels?.nodes ?? []).map((l: any) => l.id),
      comments: (i.comments?.nodes ?? [])
        .map((c: any) => ({ author: c.user?.name ?? "someone", body: c.body, createdAt: Date.parse(c.createdAt) }))
        .sort((a: any, b: any) => a.createdAt - b.createdAt),
      attachments: (i.attachments?.nodes ?? []).map((a: any) => ({ title: a.title, url: a.url })),
      children: (i.children?.nodes ?? []).map((c: any) => ({ identifier: c.identifier, title: c.title, status: c.state?.name, done: ["completed", "canceled"].includes(c.state?.type) })),
    };
  }
}

/** The first message for an agent picking up an issue. */
export function taskPrompt(issue: LinearIssue, detail: LinearIssueDetail): string {
  const parts = [
    `Work on Linear issue ${issue.identifier}: ${issue.title}`,
    `Link: ${issue.url}`,
    [`Priority: ${issue.priorityLabel}`, `Status: ${issue.status}`, issue.project && `Project: ${issue.project}`, issue.labels.length && `Labels: ${issue.labels.map((l) => l.name).join(", ")}`]
      .filter(Boolean)
      .join(" · "),
    detail.description.trim() ? `## Description\n${detail.description.trim()}` : "(No description.)",
  ];
  if (detail.children.length) parts.push(`## Sub-issues\n${detail.children.map((c) => `- ${c.identifier} ${c.title} (${c.status})`).join("\n")}`);
  if (detail.comments.length) parts.push(`## Comments\n${detail.comments.map((c) => `**${c.author}:** ${c.body.trim()}`).join("\n\n")}`);
  if (detail.attachments.length) parts.push(`## Attachments\n${detail.attachments.map((a) => `- ${a.title}: ${a.url}`).join("\n")}`);
  parts.push(
    `Investigate first, then implement following the repo's instructions (AGENTS.md / CLAUDE.md). Mention ${issue.identifier} in your commit messages. ` +
      `If the issue is ambiguous, ask me before building. When you're done, summarize what changed and what's left.`,
  );
  return parts.join("\n\n");
}
