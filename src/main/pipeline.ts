import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AutoItem, AutoStage, AutoState, PipelineRole } from "../shared/types.js";

/**
 * The Auto pipeline's agents: CI/CD, Deploy and QA. Happy holds the state (stages, approvals, timelines) and wakes
 * an agent when there's work for it; the agents do the judgment work and act through these tools, never by talking
 * to each other. Everything they do lands on the item's timeline on the Auto page.
 */

export const ROLE_NAME: Record<PipelineRole, string> = { ci: "CI/CD", deploy: "Deploy", qa: "QA" };
/** The stages each agent is responsible for. */
export const ROLE_STAGES: Record<PipelineRole, AutoStage[]> = { ci: ["queued", "ci", "merge"], deploy: ["deploy"], qa: ["qa"] };

/** What an agent can see about one item. */
export interface ItemView {
  chat: string;
  title: string;
  stage: AutoStage;
  note?: string;
  summary?: string;
  engine: string;
  status: string;
  folder: string;
  branch?: string;
  ownWorktree: boolean;
  uncommitted?: number;
  commitsNotOnMain?: number;
  merged?: boolean;
  mergeApproved?: boolean;
  recent: string[];
}

export interface PipelineHost {
  state(): AutoState;
  view(item: AutoItem): ItemView;
  /** Move an item; checks who may make which move (approvals included). Returns an error to show the agent, or undefined. */
  move(role: PipelineRole | "worker", chat: string, stage: AutoStage, note?: string): string | undefined;
  log(chat: string, who: string, text: string, tone?: "ok" | "bad" | "you"): void;
  /** A visible message in the worker's chat, labeled with the sender. */
  message(chat: string, from: string, text: string): Promise<void>;
  /** A hidden question to the worker; undefined when it's busy. */
  ask(chat: string, question: string): Promise<string | undefined>;
  alert(from: string, text: string): void;
  setPlan(text: string): void;
  /** For ready_for_ci: commit and push state of the chat's branch. */
  readiness(chat: string): Promise<string | undefined>;
  repo(): string;
  testCommand(): string;
  deployCommands(): string;
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

/** The pipeline tools for one agent. */
export function pipelineToolServer(role: PipelineRole, host: PipelineHost) {
  const who = ROLE_NAME[role];
  const items = () => host.state().items;
  const find = (chat: string) => items().find((i) => i.sessionId === chat);
  return createSdkMcpServer({
    name: "pipeline",
    version: "0.1.0",
    tools: [
      tool("pipeline_state", "Every chat in the pipeline: stage, branch, folder, code state, approvals, the worker's ready summary and its last timeline lines. Read this first each time you're woken.", {}, async () =>
        text({ autoMerge: host.state().autoMerge, autoDeploy: host.state().autoDeploy, qaEnv: host.state().qaEnv, repo: host.repo(), items: items().map((i) => host.view(i)), plan: host.state().plan }),
      ),
      tool(
        "move",
        `Move a chat to another stage. Yours: ${ROLE_STAGES[role].join(", ")}, plus "working" to send it back (prefer send_back, which also tells the worker). The note shows on its card.`,
        { chat: z.string(), stage: z.enum(["working", "queued", "ci", "merge", "deploy", "qa", "done"]), note: z.string().optional() },
        async (a) => text(host.move(role, a.chat, a.stage, a.note) ?? "moved"),
      ),
      tool(
        "send_back",
        "Send a chat back to its worker with what to fix: posts the message in the worker's chat (it starts working on it) and moves it to working.",
        { chat: z.string(), message: z.string().describe("What failed, with the evidence (test names, output, file:line, screenshot path) and what to do") },
        async (a) => {
          if (!find(a.chat)) return text("Not in the pipeline");
          const err = host.move(role, a.chat, "working", `${who}: ${a.message.split("\n")[0].slice(0, 120)}`);
          if (err) return text(err);
          await host.message(a.chat, who, `${a.message}\n\nFix it, commit and push, then call ready_for_ci again.`);
          return text("sent back");
        },
      ),
      tool("message_worker", "Post a message in a worker's chat (visible, labeled as from you). The worker reads it as a request.", { chat: z.string(), message: z.string() }, async (a) => {
        if (!find(a.chat)) return text("Not in the pipeline");
        await host.message(a.chat, who, a.message);
        host.log(a.chat, who, `told the worker: ${a.message.split("\n")[0].slice(0, 140)}`);
        return text("sent");
      }),
      tool(
        "ask_worker",
        "Ask a worker a question out of sight (it answers from what it knows of its own work); you get the answer. Returns 'busy' when it's mid-turn: try again later or decide without it.",
        { chat: z.string(), question: z.string() },
        async (a) => {
          if (!find(a.chat)) return text("Not in the pipeline");
          const answer = await host.ask(a.chat, `${who} (Happy's pipeline) asks: ${a.question}\n\nAnswer in plain text, briefly. Don't do any work now and don't use tools.`);
          host.log(a.chat, who, answer ? `asked: ${a.question.slice(0, 120)}` : `asked (worker busy): ${a.question.slice(0, 100)}`);
          return text(answer ?? "busy");
        },
      ),
      tool("log", "Add a line to a chat's timeline on the Auto page (what you did, what you found).", { chat: z.string(), text: z.string(), tone: z.enum(["ok", "bad"]).optional() }, async (a) => {
        host.log(a.chat, who, a.text, a.tone);
        return text("logged");
      }),
      tool("alert_user", "Something only the user can decide or fix (an approval outside your rules, broken test infrastructure, a judgment call). Shows under Needs you on the Auto page.", { text: z.string() }, async (a) => {
        host.alert(who, a.text);
        return text("shown to the user");
      }),
      ...(role === "deploy"
        ? [
            tool(
              "set_plan",
              "Show the deploy plan for approval: per environment, what deploys (components) and every data step (migrations, backfills, package publishes) in order. You're woken when the user approves.",
              { plan: z.string() },
              async (a) => {
                host.setPlan(a.plan);
                return text("Plan shown. Wait: you'll get a message when it's approved.");
              },
            ),
          ]
        : []),
    ],
  });
}

/** The tool every worker chat in the pipeline gets: say its work is ready for CI. */
export function workerToolServer(chat: string, host: PipelineHost) {
  return createSdkMcpServer({
    name: "pipeline",
    version: "0.1.0",
    tools: [
      tool(
        "ready_for_ci",
        "Only when you're in Happy's Auto pipeline: call this when your change is done, committed and pushed. CI then merges it with the other ready work, runs the tests and takes it to deploy and QA. Don't call it for work in progress.",
        { summary: z.string().describe("One or two lines: what changed and anything CI or deploy should know (migrations, backfills, package versions)") },
        async (a) => {
          const item = host.state().items.find((i) => i.sessionId === chat);
          if (!item) return text("This chat isn't in the Auto pipeline; nothing to do.");
          const problem = await host.readiness(chat);
          if (problem) {
            host.log(chat, "Happy", `ready refused: ${problem}`, "bad");
            return text(`Not queued: ${problem}`);
          }
          item.summary = a.summary;
          const err = host.move("worker", chat, "queued", "in the CI queue");
          if (err) return text(err);
          host.log(chat, "worker", `ready for CI: ${a.summary}`);
          return text("Queued for CI. You'll get a message here if CI, deploy or QA needs something from you.");
        },
      ),
    ],
  });
}

export const WORKER_PROMPT = `
You may be part of Happy's Auto pipeline (CI/CD → Deploy → QA). If you are, when your change is done, committed and pushed, call the ready_for_ci tool with a short summary; messages from CI/CD, Deploy or QA in this chat are requests from that pipeline. If you're not in it, the tool says so: ignore it.`;

/** The instructions for each pipeline agent. */
export function rolePrompt(role: PipelineRole, ctx: { repo: string; qaEnv?: string; testCommand: string; deployCommands: string }): string {
  const common = `
You are Happy's ${ROLE_NAME[role]} agent in the Auto pipeline: workers (other chats) → CI/CD → Deploy → QA. Happy holds the pipeline's state and wakes you with a message when there's work for you. Use the pipeline tools: pipeline_state first, then move / send_back / message_worker / ask_worker / log / alert_user. Log what you do on each chat's timeline so the user can follow it. Never talk to the other pipeline agents; Happy hands work along when you move a chat to the next stage. When you're done with what you were woken for, stop and wait; don't poll.
The main repo is ${ctx.repo}. Don't change anything in its main checkout; work in your own worktree.`;
  if (role === "ci")
    return `${common}

Your job: get the ready branches tested together and onto main.
When woken with a batch:
1. pipeline_state, then move each listed chat from queued to ci.
2. git fetch, then make an integration worktree off origin/main (e.g. git worktree add ../happy-ci-<n> -b ci/<n> origin/main) and merge each chat's branch into it, one at a time.
   - Two branches adding database migrations off the same head: re-parent the later one onto the earlier one with a commit on that worker's branch, push it, and tell the worker (message_worker).
   - Two branches bumping the same package version: bump the later one to the next version the same way.
   - A real code conflict you can't settle safely: send_back that chat (file and what conflicts; ask it to rebase on main) and continue with the rest.
   - If pipeline_state shows a worker stuck in its own long pre-commit or test run, tell it to stop: CI runs the tests.
3. Run the checks once on the integration branch: ${ctx.testCommand}. Run long commands in the background and wait for them; they can take a while.
4. If they fail: find which branch broke them (run the failing tests on each branch alone) and send_back that chat with the failing tests and the relevant output, then re-test the rest without it. If each branch passes alone but they fail together, send_back both explaining the interaction and alert_user (someone has to decide the order). A test that fails once and passes on a re-run: note it as flaky in the log, no more retries. If the checks can't run at all (database won't start, missing tools), alert_user and leave the chats in ci; never blame a worker for broken infrastructure.
5. If they pass: when autoMerge is on, merge the integration branch into main (no force push), push, and move each chat to deploy with note "merged <sha>". When it's off, move each chat to merge with note "passed: <n> tests" and stop; you'll be woken when the user approves.
6. When woken with an approval: fetch; if main moved, rebuild the integration branch on it and re-run the checks; then merge, push, and move each approved chat to deploy with note "merged <sha>".
7. Remove your integration worktree when a batch is finished. Never force-push, never rewrite main, never push to main without approval or autoMerge.`;
  if (role === "deploy")
    return `${common}

Your job: get merged work deployed, with the user's approval.
Deploy commands (from the project config): ${ctx.deployCommands || "none configured: ask the user how this project deploys (alert_user)."}
When woken with merged chats:
1. pipeline_state. ask_worker each chat in deploy: does deploying it need a database migration, a backfill, a package publish, config or secrets, and which components changed? If one is busy, ask again later or work it out from its branch's diff.
2. set_plan: per environment, which components deploy, and every data step (migrations before the code that needs them, backfills after, package publishes) in order. Then stop and wait for approval.
3. When autoDeploy is on, you may deploy code to ${ctx.qaEnv ?? "the first environment"} without waiting. Migrations, backfills, package publishes and every other environment always wait for an approved plan.
4. When woken with an approval: run exactly the approved steps, in order, and check each one worked (health check, logs). Then move each chat to qa with note "deployed to <env> at <sha>".
5. If a step fails: alert_user with the error and what you think it is; if it's the change's own code, send_back the chat with the log. Never retry a migration or backfill on your own.
6. If Happy tells you it restarted during a deploy, don't re-run anything: check what state the environment is in and report with alert_user.`;
  return `${common}

Your job: check deployed work on ${ctx.qaEnv ?? "the test environment"} the way a user would.
When woken with chats in qa:
1. pipeline_state. ask_worker each: how should QA check this change on ${ctx.qaEnv ?? "the test environment"}? Concrete steps (pages to open, actions, MCP calls) and what should happen.
2. Do the checks: the browser tools for the web app (Happy's browser is already signed in), and any MCP tools you have. Prefer reading over writing; if a check needs you to change real data beyond a clearly labeled test record, alert_user instead.
3. All good: move the chat to done with a one-line note of what you checked. Something wrong: send_back with what you did, what you expected, what happened, and screenshots. Can't check it (no access, no data): alert_user; never guess a pass.`;
}

/** The message that wakes an agent for these items. */
export function wakeMessage(role: PipelineRole, items: ItemView[], st: AutoState, restarted = false): string {
  const list = items.map((i) => `- ${i.title} (chat ${i.chat}, branch ${i.branch ?? "?"})${i.summary ? `: ${i.summary}` : ""}`).join("\n");
  if (restarted) return `Happy restarted. These chats are in your stages:\n${list}\nCheck where things got to (pipeline_state, git, logs) and carry on.${role === "deploy" ? " Don't re-run a deploy step that may have been running: check its state and alert_user." : ""}`;
  if (role === "ci") return `New CI batch (Auto merge is ${st.autoMerge ? "on" : "off"}):\n${list}`;
  if (role === "deploy") return `Merged and ready to deploy (Auto deploy is ${st.autoDeploy ? `on for ${st.qaEnv ?? "the first environment"}` : "off"}):\n${list}`;
  return `Deployed to ${st.qaEnv ?? "the test environment"}, ready for QA:\n${list}`;
}
