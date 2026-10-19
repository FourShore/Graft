import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const AGENTS_PATH = "AGENTS.md" as const;
export const CLAUDE_PATH = "CLAUDE.md" as const;

/**
 * The section `graft init` adds to AGENTS.md so an agent working in the repo
 * knows the workflow without anyone pasting it. Shell commands first, since
 * every agent has a shell; MCP tool names as the alternative.
 */
export const AGENTS_SECTION = `## Version control

This repo uses Graft (https://github.com/FourShore/Graft): every commit carries
the task it was given, the checks that ran and whether they passed, and a commit
without them is refused. Two things are yours.

- \`graft start "<the task, in the words you were given>"\` names the change.
  In Claude Code with the capture hooks installed, your prompt already opened
  one and this only names it; if another session left one open, add \`--replace\`.
- Run the repo's checks before committing. \`.graft/policy.json\` names them and
  says which files need which; \`graft status\` lists them. \`graft evidence <name>\`
  runs one by name and records the result, in any agent. In Claude Code the
  hooks also record the test, build and lint runs you make, unless the exit
  code is hidden (\`npm test | tail\`). \`graft evidence --note "<what you checked>"\`
  records a manual check. A check that ran before your last edit does not count.

Then commit. \`graft status\` says whether this clone has the git hooks: with
them, a plain \`git commit\` carries the record; without them, use
\`graft land <paths> -m "<title>"\`. Either refuses a change whose checks are
missing.

Before editing a file, \`graft context <paths>\` shows the changes that touched
it. Over MCP the same steps are \`graft_start\`, \`graft_evidence\`, \`graft_land\`
and \`graft_context\`.
`;

export interface AgentsResult {
  /** True if AGENTS.md was created or the section appended. */
  written: boolean;
  /** True if AGENTS.md or CLAUDE.md already mentioned Graft, so nothing was written. */
  alreadyThere: boolean;
  /** Which file already covered Graft, when alreadyThere is true. */
  coveredBy?: "AGENTS.md" | "CLAUDE.md";
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
  if (MENTIONS_GRAFT.test(existing ?? "")) return { written: false, alreadyThere: true, coveredBy: AGENTS_PATH, claudeHint };
  if (MENTIONS_GRAFT.test(claude ?? "")) return { written: false, alreadyThere: true, coveredBy: CLAUDE_PATH, claudeHint: false };
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
