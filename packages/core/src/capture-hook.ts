import { isAbsolute, relative } from "node:path";
import { realpath } from "node:fs/promises";
import type { Graft } from "./graft.js";
import type { ChangeAuthor } from "./record.js";
import { analyzeCommand, relativizeCommand } from "./capture.js";
import { matchCatalog, readPolicy } from "./policy.js";

/**
 * The agents whose hooks Graft can read. Each one hands its events to the
 * same handler below; only the shape of the payload and of the reply differ,
 * and those live in one adapter per agent (`claude-code.ts`, `agent-hooks.ts`).
 */
export const CAPTURE_AGENTS = ["claude-code", "codex", "cursor", "copilot", "gemini"] as const;
export type CaptureAgent = (typeof CAPTURE_AGENTS)[number];

/** How an agent is named in messages, in `Graft-Author` and in the evidence's `via`. */
export const AGENT_INFO: Record<CaptureAgent, { title: string; author: string }> = {
  "claude-code": { title: "Claude Code", author: "claude-code" },
  codex: { title: "Codex", author: "codex" },
  cursor: { title: "Cursor", author: "cursor" },
  copilot: { title: "Copilot CLI", author: "copilot-cli" },
  gemini: { title: "Gemini CLI", author: "gemini-cli" },
};

export function isCaptureAgent(s: string): s is CaptureAgent {
  return (CAPTURE_AGENTS as readonly string[]).includes(s);
}

/**
 * One agent event, reduced to what the record needs. An adapter turns the
 * agent's own payload into one of these; the handler never sees the payload.
 */
export type CaptureEvent =
  | { kind: "prompt"; prompt: string; sessionId?: string; model?: string }
  | {
      kind: "run";
      /** The shell command as the agent ran it. */
      command: string;
      /** The exit code the agent reported, or null when its payload carries none (the run is then not recorded, and the agent is told). */
      exitCode: number | null;
      output: string;
      /** Where the command ran, when the agent says; a run in a subdirectory is recorded with the `cd` in front. */
      cwd?: string;
      sessionId?: string;
      model?: string;
      durationMs?: number;
      interrupted?: boolean;
      background?: boolean;
    }
  | { kind: "ignore"; reason: string };

/**
 * What the hook did. `context`, when set, is a note for the agent: the CLI
 * hands it back to the harness as additional context, so a run Graft could
 * not record is not silently missing from the record.
 */
export type CaptureOutcome = (
  | { action: "ignored"; reason: string }
  | { action: "started"; id: string; task: string }
  | { action: "recorded"; id: string; label: string; command: string; exitCode: number; opened: boolean; name?: string }
) & { context?: string };

/** Replies that carry on with the task rather than name a new one. */
const ACK = /^(ok(ay)?|k|yes|yep|yeah|y|sure|go( ahead| on)?|continue|proceed|carry on|keep going|next|do it|sounds good|lgtm|thanks?( you)?|ty|great|perfect|nice|cool|done|please do|👍)[.!\s]*$/i;

const TASK_CAP = 500;

/** The task a change opened by a run carries until `graft start` names it. */
export function placeholderTask(agent: CaptureAgent, sessionId: string | undefined, named: boolean): string {
  const session = `${AGENT_INFO[agent].title} session${sessionId ? ` ${sessionId}` : ""}`;
  return named
    ? `${session} (task not named; the policy keeps prompts out of the record, so run graft start "<task>" to name it)`
    : `${session} (prompt not captured; run graft start "<task>" to name it)`;
}

/**
 * Turn one agent event into a record action: a prompt opens a change when
 * none is open (the prompt is the task, as the agent received it, unless the
 * policy says tasks are named by hand); a command that looks like a test,
 * build, lint or type-check run is recorded as command evidence with the
 * exit code and output the agent itself reported, so it is a pass or a fail,
 * not an attestation. Never throws for an unknown shape: the hook must not
 * break the session.
 */
