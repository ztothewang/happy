import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { LinearIssue, LinearIssueDetail, LinearIssueInput, LinearMeta, LinearStatus, TaskScope } from "../shared/types.js";
import type { Tracker } from "./tracker.js";

const run = promisify(execFile);
const API = "https://api.github.com";

/**
 * GitHub Issues as a task source. Signs in with the GitHub CLI (`gh auth login`), so there's no key to paste or
 * store: Happy asks `gh auth token` for the token and only sends it to api.github.com.
 *
 * GitHub has no workflow states or priorities, so they live in labels: `status: <name>` (Backlog, Todo, In Progress,
 * In Review…) for open issues and `priority: urgent|high|medium|low`. Closed issues map by close reason: completed →
 * Done, not planned → Canceled, duplicate → Duplicate. Milestones stand in for projects.
 */
const PRIORITY = ["", "urgent", "high", "medium", "low"];
const STATUS_ORDER = ["backlog", "todo", "in progress", "in review"];
const STATUS_TYPE: Record<string, string> = { backlog: "backlog", todo: "unstarted", "in progress": "started", "in review": "started" };
const STATUS_COLOR: Record<string, string> = { backlog: "#95a2b3", todo: "#b4befe", "in progress": "#5e9bff", "in review": "#7fd4c8", open: "#b4befe" };
const CLOSED = [
  { id: "closed:completed", name: "Done", type: "completed", reason: "completed", color: "#8b9ee8" },
  { id: "closed:not_planned", name: "Canceled", type: "canceled", reason: "not_planned", color: "#9aa3ae" },
  { id: "closed:duplicate", name: "Duplicate", type: "canceled", reason: "duplicate", color: "#9aa3ae" },
];
const isStatus = (l: string) => /^status:\s*/i.test(l);
const isPriority = (l: string) => /^priority:\s*/i.test(l);
const statusName = (l: string) => l.replace(/^status:\s*/i, "");

const ISSUE_FIELDS = `number title url state stateReason createdAt updatedAt
  parent { number title } assignees(first: 5) { nodes { login name } } milestone { number title } labels(first: 30) { nodes { name color } }`;

/** "owner/repo" from a git remote URL (https or ssh), if it's on GitHub. */
export function githubRepoOf(remote: string): string | undefined {
  return remote.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i)?.[1];
}

async function gh(args: string[], cwd?: string): Promise<string> {
  const bin = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find(existsSync) ?? "gh";
  return (await run(bin, args, { cwd, timeout: 15_000 })).stdout.trim();
}

export class GitHubIssues implements Tracker {
  readonly label = "GitHub";
  private token?: string;
  private viewer?: { login: string; name?: string };

  /** where(): the repo set on the Tasks page ("owner/repo"), and the main repo checkout whose origin is the fallback. */
  constructor(private where: () => { repo: string; mainRepo: string }) {}

  /** The "owner/repo" whose issues these are. */
  async repoOf(): Promise<string | undefined> {
    const { repo, mainRepo } = this.where();
    if (repo.trim()) return repo.trim();
    if (!mainRepo) return undefined;
    return githubRepoOf(await run("git", ["-C", mainRepo, "remote", "get-url", "origin"]).then((r) => r.stdout, () => ""));
  }

  private async repo(): Promise<{ owner: string; name: string; full: string }> {
    const full = await this.repoOf();
    if (!full) throw new Error("No GitHub repo: set one on the Tasks page, or pick a main repo whose origin is on GitHub");
    const [owner, name] = full.split("/");
    return { owner, name, full };
  }

  private async auth(): Promise<string> {
    this.token ??= await gh(["auth", "token"]).catch(() => {
      throw new Error("Sign in to the GitHub CLI first: run `gh auth login` in a terminal");
    });
    return this.token;
  }

