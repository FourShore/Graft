import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Git } from "./git.js";
import { CAPTURE_AGENTS, type CaptureAgent } from "./capture-hook.js";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
/**
 * The Claude Code hook command. It checks for the binary first, so a clone
 * whose settings file names the hooks but whose machine has no `graft` does
 * not log a hook error on every prompt and every Bash call.
 */
export const HOOK_COMMAND = "command -v graft >/dev/null 2>&1 || exit 0; graft hook claude-code";
/** What `graft init` wrote before the guard; recognized and upgraded in place. */
const OLD_HOOK_COMMANDS = ["graft hook claude-code"];
const MARK = "# graft-hook";
const INSTALL_HINT = "npm install -g @fourshore/graft";

export type HookFileState = "written" | "present" | "unreadable";

/** The git hooks `graft init` installs, in the order git runs them. */
export type GitHook = "prepare-commit-msg" | "commit-msg" | "post-commit";
export const GIT_HOOKS: GitHook[] = ["prepare-commit-msg", "commit-msg", "post-commit"];

export interface HooksResult {
  /** What happened to .claude/settings.json; the same as `agents["claude-code"]`, kept for readers of earlier versions. */
  claudeCode: HookFileState;
  /** Per agent whose hooks were asked for: what happened to its config file. */
  agents: Partial<Record<CaptureAgent, HookFileState>>;
  /** Per git hook: written, already Graft's, or left alone because another hook is there. */
  git: Record<GitHook, "written" | "present" | "foreign">;
  /** Where the git hooks went, for the message. */
  hooksDir: string;
}

/**
 * Where each agent reads its hooks from and what one handler looks like
 * there. Claude Code, Codex and Gemini CLI share one shape (an event maps to
 * matcher groups, each with its handlers); Cursor and Copilot CLI keep a flat
 * list of handlers per event, under their own key for the command.
 */
interface HookSpec {
  file: string;
  /** Hook command for this agent; Cursor's prompt hook must answer `continue` even when graft is missing. */
  command: string;
  /** Events to hook, each with the matcher that picks the shell tool (none for the prompt event). */
  events: Array<[event: string, matcher?: string]>;
  shape: "groups" | "flat";
  /** The handler object at a group's `hooks[]` (groups) or the event's list (flat). */
  handler: (matcher?: string) => Record<string, unknown>;
  /** The key holding the command in a handler, for recognizing one that is Graft's. */
  commandKey: string;
  /** Top-level fields a fresh file needs besides `hooks` (Cursor and Copilot CLI version their files). */
  top?: Record<string, unknown>;
}

const guarded = (agent: CaptureAgent) => `command -v graft >/dev/null 2>&1 || exit 0; graft hook ${agent}`;

export const HOOK_SPECS: Record<CaptureAgent, HookSpec> = {
  "claude-code": {
    file: CLAUDE_SETTINGS_PATH,
    command: HOOK_COMMAND,
    events: [["UserPromptSubmit"], ["PostToolUse", "Bash"], ["PostToolUseFailure", "Bash"]],
    shape: "groups",
    handler: () => ({ type: "command", command: HOOK_COMMAND, timeout: 15 }),
    commandKey: "command",
  },
  codex: {
    file: ".codex/hooks.json",
    command: guarded("codex"),
    events: [["UserPromptSubmit"], ["PostToolUse", "Bash"]],
    shape: "groups",
    handler: () => ({ type: "command", command: guarded("codex"), timeout: 15 }),
    commandKey: "command",
  },
  gemini: {
    file: ".gemini/settings.json",
    command: guarded("gemini"),
    events: [["BeforeAgent"], ["AfterTool", "run_shell_command"]],
    shape: "groups",
    handler: () => ({ name: "graft", type: "command", command: guarded("gemini"), timeout: 15000 }),
    commandKey: "command",
  },
  cursor: {
    file: ".cursor/hooks.json",
    // Cursor reads the prompt hook's answer as JSON (and blocks on none where `failClosed` is set), so a missing binary still says `continue`.
    command: `command -v graft >/dev/null 2>&1 || { echo '{"continue":true}'; exit 0; }; graft hook cursor`,
    events: [["beforeSubmitPrompt"], ["postToolUse", "Shell"]],
    shape: "flat",
    handler: (matcher) => ({
      command: `command -v graft >/dev/null 2>&1 || { echo '{"continue":true}'; exit 0; }; graft hook cursor`,
      ...(matcher ? { matcher } : {}),
      timeout: 15,
    }),
    commandKey: "command",
    top: { version: 1 },
  },
  copilot: {
    file: ".github/hooks/graft.json",
    command: guarded("copilot"),
    events: [["userPromptSubmitted"], ["postToolUse"]],
    shape: "flat",
    // `bash` runs on Unix; Windows runs `powershell`, where `command -v` would not.
    handler: () => ({ type: "command", bash: guarded("copilot"), powershell: "if (Get-Command graft -ErrorAction SilentlyContinue) { graft hook copilot }", timeoutSec: 15 }),
    commandKey: "bash",
    top: { version: 1 },
  },
};

/**
 * The agents a repo appears to use, by their config directories here or in
 * the home directory. Claude Code is always included: its hooks were the
 * only ones earlier versions wrote, and the file is harmless where it is not
 * read.
 */