export async function handleCaptureEvent(graft: Graft, agent: CaptureAgent, event: CaptureEvent): Promise<CaptureOutcome> {
  if (event.kind === "ignore") return { action: "ignored", reason: event.reason };
  const info = AGENT_INFO[agent];
  const topLevel = await graft.git.topLevel();
  const policy = await readPolicy(topLevel);
  const named = policy.task === "named";
  const author = (): ChangeAuthor => ({ kind: "agent", name: info.author, ...(event.model ? { model: event.model } : {}) });
  const session = event.sessionId ? { sessionId: event.sessionId } : {};

  if (event.kind === "prompt") {
    const task = event.prompt.trim();
    if (!task) return { action: "ignored", reason: "empty prompt" };
    // `/review` is a command; `/home/me/notes.md says...` is not.
    if (/^\/[\w:.-]+(\s|$)/.test(task)) return { action: "ignored", reason: "slash command" };
    // Under `task: "named"` the prompt is never written down, not even as the session's task.
    if (named) return { action: "ignored", reason: 'policy task: "named" keeps prompts out of the record' };
    const ack = ACK.test(task);
    if (!ack) await graft.rememberSessionTask(event.sessionId, clipTask(task));
    if (await graft.status()) return { action: "ignored", reason: "a change is already open" };
    // "continue" after a land is the same task going on; keep it, or wait for a run or a graft start to name it.
    const taskName = ack ? await graft.sessionTask(event.sessionId) : clipTask(task);
    if (!taskName) return { action: "ignored", reason: "a short reply, not a task" };
    const record = await graft.start({ task: taskName, author: author(), capturedBy: agent, ...session });
    return { action: "started", id: record.id, task: record.task };
  }

  const typed = event.command.trim();
  if (!typed) return { action: "ignored", reason: "no command" };
  if (event.interrupted) return { action: "ignored", reason: "interrupted" };
  // A background run reports that it started, not how it ended.
  if (event.background) return { action: "ignored", reason: "run in the background" };
  const command = await atRoot(relativizeCommand(typed, topLevel), event.cwd, topLevel);
  const name = matchCatalog(policy, command);
  const analysis = analyzeCommand(command, policy.captureCommands);
  const kind = name ? "catalog" : analysis.kind;
  if (!kind) return { action: "ignored", reason: "not a policy command or a test, build, lint or type-check command" };
  const what = name ?? analysis.kind;
  const byHand = name ? `graft evidence ${name}` : "graft evidence -- <the command>";
  if (analysis.masked) {
    return {
      action: "ignored",
      reason: "exit code masked by a pipe, || or ;",
      context:
        `graft: this ${what} run was not recorded as evidence: its exit code is not the check's (it is piped, followed by || or ;, or backgrounded). ` +
        `Run it on its own, or with set -o pipefail, to record a pass or fail${name ? `, or run graft evidence ${name}` : ""}.`,
    };
  }
  if (event.exitCode === null || !Number.isInteger(event.exitCode)) {
    return {
      action: "ignored",
      reason: `${info.title} reported no exit code for the run`,
      context: `graft: this ${what} run was not recorded as evidence: ${info.title} did not report its exit code, so Graft cannot say whether it passed. Run ${byHand} to record it.`,
    };
  }
  const open = await graft.status();
  if (open?.sessionId && event.sessionId && open.sessionId !== event.sessionId) {
    return {
      action: "ignored",
      reason: "the open change belongs to another session",
      context:
        `graft: another ${info.title} session opened change ${open.id} (${open.task}) in this worktree, so this ${what} run was not recorded on it. ` +
        "Use a separate git worktree per session, or run graft start --replace to take the change over.",
    };
  }
  let opened = false;
  if (!open) {
    const remembered = named ? null : await graft.sessionTask(event.sessionId);
    await graft.start({
      task: remembered ?? placeholderTask(agent, event.sessionId, named),
      ...(remembered ? {} : { taskPlaceholder: true }),
      author: author(),
      capturedBy: agent,
      ...session,
    });
    opened = true;
  }
  const label = name ?? `${kind} (captured)`;
  const ev = await graft.evidenceCaptured({
    command,
    exitCode: event.exitCode,
    output: event.output,
    durationMs: event.durationMs ?? 0,
    label,
    via: agent,
    ...(name ? { name } : {}),
  });
  const now = (await graft.status())!;
  const context =
    opened && named ? `graft: change ${now.id} was opened by this run without a task, because the policy keeps prompts out of the record. Run graft start "<task>" before committing.` : undefined;
  return {
    action: "recorded",
    id: now.id,
    label,
    command: ev.kind === "command" ? ev.command : command,
    exitCode: event.exitCode,
    opened,
    ...(name ? { name } : {}),
    ...(context ? { context } : {}),
  };
}