  private async rest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${await this.auth()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) this.token = undefined;
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(res.status === 401 ? "GitHub rejected the CLI's token: run `gh auth login` again" : `GitHub: ${j.message ?? `HTTP ${res.status}`}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  private async gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const d = await this.rest<{ data?: T; errors?: Array<{ message: string }> }>("POST", "/graphql", { query, variables });
    if (d.errors?.length) throw new Error(`GitHub: ${d.errors[0].message}`);
    return d.data as T;
  }

  private toIssue(n: any, repo: string): LinearIssue {
    const labels: Array<{ name: string; color: string }> = (n.labels?.nodes ?? []).map((l: any) => ({ name: l.name, color: `#${l.color}` }));
    const pr = labels.filter((l) => isPriority(l.name)).map((l) => PRIORITY.indexOf(l.name.replace(/^priority:\s*/i, "").toLowerCase())).find((x) => x > 0) ?? 0;
    const st = labels.find((l) => isStatus(l.name));
    const closed = n.state === "CLOSED" ? (CLOSED.find((c) => c.reason === String(n.stateReason ?? "").toLowerCase()) ?? CLOSED[0]) : undefined;
    const open = st ? statusName(st.name) : "Open";
    const a = n.assignees?.nodes?.[0];
    return {
      id: String(n.number),
      identifier: `#${n.number}`,
      title: n.title,
      priority: pr,
      priorityLabel: pr ? PRIORITY[pr][0].toUpperCase() + PRIORITY[pr].slice(1) : "No priority",
      url: n.url,
      createdAt: Date.parse(n.createdAt),
      updatedAt: Date.parse(n.updatedAt),
      status: closed?.name ?? open,
      statusType: closed?.type ?? STATUS_TYPE[open.toLowerCase()] ?? "unstarted",
      statusColor: closed?.color ?? STATUS_COLOR[open.toLowerCase()] ?? STATUS_COLOR.open,
      assignee: a ? a.name || a.login : undefined,
      project: n.milestone?.title,
      parent: n.parent ? `#${n.parent.number}` : undefined,
      parentTitle: n.parent?.title,
      parentId: n.parent ? String(n.parent.number) : undefined,
      team: repo.split("/")[1],
      labels: labels.filter((l) => !isStatus(l.name) && !isPriority(l.name)),
    };
  }

  async status(): Promise<LinearStatus> {
    try {
      const { full } = await this.repo();
      this.viewer ??= (await this.gql<{ viewer: { login: string; name?: string } }>("{ viewer { login name } }")).viewer;
      return { connected: true, name: this.viewer.name || this.viewer.login, email: full, repo: full };
    } catch (e) {
      return { connected: false, error: (e as Error).message, repo: await this.repoOf().catch(() => undefined) };
    }
  }

  /** Open issues plus ones closed in the last 30 days, so the status filter can show them. */
  async openIssues(scope: TaskScope): Promise<LinearIssue[]> {
    const { owner, name, full } = await this.repo();
    const me = scope === "mine" ? (this.viewer ??= (await this.gql("{ viewer { login name } }")).viewer).login : undefined;
    const out: LinearIssue[] = [];
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    for (const [states, filter] of [
      ["OPEN", {}],
      ["CLOSED", { since }],
    ] as const) {
      let after: string | undefined;
      for (let page = 0; page < 8; page++) {
        const d = await this.gql(
          `query($owner: String!, $name: String!, $states: [IssueState!], $filter: IssueFilters, $after: String) {
            repository(owner: $owner, name: $name) {
              issues(first: 100, after: $after, states: $states, filterBy: $filter, orderBy: { field: UPDATED_AT, direction: DESC }) {
                nodes { ${ISSUE_FIELDS} }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`,
          { owner, name, states: [states], filter: { ...filter, ...(me ? { assignee: me } : {}) }, after },
        );
        const c = d.repository.issues;
        for (const n of c.nodes) out.push(this.toIssue(n, full));
        if (!c.pageInfo.hasNextPage) break;
        after = c.pageInfo.endCursor;
      }
    }
    return out;
  }

  private metaCache?: { at: number; repo: string; meta: LinearMeta };

