import { commandOf, exitCodeOf, int, objectOf, quoteDir, str, textOf, type CaptureAgent, type CaptureEvent, type CaptureOutcome } from "./capture-hook.js";
import { normalizeClaudeCode, type ClaudeCodeEvent } from "./claude-code.js";

/**
 * One adapter per agent: its hook payload in, a capture event out, and the
 * JSON its harness expects back. The field names below are the agents' own,
 * as their hook references document them (October 2026); where a reference
 * leaves the shape of a tool result open, the helpers look in the places the
 * agents are known to use and give up, with a note to the agent, rather than
 * guess a pass.
 */
type Payload = Record<string, unknown>;

export function normalizeAgentEvent(agent: CaptureAgent, payload: unknown): CaptureEvent {
  const p = objectOf(payload);
  if (!p) return { kind: "ignore", reason: "payload is not an object" };
  switch (agent) {
    case "claude-code":
      return normalizeClaudeCode(p as unknown as ClaudeCodeEvent);
    case "codex":
      return normalizeCodex(p);
    case "cursor":
      return normalizeCursor(p);
    case "copilot":
      return normalizeCopilot(p);
    case "gemini":
      return normalizeGemini(p);
  }
}

/**
 * What the hook writes to stdout for the agent. Claude Code, Codex and Gemini
 * CLI read `hookSpecificOutput.additionalContext`; Cursor's prompt hook must
 * answer `continue` or the prompt is blocked, and its tool hook takes
 * `additional_context`; Copilot CLI takes `additionalContext`. Null means
 * print nothing.
 */
export function replyFor(agent: CaptureAgent, payload: unknown, outcome: CaptureOutcome): string | null {
  const p = objectOf(payload) ?? {};
  const event = str(p, "hook_event_name", "hookEventName", "event") ?? "";
  const context = outcome.context;
  switch (agent) {
    case "claude-code":
    case "codex":
    case "gemini":
      return context ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }) : null;
    case "cursor":
      if (event === "beforeSubmitPrompt") return JSON.stringify({ continue: true });
      return context ? JSON.stringify({ additional_context: context }) : null;
    case "copilot":
      return context ? JSON.stringify({ additionalContext: context }) : null;
  }
}

/* ---- Codex: `.codex/hooks.json`, the same event names and stdin shape as Claude Code. ---- */

function normalizeCodex(p: Payload): CaptureEvent {
  const event = str(p, "hook_event_name") ?? "";
  const common = { ...sessionOf(p, "session_id"), ...modelOf(p) };
  if (event === "UserPromptSubmit") return { kind: "prompt", prompt: str(p, "prompt") ?? "", ...common };
  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return { kind: "ignore", reason: `event ${event}` };
  const tool = str(p, "tool_name") ?? "";
  if (!/^(Bash|shell|exec_command|local_shell|shell_command)$/i.test(tool)) return { kind: "ignore", reason: `tool ${tool}` };
  const command = (commandOf(p.tool_input) ?? "").trim();
  if (!command) return { kind: "ignore", reason: "no command" };
  const input = objectOf(p.tool_input);
  // Codex's reference leaves `tool_response` tool-specific; the exit code is read from wherever it is, or the run is not recorded.
  const response = p.tool_response ?? p.error;
  const exitCode = event === "PostToolUse" && response === undefined ? 0 : exitCodeOf(response);
  return {
    kind: "run",
    command,
    exitCode,
    output: textOf(response),
    ...cwdOf(p),
    ...common,
    ...durationOf(p),
    interrupted: Boolean(p.is_interrupt),
    background: Boolean(input && (input.run_in_background || input.background)),
  };
}

/* ---- Cursor: `.cursor/hooks.json`; beforeSubmitPrompt and postToolUse with tool_name Shell. ---- */

function normalizeCursor(p: Payload): CaptureEvent {
  const event = str(p, "hook_event_name") ?? "";
  const common = { ...sessionOf(p, "conversation_id", "session_id"), ...modelOf(p) };
  if (event === "beforeSubmitPrompt") return { kind: "prompt", prompt: str(p, "prompt") ?? "", ...common };
  if (event === "afterShellExecution") {
    // This event carries the command and its output but no exit code; postToolUse (matcher Shell) does.
    const command = (str(p, "command") ?? "").trim();
    if (!command) return { kind: "ignore", reason: "no command" };
    return { kind: "run", command, exitCode: exitCodeOf(p.output), output: textOf(p.output), ...cwdOf(p), ...common, ...durationOf(p) };
  }
  if (event !== "postToolUse" && event !== "postToolUseFailure") return { kind: "ignore", reason: `event ${event}` };
  const tool = str(p, "tool_name") ?? "";
  if (!/^(Shell|Bash|run_terminal_cmd|terminal)$/i.test(tool)) return { kind: "ignore", reason: `tool ${tool}` };
  let command = (commandOf(p.tool_input) ?? "").trim();
  if (!command) return { kind: "ignore", reason: "no command" };
  // The Shell tool runs in `working_directory` under the workspace; record the move so the command re-runs from the root.
  const dir = str(objectOf(p.tool_input), "working_directory", "workingDirectory");
  if (dir && !/^\s*cd\s/.test(command)) command = `cd ${quoteDir(dir)} && ${command}`;
  const result = event === "postToolUse" ? p.tool_output : p.error_message;
  return {
    kind: "run",
    command,
    exitCode: exitCodeOf(result),
    output: textOf(result),
    ...cwdOf(p),
    ...common,
    ...durationOf(p),
    interrupted: Boolean(p.is_interrupt),
    background: Boolean(objectOf(p.tool_input)?.is_background),
  };
}

