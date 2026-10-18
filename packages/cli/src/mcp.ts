#!/usr/bin/env node
/**
 * Graft as an MCP server, so coding agents call start / evidence / land
 * directly instead of shelling out. Runs over stdio.
 *
 *   claude mcp add graft -- graft-mcp --repo /path/to/repo
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { Graft, GraftError, gitHooksInstalled } from "@fourshore/graft-core";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const repoFlag = process.argv.indexOf("--repo");
const repo = repoFlag !== -1 ? process.argv[repoFlag + 1] : process.cwd();
const graft = new Graft(repo);

const server = new McpServer({ name: "graft", version });

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

async function guarded<T>(fn: () => Promise<T>) {
  try {
    return text(await fn());
  } catch (err) {
    const msg = err instanceof GraftError || err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: msg }], isError: true };
  }
}

server.registerTool(
  "graft_start",
  {
    description:
      "Open a change before editing code. Record the task you were given and, if you have one, your plan. Only one change can be open at a time.",
    inputSchema: {
      task: z.string().describe("The task, in the words you were given"),
      plan: z.string().optional().describe("How you intend to do it"),
      ref: z.string().optional().describe("Where the task came from: the thread, issue or ticket URL (default: the policy's ref template)"),
      id: z.string().optional().describe("Reuse an existing change id, so one change lands in several repositories"),
      author: z.string().optional().describe("Your agent name, e.g. claude-code"),
      replace: z
        .boolean()
        .optional()
        .describe("Abandon a change another session left open (its attempt is kept) instead of failing"),
    },
  },
  async ({ task, plan, ref, id, author, replace }) =>
    guarded(() => graft.start({ task, plan, ref, id, author: { name: author, kind: "agent" }, replace })),
);

server.registerTool(
  "graft_plan",
  {
    description: "Set or replace the plan on the open change.",
    inputSchema: { plan: z.string() },
  },
  async ({ plan }) => guarded(() => graft.setPlan(plan)),
);

server.registerTool(
  "graft_evidence",
  {
    description:
      "Run a verification command (tests, lint, build) and attach its exit code and output to the open change as evidence. Returns the result so you can read it. Pass `name` to run one of the repo's policy commands by name (graft_status lists them); the landing gate and graft check look for those names. To attach a run you already made instead of running it again, pass its exitCode (and output); it is then recorded as attested rather than pass, which does not satisfy a policy that requires a command.",
    inputSchema: {
      name: z.string().optional().describe("A name from the policy's commands; runs that command and records it under the name (with exitCode, attaches your run of it instead)"),
      command: z.string().optional().describe("Shell command, run from the repo root (or, with exitCode, the command you ran)"),
      label: z.string().optional().describe("What this shows, e.g. 'unit tests'"),
      exitCode: z.number().int().optional().describe("Give this to attach a run you already made; the command is not run"),
      output: z.string().optional().describe("With exitCode: the output of your run (last 4 KB kept)"),
    },
  },
  async ({ name, command, label, exitCode, output }) =>
    guarded(() => {
      if (name) return graft.evidenceNamed(name, label, exitCode === undefined ? undefined : { exitCode, output });
      if (!command) throw new GraftError("Give a policy command name or a command.");
      return exitCode === undefined ? graft.evidenceCommand(command, label) : graft.evidenceAttested(command, exitCode, output, label);
    }),
);

server.registerTool(
  "graft_note",
  {
    description: "Attach evidence that did not come from a command, e.g. 'verified the page renders in the browser'.",
    inputSchema: { text: z.string(), label: z.string().optional() },
  },
  async ({ text: t, label }) => guarded(() => graft.evidenceNote(t, label)),
);

server.registerTool(
  "graft_land",
  {
    description:
      "Commit the change with its record attached as git trailers and a git note. Commits what is already staged plus any paths you name; pass stageAll only when you mean every change in the tree. Refuses to land without evidence unless allowNoEvidence is true, and refuses staged files that look like credentials (.env, *.pem, ...) unless allowSecrets is true; an override that lets a change through is recorded as a Graft-Override trailer.",
    inputSchema: {
      title: z.string().optional().describe("Commit title; defaults to the task"),
      plan: z.string().optional().describe("Final plan, if it changed"),
      paths: z.array(z.string()).optional().describe("Files to stage before committing"),
      stageAll: z.boolean().optional().default(false).describe("Stage every change in the tree (git add -A)"),
      allowNoEvidence: z.boolean().optional().default(false),
      allowSecrets: z.boolean().optional().default(false),
      trailers: z
        .array(z.string())
        .optional()
        .describe("Extra commit trailers, each 'Key: value', e.g. Co-Authored-By or a session link"),
    },
  },
  async ({ title, plan, paths, stageAll, allowNoEvidence, allowSecrets, trailers }) =>
    guarded(() => graft.land({ title, plan, paths, all: stageAll, allowNoEvidence, allowSecrets, trailers })),
);

server.registerTool(
  "graft_status",
  {
    description:
      "The open change (null if none), the policy's named commands, which graft_evidence runs by `name`, and whether this clone has the git hooks (gitHooks), in which case a plain git commit carries the record; without them, commit with graft_land.",
    inputSchema: {},
  },
  async () => guarded(async () => ({ open: await graft.status(), commands: await graft.catalog(), gitHooks: await gitHooksInstalled(graft.git) })),
);

server.registerTool(
  "graft_log",
  {
    description: "Recent history as changes: each commit with its task, author and evidence. Use this to learn why code is the way it is.",
    inputSchema: {
      limit: z.number().int().positive().optional().default(20),
      includeUnrecorded: z.boolean().optional().default(false).describe("Include commits that have no change record"),
    },
  },
  async ({ limit, includeUnrecorded }) => guarded(() => graft.log({ limit, onlyGraft: !includeUnrecorded })),
);

server.registerTool(
  "graft_show",
  { description: "Show one change by change id or commit SHA.", inputSchema: { ref: z.string() } },
  async ({ ref }) => guarded(() => graft.show(ref)),
);

server.registerTool(
  "graft_context",
  {
    description:
      "Read before editing: the changes that touched the given files or directories, newest first, with task, plan and evidence, trimmed to fit a prompt. Use the `text` field as-is.",
    inputSchema: {
      paths: z.array(z.string()).describe("Files or directories, relative to the repo root; empty for the whole repository"),
      limit: z.number().int().positive().optional().default(50).describe("Commits to scan"),
      budget: z.number().int().positive().optional().default(8000).describe("Characters of text to stay within"),
      includeUnrecorded: z.boolean().optional().default(false).describe("Include commits that have no change record"),
    },
  },
  async ({ paths, limit, budget, includeUnrecorded }) => guarded(() => graft.context(paths, { limit, budget, all: includeUnrecorded })),
);

server.registerTool(
  "graft_sync",
  {
    description: "Fetch, merge and push change records (git notes) with the remote so other clones see full records.",
    inputSchema: { remote: z.string().optional(), push: z.boolean().optional().default(true) },
  },
  async ({ remote, push }) => guarded(() => graft.sync({ remote, push })),
);

server.registerTool(
  "graft_abandon",
  {
    description:
      "Close the open change without committing. What it tried (plan, reason, evidence) is kept and lands with the next change as a Tried: block, so the next reader knows what did not work. Give a reason.",
    inputSchema: {
      reason: z.string().optional().describe("Why this attempt is being abandoned"),
      discard: z.boolean().optional().default(false).describe("Keep nothing; the attempt is not carried into the next land"),
    },
  },
  async ({ reason, discard }) => guarded(() => graft.abandon({ reason, discard })),
);

server.registerTool(
  "graft_revert",
  {
    description:
      "Open a change that undoes a landed one: runs git revert --no-commit on its commit and records what is being reverted and why. Then record evidence and land as usual.",
    inputSchema: {
      ref: z.string().describe("The change id or commit to undo"),
      reason: z.string().optional().describe("Why it is being reverted; becomes the plan"),
    },
  },
  async ({ ref, reason }) => guarded(() => graft.revert(ref, { reason })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