export async function detectCaptureAgents(topLevel: string): Promise<CaptureAgent[]> {
  const home = homedir();
  const here = (p: string) => exists(join(topLevel, p));
  const mine = (p: string) => exists(join(home, p));
  const found: CaptureAgent[] = ["claude-code"];
  if ((await here(".codex")) || (await mine(".codex"))) found.push("codex");
  if ((await here(".cursor")) || (await mine(".cursor"))) found.push("cursor");
  if ((await here(".github/hooks")) || (await mine(".copilot"))) found.push("copilot");
  if ((await here(".gemini")) || (await mine(".gemini"))) found.push("gemini");
  return found;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the capture hooks: each agent's hook config so the prompt opens a
 * change and every test, build or lint command the agent runs is recorded,
 * and git hooks so a plain `git commit` carries the record. Idempotent; never
 * overwrites a hook Graft did not write.
 */
export async function installHooks(git: Git, topLevel: string, agents: readonly CaptureAgent[] = ["claude-code"]): Promise<HooksResult> {
  const result: HooksResult["agents"] = {};
  for (const agent of CAPTURE_AGENTS) {
    if (agents.includes(agent)) result[agent] = await writeAgentHooks(topLevel, agent);
  }
  return {
    claudeCode: result["claude-code"] ?? "present",
    agents: result,
    ...(await writeGitHooks(git)),
  };
}

async function writeAgentHooks(topLevel: string, agent: CaptureAgent): Promise<HookFileState> {
  const spec = HOOK_SPECS[agent];
  const file = join(topLevel, spec.file);
  let settings: Record<string, unknown> = {};
  let indent: string | number = 2;
  let fresh = true;
  try {
    const raw = await readFile(file, "utf8");
    settings = JSON.parse(raw) as Record<string, unknown>;
    fresh = false;
    // Keep the file's own indentation, so the diff is only the hooks.
    indent = /^[{[]\s*\n([ \t]+)\S/.exec(raw)?.[1] ?? 2;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "unreadable";
  }
  if (fresh && spec.top) settings = { ...spec.top, ...settings };
  const hooks = (settings.hooks ??= {}) as Record<string, Record<string, unknown>[]>;
  const ours = `graft hook ${agent}`;
  const isOurs = (h: Record<string, unknown>) => typeof h[spec.commandKey] === "string" && (h[spec.commandKey] as string).includes(ours);
  let changed = false;
  for (const [event, matcher] of spec.events) {
    const list = (hooks[event] ??= []);
    if (!Array.isArray(list)) return "unreadable";
    if (spec.shape === "groups") {
      for (const group of list) {
        for (const h of (group.hooks as Record<string, unknown>[] | undefined) ?? []) {
          if (agent === "claude-code" && OLD_HOOK_COMMANDS.includes(h.command as string)) {
            h.command = HOOK_COMMAND;
            changed = true;
          }
        }
      }
      // Any command that runs the capture hook counts, so a repo that wrapped or guarded it its own way keeps its version.
      if (list.some((group) => ((group.hooks as Record<string, unknown>[] | undefined) ?? []).some(isOurs))) continue;
      list.push({ ...(matcher ? { matcher } : {}), hooks: [spec.handler(matcher)] });
    } else {
      if (list.some(isOurs)) continue;
      list.push(spec.handler(matcher));
    }
    changed = true;
  }
  if (!changed) return "present";
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, indent) + "\n");
  return "written";
}

async function writeGitHooks(git: Git): Promise<Pick<HooksResult, "git" | "hooksDir">> {
  // --git-path answers relative to git's cwd, which is not necessarily ours.
  const hooksDir = resolve(git.cwd, await git.run(["rev-parse", "--git-path", "hooks"]));
  await mkdir(hooksDir, { recursive: true });
  // Without the binary the commit goes through unrecorded, with one line saying so; graft check catches it at the pull request.
  const missing = (what: string) =>
    `if ! command -v graft >/dev/null 2>&1; then\n  ${what}\n  exit 0\nfi\n`;
  const scripts: Record<GitHook, string> = {
    "prepare-commit-msg": `#!/bin/sh\n${MARK}: add the open Graft change to the commit message\n[ -n "$GRAFT_LANDING" ] && exit 0\n${missing(`echo "graft is not installed, so this commit carries no Graft record. Install it: ${INSTALL_HINT}" >&2`)}exec graft hook prepare-commit-msg "$@"\n`,
    "commit-msg": `#!/bin/sh\n${MARK}: abort a commit whose message is only the Graft record (an editor closed empty)\n[ -n "$GRAFT_LANDING" ] && exit 0\n${missing(":")}exec graft hook commit-msg "$@"\n`,
    "post-commit": `#!/bin/sh\n${MARK}: attach the Graft record to the commit just made\n[ -n "$GRAFT_LANDING" ] && exit 0\n${missing(":")}exec graft hook post-commit\n`,
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

/**
 * True when the repo's own hook file for `agent` runs the capture hook, so a
 * copy installed another way (the Claude Code plugin) should step aside
 * rather than record every run twice.
 */
export async function hasAgentHooks(topLevel: string, agent: CaptureAgent): Promise<boolean> {
  try {
    return (await readFile(join(topLevel, HOOK_SPECS[agent].file), "utf8")).includes(`graft hook ${agent}`);
  } catch {
    return false;
  }
}

/** True when this clone's prepare-commit-msg is Graft's, so a plain `git commit` carries the record. */
export async function gitHooksInstalled(git: Git): Promise<boolean> {
  try {
    const hooksDir = resolve(git.cwd, await git.run(["rev-parse", "--git-path", "hooks"]));
    return (await readFile(join(hooksDir, "prepare-commit-msg"), "utf8")).includes(MARK);
  } catch {
    return false;
  }
}
