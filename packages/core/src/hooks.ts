import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Git } from "./git.js";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
const HOOK_COMMAND = "graft hook claude-code";
const MARK = "# graft-hook";

export interface HooksResult {
  /** What happened to .claude/settings.json. */
  claudeCode: "written" | "present" | "unreadable";
  /** Per git hook: written, already Graft's, or left alone because another hook is there. */
  git: Record<"prepare-commit-msg" | "post-commit", "written" | "present" | "foreign">;
  /** Where the git hooks went, for the message. */
  hooksDir: string;
}

/**
 * Install the capture hooks: Claude Code hooks in .claude/settings.json so
 * the prompt opens a change and every test, build or lint command the agent
 * runs is recorded, and git hooks so a plain `git commit` carries the record.
 * Idempotent; never overwrites a hook Graft did not write.
 */
export async function installHooks(git: Git, topLevel: string): Promise<HooksResult> {
  return {
    claudeCode: await writeClaudeSettings(topLevel),
    ...(await writeGitHooks(git)),
  };
}

async function writeClaudeSettings(topLevel: string): Promise<HooksResult["claudeCode"]> {
  const file = join(topLevel, CLAUDE_SETTINGS_PATH);
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "unreadable";
  }
  const hooks = (settings.hooks ??= {}) as Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;
  const entry = (matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 15 }] });
  const wanted: [string, string | undefined][] = [
    ["UserPromptSubmit", undefined],
    ["PostToolUse", "Bash"],
    ["PostToolUseFailure", "Bash"],
  ];
  let changed = false;
  for (const [event, matcher] of wanted) {
    const list = (hooks[event] ??= []);
    if (list.some((e) => e.hooks?.some((h) => h.command === HOOK_COMMAND))) continue;
    list.push(entry(matcher));
    changed = true;
  }
  if (!changed) return "present";
  await mkdir(join(topLevel, ".claude"), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n");
  return "written";
}

async function writeGitHooks(git: Git): Promise<Pick<HooksResult, "git" | "hooksDir">> {
  // --git-path answers relative to git's cwd, which is not necessarily ours.
  const hooksDir = resolve(git.cwd, await git.run(["rev-parse", "--git-path", "hooks"]));
  await mkdir(hooksDir, { recursive: true });
  const scripts: Record<"prepare-commit-msg" | "post-commit", string> = {
    "prepare-commit-msg": `#!/bin/sh\n${MARK}: add the open Graft change to the commit message\n[ -n "$GRAFT_LANDING" ] && exit 0\nexec graft hook prepare-commit-msg "$@"\n`,
    "post-commit": `#!/bin/sh\n${MARK}: attach the Graft record to the commit just made\n[ -n "$GRAFT_LANDING" ] && exit 0\nexec graft hook post-commit\n`,
  };
  const result = {} as HooksResult["git"];
  for (const name of Object.keys(scripts) as (keyof typeof scripts)[]) {
    const file = join(hooksDir, name);
    let existing: string | null = null;
    try {
      existing = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (existing !== null) {
      result[name] = existing.includes(MARK) ? "present" : "foreign";
      if (result[name] === "foreign") continue;
      if (existing === scripts[name]) continue;
    }
    await writeFile(file, scripts[name]);
    await chmod(file, 0o755);
    result[name] = existing === null ? "written" : "present";
  }
  return { git: result, hooksDir };
}
