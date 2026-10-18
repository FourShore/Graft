import type { Graft } from "./graft.js";
import type { ChangeAuthor } from "./record.js";
import { classifyCommand, relativizeCommand } from "./capture.js";
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
  tool_input?: { command?: string; description?: string };
  tool_response?: { stdout?: string; stderr?: string; interrupted?: boolean };
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}

export type CaptureOutcome =
  | { action: "ignored"; reason: string }
  | { action: "started"; id: string; task: string }
  | { action: "recorded"; id: string; label: string; command: string; exitCode: number; opened: boolean; name?: string };

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
    const task = (event.prompt ?? "").trim();
    if (!task) return { action: "ignored", reason: "empty prompt" };
    if (task.startsWith("/")) return { action: "ignored", reason: "slash command" };
    if (await graft.status()) return { action: "ignored", reason: "a change is already open" };
    const record = await graft.start({ task: clipTask(promptTask(task)), author: claudeAuthor(event), capturedBy: "claude-code" });
    return { action: "started", id: record.id, task: record.task };
  }
  if (event.hook_event_name !== "PostToolUse" && event.hook_event_name !== "PostToolUseFailure") {
    return { action: "ignored", reason: `event ${event.hook_event_name}` };
  }
  if (event.tool_name !== "Bash") return { action: "ignored", reason: `tool ${event.tool_name}` };
  const typed = (event.tool_input?.command ?? "").trim();
  if (!typed) return { action: "ignored", reason: "no command" };
  if (event.is_interrupt || event.tool_response?.interrupted) return { action: "ignored", reason: "interrupted" };
  const topLevel = await graft.git.topLevel();
  const policy = await readPolicy(topLevel);
  const command = relativizeCommand(typed, topLevel);
  const name = matchCatalog(policy, command);
  const kind = name ? "catalog" : classifyCommand(command, policy.captureCommands);
  if (!kind) return { action: "ignored", reason: "not a policy command or a test, build, lint or type-check command" };

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
  if (!(await graft.status())) {
    await graft.start({
      task: `Claude Code session${event.session_id ? ` ${event.session_id}` : ""} (prompt not captured; run graft start "<task>" to name it)`,
      author: claudeAuthor(event),
      capturedBy: "claude-code",
    });
    opened = true;
  }
  const label = name ?? `${kind} (captured)`;
  const ev = await graft.evidenceCaptured({ command, exitCode, output, durationMs: event.duration_ms ?? 0, label, via: "claude-code", ...(name ? { name } : {}) });
  const open = (await graft.status())!;
  return { action: "recorded", id: open.id, label, command: ev.kind === "command" ? ev.command : command, exitCode, opened, ...(name ? { name } : {}) };
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function clipTask(task: string): string {
  const oneBlock = task.replace(/\r/g, "").trim();
  return oneBlock.length > TASK_CAP ? oneBlock.slice(0, TASK_CAP - 1) + "…" : oneBlock;
}
