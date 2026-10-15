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
import { Graft, GraftError } from "@fourshore/graft-core";

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
      author: z.string().optional().describe("Your agent name, e.g. claude-code"),
      model: z.string().optional().describe("Your model id"),
      replace: z
        .boolean()
        .optional()
        .describe("Drop a change another session left open instead of failing"),
    },
  },
  async ({ task, plan, author, model, replace }) =>
    guarded(() => graft.start({ task, plan, author: { name: author, model, kind: "agent" }, replace })),
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
      "Run a verification command (tests, lint, build) and attach its exit code and output to the open change as evidence. Returns the result so you can read it.",
    inputSchema: {
      command: z.string().describe("Shell command, run from the repo root"),
      label: z.string().optional().describe("What this shows, e.g. 'unit tests'"),
    },
  },
  async ({ command, label }) => guarded(() => graft.evidenceCommand(command, label)),
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
      "Commit the change with its record attached as git trailers and a git note. Commits what is already staged plus any paths you name; pass stageAll only when you mean every change in the tree. Refuses to land without evidence unless allowNoEvidence is true, and refuses staged files that look like credentials (.env, *.pem, ...) unless allowSecrets is true.",
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
  { description: "Show the open change, or null if none.", inputSchema: {} },
  async () => guarded(() => graft.status()),
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
  "graft_sync",
  {
    description: "Fetch, merge and push change records (git notes) with the remote so other clones see full records.",
    inputSchema: { remote: z.string().optional(), push: z.boolean().optional().default(true) },
  },
  async ({ remote, push }) => guarded(() => graft.sync({ remote, push })),
);

server.registerTool(
  "graft_abandon",
  { description: "Drop the open change without committing.", inputSchema: {} },
  async () => guarded(() => graft.abandon()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