  /** The repo as the form's one "team": statuses (from status labels), assignable people, labels; milestones as projects. Cached 10 min. */
  async meta(): Promise<LinearMeta> {
    const { owner, name, full } = await this.repo();
    if (this.metaCache?.repo === full && Date.now() - this.metaCache.at < 10 * 60_000) return this.metaCache.meta;
    const d = await this.gql(
      `query($owner: String!, $name: String!) {
        viewer { login }
        repository(owner: $owner, name: $name) {
          assignableUsers(first: 100) { nodes { login name } }
          labels(first: 100) { nodes { name color } }
          milestones(first: 50, states: OPEN) { nodes { number title } }
        }
      }`,
      { owner, name },
    );
    const r = d.repository;
    const all: Array<{ name: string; color: string }> = r.labels.nodes;
    const statuses = all
      .filter((l) => isStatus(l.name))
      .map((l) => statusName(l.name))
      .sort((a, b) => (STATUS_ORDER.indexOf(a.toLowerCase()) + 1 || 99) - (STATUS_ORDER.indexOf(b.toLowerCase()) + 1 || 99));
    const meta: LinearMeta = {
      viewerId: d.viewer.login,
      teams: [
        {
          id: full,
          key: name,
          name: full,
          states: [
            ...(statuses.length ? statuses : ["Open"]).map((s) => ({ id: `open:${s}`, name: s, type: STATUS_TYPE[s.toLowerCase()] ?? "unstarted", color: STATUS_COLOR[s.toLowerCase()] ?? STATUS_COLOR.open })),
            ...CLOSED.map((c) => ({ id: c.id, name: c.name, type: c.type, color: c.color })),
          ],
          members: r.assignableUsers.nodes.map((u: any) => ({ id: u.login, name: u.name || u.login })),
          labels: all
            .filter((l) => !isStatus(l.name) && !isPriority(l.name))
            .map((l) => ({ id: l.name, name: l.name, color: `#${l.color}` }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
        },
      ],
      projects: r.milestones.nodes.map((m: any) => ({ id: String(m.number), name: m.title, teamIds: [full] })),
    };
    this.metaCache = { at: Date.now(), repo: full, meta };
    return meta;
  }

  /** The form's fields as a GitHub issue payload. `current` = the issue's labels now (status/priority labels are swapped, the rest kept). */
  private payload(input: LinearIssueInput, current: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (input.title !== undefined) out.title = input.title;
    if (input.description !== undefined) out.body = input.description;
    if (input.assigneeId !== undefined) out.assignees = input.assigneeId ? [input.assigneeId] : [];
    if (input.projectId !== undefined) out.milestone = input.projectId ? Number(input.projectId) : null;
    let labels = input.labelIds ? [...input.labelIds, ...current.filter((l) => isStatus(l) || isPriority(l))] : [...current];
    if (input.priority !== undefined) labels = [...labels.filter((l) => !isPriority(l)), ...(input.priority ? [`priority: ${PRIORITY[input.priority]}`] : [])];
    if (input.stateId) {
      const closed = CLOSED.find((c) => c.id === input.stateId);
      labels = labels.filter((l) => !isStatus(l));
      if (closed) Object.assign(out, { state: "closed", state_reason: closed.reason });
      else {
        out.state = "open";
        const s = input.stateId.replace(/^open:/, "");
        if (s && s !== "Open") labels.push(`status: ${s}`);
      }
    }
    if (input.labelIds || input.priority !== undefined || input.stateId) out.labels = labels;
    return out;
  }

  private async one(number: number): Promise<LinearIssue> {
    const { owner, name, full } = await this.repo();
    const d = await this.gql(`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { issue(number: $n) { ${ISSUE_FIELDS} } } }`, { owner, name, n: number });
    return this.toIssue(d.repository.issue, full);
  }

  async updateIssue(id: string, input: LinearIssueInput): Promise<LinearIssue> {
    const { full } = await this.repo();
    const now = await this.rest<{ labels: Array<{ name: string }> }>("GET", `/repos/${full}/issues/${Number(id)}`);
    await this.rest("PATCH", `/repos/${full}/issues/${Number(id)}`, this.payload(input, now.labels.map((l) => l.name)));
    return this.one(Number(id));
  }

  async createIssue(input: LinearIssueInput): Promise<{ id: string; identifier: string; url: string }> {
    if (!input.title?.trim()) throw new Error("A title is required");
    const { full } = await this.repo();
    // New issues start open (closing one at creation isn't a thing on GitHub).
    const stateId = input.stateId && !input.stateId.startsWith("closed:") ? input.stateId : undefined;
    const { state: _s, state_reason: _r, ...body } = this.payload({ ...input, stateId, labelIds: input.labelIds ?? [] }, []);
    const r = await this.rest<{ number: number; html_url: string }>("POST", `/repos/${full}/issues`, body);
    return { id: String(r.number), identifier: `#${r.number}`, url: r.html_url };
  }

  async addComment(issueId: string, body: string) {
    const { full } = await this.repo();
    await this.rest("POST", `/repos/${full}/issues/${Number(issueId)}/comments`, { body });
  }
  async editComment(id: string, body: string) {
    const { full } = await this.repo();
    await this.rest("PATCH", `/repos/${full}/issues/comments/${id}`, { body });
  }
  async deleteComment(id: string) {
    const { full } = await this.repo();
    await this.rest("DELETE", `/repos/${full}/issues/comments/${id}`);
  }

  async issueDetail(id: string): Promise<LinearIssueDetail> {
    const { owner, name, full } = await this.repo();
    const d = await this.gql(
      `query($owner: String!, $name: String!, $n: Int!) {
        repository(owner: $owner, name: $name) {
          issue(number: $n) {
            number body state stateReason author { login }
            assignees(first: 5) { nodes { login } } milestone { number } labels(first: 30) { nodes { name } }
            comments(first: 100) { nodes { databaseId body createdAt lastEditedAt viewerDidAuthor author { login } } }
            subIssues(first: 30) { nodes { number title state stateReason labels(first: 20) { nodes { name } } } }
          }
        }
      }`,
      { owner, name, n: Number(id) },
    );
    const i = d.repository.issue;
    const labels: string[] = i.labels.nodes.map((l: any) => l.name);
    const st = labels.find(isStatus);
    const closed = i.state === "CLOSED" ? (CLOSED.find((c) => c.reason === String(i.stateReason ?? "").toLowerCase()) ?? CLOSED[0]) : undefined;
    return {
      identifier: `#${i.number}`,
      description: i.body ?? "",
      creator: i.author?.login,
      teamId: full,
      stateId: closed?.id ?? `open:${st ? statusName(st) : "Open"}`,
      assigneeId: i.assignees.nodes[0]?.login,
      projectId: i.milestone ? String(i.milestone.number) : undefined,
      labelIds: labels.filter((l) => !isStatus(l) && !isPriority(l)),
      comments: i.comments.nodes.map((c: any) => ({
        id: String(c.databaseId),
        author: c.author?.login ?? "someone",
        mine: !!c.viewerDidAuthor,
        body: c.body,
        createdAt: Date.parse(c.createdAt),
        edited: !!c.lastEditedAt,
      })),
      attachments: [],
      children: i.subIssues.nodes.map((c: any) => {
        const cs = c.labels.nodes.map((l: any) => l.name).find(isStatus);
        const done = c.state === "CLOSED";
        return { identifier: `#${c.number}`, title: c.title, status: done ? (CLOSED.find((x) => x.reason === String(c.stateReason ?? "").toLowerCase()) ?? CLOSED[0]).name : cs ? statusName(cs) : "Open", done };
      }),
    };
  }

  /** GitHub links open fine for agents with `gh`; nothing to swap. */
  async localizeUploads(text: string) {
    return text;
  }

  /** Forget the cached sign-in and form data (after switching repo). */
  reset() {
    this.viewer = undefined;
    this.metaCache = undefined;
  }
}