/**
 * The command as it would run from the repository root. An agent's shell
 * keeps its directory between calls, so `npm test` typed in `packages/core`
 * is recorded as `cd packages/core && npm test`, which `graft check --rerun`
 * can repeat.
 */
async function atRoot(command: string, cwd: string | undefined, topLevel: string): Promise<string> {
  if (!cwd || /^\s*cd\s/.test(command)) return command;
  const real = async (p: string) => realpath(p).catch(() => p);
  const rel = relative(await real(topLevel), await real(cwd)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return command;
  return `cd ${quoteDir(rel)} && ${command}`;
}

/** A directory as a shell word: bare when it is plain, else single-quoted so `$`, backticks and spaces stay literal. */
export function quoteDir(dir: string): string {
  return /^[\w./-]+$/.test(dir) ? dir : `'${dir.replace(/'/g, `'\\''`)}'`;
}

export function clipTask(task: string): string {
  const oneBlock = task.replace(/\r/g, "").trim();
  return oneBlock.length > TASK_CAP ? oneBlock.slice(0, TASK_CAP - 1) + "…" : oneBlock;
}

/* ---- Helpers the adapters share: agents disagree on field names and nesting. ---- */

type Json = unknown;

/** A string at any of `keys` on `obj`, first one found. */
export function str(obj: Json, ...keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** An integer at any of `keys` on `obj` (a numeric string counts), or null. */
export function int(obj: Json, ...keys: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isInteger(v)) return v;
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  }
  return null;
}

/** `obj` itself when it is an object, or the object a JSON string holds; agents hand tool arguments and results both ways. */
export function objectOf(v: Json): Record<string, unknown> | undefined {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(s);
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * The exit code a tool result reports, looking where the agents put it:
 * `exit_code` / `exitCode` on the result or one level down (`metadata`,
 * `result`), or an "Exit code: N" line in its text. Null when none is there.
 */
export function exitCodeOf(result: Json): number | null {
  const obj = objectOf(result);
  if (obj) {
    const direct = int(obj, "exit_code", "exitCode", "exit_status", "status_code", "returncode");
    if (direct !== null) return direct;
    for (const key of ["metadata", "result", "output", "data"]) {
      const nested = objectOf(obj[key]);
      if (nested) {
        const code = int(nested, "exit_code", "exitCode", "exit_status", "status_code", "returncode");
        if (code !== null) return code;
      }
    }
  }
  const text = typeof result === "string" ? result : obj ? textOf(obj) : "";
  const m = /(?:^|\n)\s*(?:exit[ _]?code|exit status)\s*[:=]?\s*(-?\d+)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

/** The text a tool result carries, from the usual output fields or the whole thing when it is a string. */
export function textOf(result: Json): string {
  // Cursor and Copilot hand the tool result over as a JSON string; read inside it when it is one.
  const obj = objectOf(result);
  if (!obj) return typeof result === "string" ? result : "";
  const out = str(obj, "output", "aggregated_output", "stdout", "Stdout", "text", "content", "textResultForLlm", "text_result_for_llm", "llmContent", "returnDisplay");
  const err = str(obj, "stderr", "Stderr", "error", "Error");
  const parts = [out, err].filter((s): s is string => Boolean(s));
  if (parts.length) return parts.join("\n");
  for (const key of ["result", "metadata", "data"]) {
    const nested = objectOf(obj[key]);
    if (nested) {
      const inner = textOf(nested);
      if (inner) return inner;
    }
  }
  return "";
}

/** The first run_shell-like command in a tool's arguments, whichever name the agent gives it. */
export function commandOf(input: Json): string | undefined {
  const obj = objectOf(input);
  if (!obj) return typeof input === "string" && !input.trim().startsWith("{") ? input : undefined;
  const cmd = str(obj, "command", "cmd", "commandLine", "command_line");
  if (cmd !== undefined) return cmd;
  const argv = obj.argv ?? obj.args;
  if (Array.isArray(argv) && argv.every((a) => typeof a === "string")) return (argv as string[]).join(" ");
  return undefined;
}