/* ---- Copilot CLI: `.github/hooks/*.json`; camelCase (`toolName`) or the VS Code form (`tool_name`). ---- */

function normalizeCopilot(p: Payload): CaptureEvent {
  const event = str(p, "hook_event_name", "hookEventName", "event", "type") ?? "";
  const common = { ...sessionOf(p, "sessionId", "session_id"), ...modelOf(p) };
  if (/^(userPromptSubmitted|UserPromptSubmit(ted)?)$/.test(event) || (!event && typeof p.prompt === "string")) {
    return { kind: "prompt", prompt: str(p, "prompt", "userPrompt", "user_prompt", "message") ?? "", ...common };
  }
  const tool = str(p, "toolName", "tool_name") ?? "";
  const args = p.toolArgs ?? p.tool_input ?? p.toolInput;
  const result = p.toolResult ?? p.tool_result ?? p.error;
  const isPost = /^(postToolUse(Failure)?|PostToolUse(Failure)?)$/.test(event) || (!event && tool && result !== undefined);
  if (!isPost) return { kind: "ignore", reason: `event ${event || "unknown"}` };
  if (!/^(bash|Bash|shell|Shell|powershell|run_in_terminal)$/.test(tool)) return { kind: "ignore", reason: `tool ${tool}` };
  const command = (commandOf(args) ?? "").trim();
  if (!command) return { kind: "ignore", reason: "no command" };
  return {
    kind: "run",
    command,
    exitCode: exitCodeOf(result),
    output: textOf(result),
    ...cwdOf(p),
    ...common,
    ...durationOf(p),
    background: Boolean(objectOf(args)?.async || objectOf(args)?.background),
  };
}

/* ---- Gemini CLI: `.gemini/settings.json`; BeforeAgent carries the prompt, AfterTool the run_shell_command result. ---- */

function normalizeGemini(p: Payload): CaptureEvent {
  const event = str(p, "hook_event_name") ?? "";
  const common = { ...sessionOf(p, "session_id"), ...modelOf(p) };
  if (event === "BeforeAgent" || event === "UserPromptSubmit") return { kind: "prompt", prompt: str(p, "prompt") ?? "", ...common };
  if (event !== "AfterTool") return { kind: "ignore", reason: `event ${event}` };
  const tool = str(p, "tool_name") ?? "";
  if (!/^(run_shell_command|shell|Bash)$/i.test(tool)) return { kind: "ignore", reason: `tool ${tool}` };
  const input = objectOf(p.tool_input);
  let command = (commandOf(input) ?? "").trim();
  if (!command) return { kind: "ignore", reason: "no command" };
  // The tool runs in `dir_path` under the cwd; record the move so the command re-runs from the root.
  const dir = str(input, "dir_path", "directory");
  if (dir && !/^\s*cd\s/.test(command)) command = `cd ${quoteDir(dir)} && ${command}`;
  // The shell tool's result names its exit code ("Exit Code: 0") in the text the model sees.
  const response = objectOf(p.tool_response);
  const llm = response?.llmContent ?? response?.returnDisplay ?? p.tool_response;
  const exitCode = exitCodeOf(response) ?? exitCodeOf(llm);
  return {
    kind: "run",
    command,
    exitCode,
    output: textOf(llm) || textOf(response),
    ...cwdOf(p),
    ...common,
    ...durationOf(p),
    background: Boolean(input?.is_background),
  };
}

/* ---- shared field readers ---- */

function sessionOf(p: Payload, ...keys: string[]): { sessionId?: string } {
  const id = str(p, ...keys);
  return id ? { sessionId: id } : {};
}

function modelOf(p: Payload): { model?: string } {
  const m = p.model;
  const id = (typeof m === "string" ? m : str(m, "id", "model_id", "name")) ?? str(p, "model_id");
  return id?.trim() ? { model: id.trim() } : {};
}

function cwdOf(p: Payload): { cwd?: string } {
  const cwd = str(p, "cwd") ?? (Array.isArray(p.workspace_roots) && typeof p.workspace_roots[0] === "string" ? (p.workspace_roots[0] as string) : undefined);
  return cwd ? { cwd } : {};
}

function durationOf(p: Payload): { durationMs?: number } {
  const ms = int(p, "duration_ms", "duration", "durationMs");
  return ms !== null ? { durationMs: ms } : {};
}
