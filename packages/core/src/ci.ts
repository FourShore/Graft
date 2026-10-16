import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CI_WORKFLOW_PATH = ".github/workflows/graft-check.yml";

/** Where the Graft check action lives; pin to a tag or SHA in a repo that wants a fixed version. */
export const CHECK_ACTION = "FourShore/Graft@main";

export interface CiResult {
  /** written: the workflow was created; present: a file already exists there and was left alone. */
  state: "written" | "present";
  path: string;
}

/**
 * The workflow `graft init --ci` writes: check out the whole branch, let the
 * repo add its own install step, then run the reusable check action. The
 * action installs Graft, fetches the notes, and runs `graft check` against
 * the pull request's base with the GitHub renderer; it re-runs recorded
 * commands only for branches of the same repository.
 */
export const CI_WORKFLOW = `# Verifies the Graft records on every pull request: each commit that changed
# behavior must carry evidence that meets .graft/policy.json, and the recorded
# commands are re-run on the merge commit, so a [pass] is a fact, not a claim.
name: Graft check

on:
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the whole branch, so base..HEAD is available
      # Add the step that installs this project's dependencies here, so the
      # recorded commands can run (npm ci, go mod download, pip install ...).
      - uses: ${CHECK_ACTION}
`;

/** Write the check workflow unless a file is already there. */
export async function writeCiWorkflow(topLevel: string): Promise<CiResult> {
  const path = join(topLevel, CI_WORKFLOW_PATH);
  try {
    await readFile(path, "utf8");
    return { state: "present", path: CI_WORKFLOW_PATH };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, CI_WORKFLOW);
  return { state: "written", path: CI_WORKFLOW_PATH };
}
