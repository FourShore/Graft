import type { Graft } from "./graft.js";
import type { ChangeAuthor } from "./record.js";
import { relative, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { analyzeCommand, relativizeCommand } from "./capture.js";
import { matchCatalog, readPolicy } from "./policy.js";

/** The subset of a Claude Code hook payload Graft reads. */
export interface ClaudeCodeEvent {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  /** The model the session runs on, when the harness includes it; a string or `{ id }`. */
  model?: string | { id?: string; display_name?: string };
  prompt?: string;
  tool_name?: string;
  tool_input?: { command?: string; description?: string; run_in_background?: boolean };
  tool_response?: { stdout?: string; stderr?: string; interrupted?: boolean };
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}

/**
 * What the hook did. `context`, when set, is a note for the agent: the CLI
 * hands it back to the harness as `additionalContext`, so a run Graft could
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

/**
 * Turn one Claude Code hook event into a record action: a prompt opens a
 * change when none is open (the prompt is the task, as the agent received
 * it); a Bash call that looks like a test, build, lint or type-check run is
 * recorded as command evidence with the exit code and output the harness
 * itself reported, so it is a pass or a fail, not an attestation.
 * Never throws for an unknown shape: the hook must not break the session.
 */
export async function handleClaudeCodeEvent(graft: Graft, event: ClaudeCodeEvent): Promise<CaptureOutcome> {
  if (event.hook_event_name === "UserPromptSubmit") {
    // Judge the person's words, not the envelope a harness may wrap them in.
    const task = promptTask((event.prompt ?? "").trim()).trim();
    if (!task) return { action: "ignored", reason: "empty prompt" };
    // `/review` is a command; `/home/me/notes.md says...` is not.
    if (/^\/[\w:.-]+(\s|$)/.test(task)) return { action: "ignored", reason: "slash command" };
    const ack = ACK.test(task);
    if (!ack) await graft.rememberSessionTask(event.session_id, clipTask(task));
    if (await graft.status()) return { action: "ignored", reason: "a change is already open" };
    // "continue" after a land is the same task going on; keep it, or wait for a run or a graft start to name it.
    const named = ack ? await graft.sessionTask(event.session_id) : clipTask(task);
    if (!named) return { action: "ignored", reason: "a short reply, not a task" };
    const record = await graft.start({ task: named, author: claudeAuthor(event), capturedBy: "claude-code", ...sessionOf(event) });
    return { action: "started", id: record.id, task: record.task };
  }
  if (event.hook_event_name !== "PostToolUse" && event.hook_event_name !== "PostToolUseFailure") {
    return { action: "ignored", reason: `event ${event.hook_event_name}` };
  }
  if (event.tool_name !== "Bash") return { action: "ignored", reason: `tool ${event.tool_name}` };
  const typed = (event.tool_input?.command ?? "").trim();
  if (!typed) return { action: "ignored", reason: "no command" };
  if (event.is_interrupt || event.tool_response?.interrupted) return { action: "ignored", reason: "interrupted" };
  // A background run reports that it started, not how it ended.
  if (event.tool_input?.run_in_background) return { action: "ignored", reason: "run in the background" };
  const topLevel = await graft.git.topLevel();
  const policy = await readPolicy(topLevel);
  const command = await atRoot(relativizeCommand(typed, topLevel), event.cwd, topLevel);
  const name = matchCatalog(policy, command);
  const analysis = analyzeCommand(command, policy.captureCommands);
  const kind = name ? "catalog" : analysis.kind;
  if (!kind) return { action: "ignored", reason: "not a policy command or a test, build, lint or type-check command" };
  const what = name ?? analysis.kind;
  if (analysis.masked) {
    return {
      action: "ignored",
      reason: "exit code masked by a pipe, || or ;",
      context:
        `graft: this ${what} run was not recorded as evidence: its exit code is not the check's (it is piped, followed by || or ;, or backgrounded). ` +
        `Run it on its own, or with set -o pipefail, to record a pass or fail${name ? `, or run graft evidence ${name}` : ""}.`,
    };
  }
  const open = await graft.status();
  if (open?.sessionId && event.session_id && open.sessionId !== event.session_id) {
    return {
      action: "ignored",
      reason: "the open change belongs to another session",
      context:
        `graft: another Claude Code session opened change ${open.id} (${open.task}) in this worktree, so this ${what} run was not recorded on it. ` +
        "Use a separate git worktree per session, or run graft start --replace to take the change over.",
    };
  }

  let exitCode = 0;
  let output: string;
  if (event.hook_event_name === "PostToolUse") {
    output = [event.tool_response?.stdout ?? "", event.tool_response?.stderr ?? ""].filter(Boolean).join("\n");
  } else {
    const err = event.error ?? "";
    const m = /^Exit code (-?\d+)\n?/.exec(err);
    if (!m) return { action: "ignored", reason: "failure without an exit code (the shell did not start)" };
    exitCode = Number(m[1]);
    output = err.slice(m[0].length);
  }
  let opened = false;
  if (!open) {
    await graft.start({
      task:
        (await graft.sessionTask(event.session_id)) ??
        `Claude Code session${event.session_id ? ` ${event.session_id}` : ""} (prompt not captured; run graft start "<task>" to name it)`,
      author: claudeAuthor(event),
      capturedBy: "claude-code",
      ...sessionOf(event),
    });
    opened = true;
  }
  const label = name ?? `${kind} (captured)`;
  const ev = await graft.evidenceCaptured({ command, exitCode, output, durationMs: event.duration_ms ?? 0, label, via: "claude-code", ...(name ? { name } : {}) });
  const now = (await graft.status())!;
  return { action: "recorded", id: now.id, label, command: ev.kind === "command" ? ev.command : command, exitCode, opened, ...(name ? { name } : {}) };
}

function sessionOf(event: ClaudeCodeEvent): { sessionId?: string } {
  return event.session_id ? { sessionId: event.session_id } : {};
}

/**
 * The command as it would run from the repository root. Claude Code's shell
 * keeps its directory between calls, so `npm test` typed in `packages/core`
 * is recorded as `cd packages/core && npm test`, which `graft check --rerun`
 * can repeat.
 */
async function atRoot(command: string, cwd: string | undefined, topLevel: string): Promise<string> {
  if (!cwd || /^\s*cd\s/.test(command)) return command;
  const real = async (p: string) => realpath(p).catch(() => p);
  const rel = relative(await real(topLevel), await real(cwd)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return command;
  return `cd ${/^[\w./-]+$/.test(rel) ? rel : JSON.stringify(rel)} && ${command}`;
}

function claudeAuthor(event: ClaudeCodeEvent): ChangeAuthor {
  const m = event.model;
  const model = (typeof m === "string" ? m : m?.id)?.trim();
  return { kind: "agent", name: "claude-code", ...(model ? { model } : {}) };
}

/**
 * The person's words when the prompt is a harness envelope rather than what
 * they typed. A Claude Projects thread hands the session a `<wake>` block
 * whose `trigger="true"` message holds the text; record that, unescaped,
 * instead of 500 characters of markup. Any other prompt is returned as is.
 */
export function promptTask(prompt: string): string {
  if (!/^\s*<wake[\s>]/.test(prompt)) return prompt;
  const trigger = /<message\b[^>]*\btrigger="true"[^>]*>([\s\S]*?)<\/message>/.exec(prompt);
  if (!trigger) return prompt;
  const text = unescapeXml(trigger[1]).trim();
  // A harness line (a spawn notice) is not the task either; fall back to the envelope rather than record it.
  if (!text || /\bfrom="system"/.test(trigger[0].slice(0, trigger[0].indexOf(">")))) return prompt;
  return text;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (ref, hex, dec) => {
      const code = hex ? parseInt(hex, 16) : Number(dec);
      return code <= 0x10ffff ? String.fromCodePoint(code) : ref;
    })
    .replace(/&amp;/g, "&");
}

function clipTask(task: string): string {
  const oneBlock = task.replace(/\r/g, "").trim();
  return oneBlock.length > TASK_CAP ? oneBlock.slice(0, TASK_CAP - 1) + "…" : oneBlock;
}
