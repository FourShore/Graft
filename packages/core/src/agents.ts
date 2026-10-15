import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const AGENTS_PATH = "AGENTS.md";
export const CLAUDE_PATH = "CLAUDE.md";

/**
 * The section `graft init` adds to AGENTS.md so an agent working in the repo
 * knows the workflow without anyone pasting it. Shell commands first, since
 * every agent has a shell; MCP tool names as the alternative.
 */
export const AGENTS_SECTION = `## Version control

This repo uses Graft (https://github.com/FourShore/Graft). Every commit records
the task you were given, your plan, and the checks you ran, so the next reader
knows why the code is the way it is.

- Before editing, open a change: \`graft start "<the task, in the words you were given>"\`.
  If it says a change is already open from another session, use \`graft start --replace\`.
- Record each check as you run it: \`graft evidence --label "unit tests" -- npm test\`,
  or \`graft evidence --note "<what you checked by hand>"\` for anything manual.
- Commit with \`graft land <paths> -m "<title>"\`, not \`git commit\`. It refuses to
  land without evidence.
- After \`git push\`, run \`graft sync\` so the full records reach the remote.
- To learn why code is the way it is, run \`graft log\` or \`graft show <id>\`.

With the Graft MCP server the same steps are \`graft_start\`, \`graft_evidence\`,
\`graft_note\`, \`graft_land\`, \`graft_sync\` and \`graft_log\`.
`;

export interface AgentsResult {
  /** True if AGENTS.md was created or the section appended. */
  written: boolean;
  /** True if AGENTS.md or CLAUDE.md already mentioned Graft, so nothing was written. */
  alreadyThere: boolean;
  /** True if CLAUDE.md is absent or does not import AGENTS.md, so Claude Code won't read it. */
  claudeHint: boolean;
}

const MENTIONS_GRAFT = /graft start|graft_start/;

/**
 * Add the Graft section to AGENTS.md at `topLevel`, creating the file if
 * needed. Idempotent: nothing is written when AGENTS.md or CLAUDE.md already
 * mentions Graft, so a hook that runs `graft init` every session does not
 * leave a new file behind in a repo that documents Graft in CLAUDE.md.
 */
export async function writeAgentsSection(topLevel: string): Promise<AgentsResult> {
  const agentsFile = join(topLevel, AGENTS_PATH);
  const existing = await readOrNull(agentsFile);
  const claude = await readOrNull(join(topLevel, CLAUDE_PATH));
  const claudeHint = !claude || !/^@AGENTS\.md\s*$/m.test(claude);
  if (MENTIONS_GRAFT.test(existing ?? "")) return { written: false, alreadyThere: true, claudeHint };
  if (MENTIONS_GRAFT.test(claude ?? "")) return { written: false, alreadyThere: true, claudeHint: false };
  const body = existing ? existing.replace(/\s*$/, "\n\n") + AGENTS_SECTION : AGENTS_SECTION;
  await writeFile(agentsFile, body);
  return { written: true, alreadyThere: false, claudeHint };
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
