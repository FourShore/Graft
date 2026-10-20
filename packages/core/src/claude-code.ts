import type { Graft } from "./graft.js";
import { handleCaptureEvent, type CaptureEvent, type CaptureOutcome } from "./capture-hook.js";

export type { CaptureOutcome } from "./capture-hook.js";

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
 * Claude Code's payload as a capture event: the prompt opens a change, a
 * Bash call that ran is a run with the exit code the harness reported (0 on
 * PostToolUse; from the `Exit code N` line of a PostToolUseFailure).
 */
export function normalizeClaudeCode(event: ClaudeCodeEvent): CaptureEvent {
  const m = event.model;
  const model = (typeof m === "string" ? m : m?.id)?.trim() || undefined;
  const common = { ...(event.session_id ? { sessionId: event.session_id } : {}), ...(model ? { model } : {}) };
  if (event.hook_event_name === "UserPromptSubmit") {
    // Judge the person's words, not the envelope a harness may wrap them in.
    return { kind: "prompt", prompt: promptTask((event.prompt ?? "").trim()), ...common };
  }
  if (event.hook_event_name !== "PostToolUse" && event.hook_event_name !== "PostToolUseFailure") {
    return { kind: "ignore", reason: `event ${event.hook_event_name}` };
  }
  if (event.tool_name !== "Bash") return { kind: "ignore", reason: `tool ${event.tool_name}` };
  const command = (event.tool_input?.command ?? "").trim();
  if (!command) return { kind: "ignore", reason: "no command" };
  let exitCode = 0;
  let output: string;
  if (event.hook_event_name === "PostToolUse") {
    output = [event.tool_response?.stdout ?? "", event.tool_response?.stderr ?? ""].filter(Boolean).join("\n");
  } else {
    const err = event.error ?? "";
    const m = /^Exit code (-?\d+)\n?/.exec(err);
    if (!m) return { kind: "ignore", reason: "failure without an exit code (the shell did not start)" };
    exitCode = Number(m[1]);
    output = err.slice(m[0].length);
  }
  return {
    kind: "run",
    command,
    exitCode,
    output,
    ...(event.cwd ? { cwd: event.cwd } : {}),
    ...common,
    ...(event.duration_ms !== undefined ? { durationMs: event.duration_ms } : {}),
    interrupted: Boolean(event.is_interrupt || event.tool_response?.interrupted),
    background: Boolean(event.tool_input?.run_in_background),
  };
}

/**
 * Turn one Claude Code hook event into a record action (see
 * `handleCaptureEvent`). Never throws for an unknown shape: the hook must
 * not break the session.
 */
export async function handleClaudeCodeEvent(graft: Graft, event: ClaudeCodeEvent): Promise<CaptureOutcome> {
  return handleCaptureEvent(graft, "claude-code", normalizeClaudeCode(event));
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
