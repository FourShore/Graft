import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { Graft, builtInRef, foreignTaskRef, splitTrailers } from "../src/graft.js";
import { CAPTURE_AGENTS, commandOf, exitCodeOf, handleCaptureEvent, textOf } from "../src/capture-hook.js";
import { normalizeAgentEvent, replyFor } from "../src/agent-hooks.js";
import { handleClaudeCodeEvent } from "../src/claude-code.js";
import { HOOK_SPECS, hasAgentHooks, installHooks } from "../src/hooks.js";
import { parsePolicy } from "../src/policy.js";

let dir: string;
let graft: Graft;

const sh = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "graft-agents-"));
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.name", "Test"]);
  sh(["config", "user.email", "test@example.com"]);
  delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  graft = new Graft(dir);
});

async function policy(p: object): Promise<void> {
  await mkdir(join(dir, ".graft"), { recursive: true });
  await writeFile(join(dir, ".graft/policy.json"), JSON.stringify({ version: 1, ...p }));
}

describe("payload readers", () => {
  it("find the exit code wherever an agent puts it, or report none", () => {
    expect(exitCodeOf({ exit_code: 1 })).toBe(1);
    expect(exitCodeOf({ exitCode: "0" })).toBe(0);
    expect(exitCodeOf({ metadata: { exit_code: 2 } })).toBe(2);
    expect(exitCodeOf('{"exitCode":3,"output":"x"}')).toBe(3);
    expect(exitCodeOf("Command: npm test\nStdout: ok\nExit Code: 4\n")).toBe(4);
    expect(exitCodeOf({ llmContent: "exit code: 5" })).toBe(5);
    expect(exitCodeOf({ output: "12 passed" })).toBeNull();
    expect(exitCodeOf("all good")).toBeNull();
    expect(exitCodeOf(undefined)).toBeNull();
  });

  it("read the output and the command from objects or JSON strings", () => {
    expect(textOf({ stdout: "a", stderr: "b" })).toBe("a\nb");
    expect(textOf('{"output":"ran"}')).toBe("ran");
    expect(textOf("plain")).toBe("plain");
    expect(textOf({ result: { textResultForLlm: "nested" } })).toBe("nested");
    expect(commandOf({ command: "npm test" })).toBe("npm test");
    expect(commandOf('{"command":"ls"}')).toBe("ls");
    expect(commandOf({ argv: ["go", "test", "./..."] })).toBe("go test ./...");
    expect(commandOf({ path: "x" })).toBeUndefined();
  });
});

describe("agent adapters", () => {
  it("Codex: the same shape as Claude Code, with the exit code read from the tool response", () => {
    expect(normalizeAgentEvent("codex", { hook_event_name: "UserPromptSubmit", prompt: "Fix it", session_id: "c1", model: "gpt-5-codex" })).toEqual({
      kind: "prompt",
      prompt: "Fix it",
      sessionId: "c1",
      model: "gpt-5-codex",
    });
    const run = normalizeAgentEvent("codex", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { exit_code: 1, output: "1 failed" },
      cwd: "/repo",
      session_id: "c1",
    });
    expect(run).toMatchObject({ kind: "run", command: "npm test", exitCode: 1, output: "1 failed", cwd: "/repo", sessionId: "c1" });
    // No response at all on a successful PostToolUse is a pass; a response without a code is unknown.
    expect(normalizeAgentEvent("codex", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" } })).toMatchObject({ exitCode: 0 });
    expect(normalizeAgentEvent("codex", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: "12 passed" })).toMatchObject({ exitCode: null });
    expect(normalizeAgentEvent("codex", { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: {} })).toMatchObject({ kind: "ignore" });
  });

  it("Cursor: beforeSubmitPrompt and postToolUse for the Shell tool, with tool_output as a JSON string", () => {
    expect(normalizeAgentEvent("cursor", { hook_event_name: "beforeSubmitPrompt", prompt: "Add tests", conversation_id: "k1", model: "claude" })).toEqual({
      kind: "prompt",
      prompt: "Add tests",
      sessionId: "k1",
      model: "claude",
    });
    const run = normalizeAgentEvent("cursor", {
      hook_event_name: "postToolUse",
      tool_name: "Shell",
      tool_input: '{"command":"npm run lint"}',
      tool_output: '{"exitCode":2,"output":"src/a.ts: unused"}',
      duration: 300,
      workspace_roots: ["/w"],
      conversation_id: "k1",
    });
    expect(run).toMatchObject({ kind: "run", command: "npm run lint", exitCode: 2, output: "src/a.ts: unused", durationMs: 300, cwd: "/w" });
    // The Shell tool's working_directory is where the command ran; a sub-package's suite is not the root's.
    const sub = normalizeAgentEvent("cursor", { hook_event_name: "postToolUse", tool_name: "Shell", tool_input: { command: "npm test", working_directory: "packages/foo" }, tool_output: { exitCode: 0 } });
    expect(sub).toMatchObject({ command: "cd packages/foo && npm test" });
    const odd = normalizeAgentEvent("cursor", { hook_event_name: "postToolUse", tool_name: "Shell", tool_input: { command: "npm test", working_directory: "it's $HOME" }, tool_output: { exitCode: 0 } });
    expect(odd).toMatchObject({ command: "cd 'it'\\''s $HOME' && npm test" });
    // afterShellExecution carries no exit code, so the run is not recordable.
    expect(normalizeAgentEvent("cursor", { hook_event_name: "afterShellExecution", command: "npm test", output: "ok", duration: 5 })).toMatchObject({ kind: "run", exitCode: null });
    expect(normalizeAgentEvent("cursor", { hook_event_name: "postToolUse", tool_name: "Read", tool_input: {} })).toMatchObject({ kind: "ignore" });
  });

  it("Copilot CLI: camelCase or the VS Code form, toolArgs as a JSON string", () => {
    expect(normalizeAgentEvent("copilot", { hookEventName: "userPromptSubmitted", prompt: "Ship it", sessionId: "p1" })).toEqual({ kind: "prompt", prompt: "Ship it", sessionId: "p1" });
    const camel = normalizeAgentEvent("copilot", {
      hookEventName: "postToolUse",
      sessionId: "p1",
      cwd: "/r",
      toolName: "bash",
      toolArgs: '{"command":"npm test"}',
      toolResult: { resultType: "success", exitCode: 0, textResultForLlm: "12 passed" },
    });
    expect(camel).toMatchObject({ kind: "run", command: "npm test", exitCode: 0, output: "12 passed", cwd: "/r", sessionId: "p1" });
    const snake = normalizeAgentEvent("copilot", {
      hook_event_name: "PostToolUse",
      session_id: "p1",
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_result: { result_type: "failure", text_result_for_llm: "error TS2322" },
    });
    expect(snake).toMatchObject({ kind: "run", command: "npm run build", exitCode: null, output: "error TS2322" });
    expect(normalizeAgentEvent("copilot", { hookEventName: "postToolUse", toolName: "editFile", toolArgs: {} })).toMatchObject({ kind: "ignore" });
  });

  it("Gemini CLI: BeforeAgent and AfterTool for run_shell_command, exit code from the result text", () => {
    expect(normalizeAgentEvent("gemini", { hook_event_name: "BeforeAgent", prompt: "Refactor", session_id: "g1" })).toEqual({ kind: "prompt", prompt: "Refactor", sessionId: "g1" });
    const run = normalizeAgentEvent("gemini", {
      hook_event_name: "AfterTool",
      session_id: "g1",
      cwd: "/g",
      tool_name: "run_shell_command",
      tool_input: { command: "go test ./...", dir_path: "svc" },
      tool_response: { llmContent: "Command: go test ./...\nDirectory: svc\nStdout: ok\nStderr: (empty)\nError: (none)\nExit Code: 0\n", returnDisplay: "ok" },
    });
    expect(run).toMatchObject({ kind: "run", command: "cd svc && go test ./...", exitCode: 0, cwd: "/g" });
    expect((run as { output: string }).output).toContain("Stdout: ok");
    expect(normalizeAgentEvent("gemini", { hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "npm test" }, tool_response: { llmContent: "ok" } })).toMatchObject({ exitCode: null });
    expect(normalizeAgentEvent("gemini", { hook_event_name: "AfterTool", tool_name: "write_file", tool_input: {} })).toMatchObject({ kind: "ignore" });
    expect(normalizeAgentEvent("gemini", "not json")).toMatchObject({ kind: "ignore" });
  });

  it("answers each agent in the shape it reads", () => {
    const note = { action: "ignored" as const, reason: "x", context: "graft: not recorded" };
    const quiet = { action: "ignored" as const, reason: "x" };
    expect(JSON.parse(replyFor("codex", { hook_event_name: "PostToolUse" }, note)!)).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "graft: not recorded" } });
    expect(replyFor("codex", { hook_event_name: "PostToolUse" }, quiet)).toBeNull();
    expect(JSON.parse(replyFor("gemini", { hook_event_name: "AfterTool" }, note)!)).toMatchObject({ hookSpecificOutput: { hookEventName: "AfterTool" } });
    // Cursor blocks a prompt whose hook says nothing.
    expect(JSON.parse(replyFor("cursor", { hook_event_name: "beforeSubmitPrompt" }, quiet)!)).toEqual({ continue: true });
    expect(JSON.parse(replyFor("cursor", { hook_event_name: "postToolUse" }, note)!)).toEqual({ additional_context: "graft: not recorded" });
    expect(replyFor("cursor", { hook_event_name: "postToolUse" }, quiet)).toBeNull();
    expect(JSON.parse(replyFor("copilot", { hookEventName: "postToolUse" }, note)!)).toEqual({ additionalContext: "graft: not recorded" });
  });
});

describe("the shared handler", () => {
  it("records a run from any agent under its own name, and tells the agent when no exit code came", async () => {
    await policy({ commands: { test: "npm test" } });
    const started = await handleCaptureEvent(graft, "codex", { kind: "prompt", prompt: "Fix the parser", sessionId: "c1", model: "gpt-5-codex" });
    expect(started).toMatchObject({ action: "started", task: "Fix the parser" });
    expect((await graft.status())).toMatchObject({ capturedBy: "codex", author: { kind: "agent", name: "codex", model: "gpt-5-codex" } });
    const unknown = await handleCaptureEvent(graft, "cursor", { kind: "run", command: "npm test", exitCode: null, output: "ok", sessionId: "c1" });
    expect(unknown).toMatchObject({ action: "ignored", reason: expect.stringMatching(/Cursor reported no exit code/), context: expect.stringMatching(/graft evidence test/) });
    const other = await handleCaptureEvent(graft, "gemini", { kind: "run", command: "npm test", exitCode: 0, output: "ok", sessionId: "g9" });
    expect(other).toMatchObject({ action: "ignored", context: expect.stringMatching(/another Gemini CLI session/) });
    const run = await handleCaptureEvent(graft, "codex", { kind: "run", command: "npm test", exitCode: 0, output: "12 passed", sessionId: "c1", durationMs: 40 });
    expect(run).toMatchObject({ action: "recorded", name: "test", label: "test", exitCode: 0 });
    expect((await graft.status())?.evidence).toMatchObject([{ kind: "command", command: "npm test", exitCode: 0, via: "codex", name: "test" }]);
    // A run with nothing open opens a placeholder change that names the agent.
    await graft.abandon();
    const orphan = await handleCaptureEvent(graft, "copilot", { kind: "run", command: "npm test", exitCode: 1, output: "", sessionId: "p2" });
    expect(orphan).toMatchObject({ action: "recorded", opened: true });
    expect(await graft.status()).toMatchObject({ task: expect.stringMatching(/^Copilot CLI session p2 \(prompt not captured/), taskPlaceholder: true, capturedBy: "copilot" });
    // Naming it clears the placeholder.
    expect(await graft.start({ task: "Named now" })).toMatchObject({ task: "Named now" });
    expect((await graft.status())?.taskPlaceholder).toBeUndefined();
  });

  it("the Claude Code entry point still works through the adapter", async () => {
    expect(await handleClaudeCodeEvent(graft, { hook_event_name: "UserPromptSubmit", prompt: "Fix the flaky login test", session_id: "s" })).toMatchObject({ action: "started", task: "Fix the flaky login test" });
    expect((await graft.status())?.capturedBy).toBe("claude-code");
    const run = await handleClaudeCodeEvent(graft, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ok" }, session_id: "s" });
    expect(run).toMatchObject({ action: "recorded", exitCode: 0 });
    expect((await graft.status())?.evidence[0]).toMatchObject({ via: "claude-code" });
  });
});

describe('policy task: "named"', () => {
  it("keeps the prompt out of the record and refuses to land until graft start names the task", async () => {
    await policy({ task: "named" });
    expect(await handleCaptureEvent(graft, "claude-code", { kind: "prompt", prompt: "secret customer plan", sessionId: "s1" })).toMatchObject({ action: "ignored", reason: expect.stringMatching(/named/) });
    expect(await graft.status()).toBeNull();
    expect(await graft.sessionTask("s1")).toBeNull();
    const run = await handleCaptureEvent(graft, "claude-code", { kind: "run", command: "npm test", exitCode: 0, output: "ok", sessionId: "s1" });
    expect(run).toMatchObject({ action: "recorded", opened: true, context: expect.stringMatching(/graft start/) });
    const open = (await graft.status())!;
    expect(open.taskPlaceholder).toBe(true);
    expect(open.task).toMatch(/task not named/);
    expect(open.task).not.toContain("secret");
    await writeFile(join(dir, "a.txt"), "a\n");
    await expect(graft.land({ all: true })).rejects.toThrow(/never named.*graft start/);
    await expect(graft.land({ all: true, allowNoEvidence: true })).rejects.toThrow(/never named/);
    await graft.start({ task: "Add the rate limiter" });
    const { record, commit } = await graft.land({ all: true });
    expect(record.task).toBe("Add the rate limiter");
    expect(record.taskPlaceholder).toBeUndefined();
    expect(sh(["log", "-1", "--format=%B", commit])).not.toContain("secret");
  });

  it("is validated, and the captured default still records the prompt", async () => {
    expect(() => parsePolicy(JSON.stringify({ version: 1, task: "secret" }))).toThrow(/"task" must be/);
    expect(parsePolicy(JSON.stringify({ version: 1, task: "captured" })).task).toBe("captured");
    await policy({});
    expect(await handleCaptureEvent(graft, "codex", { kind: "prompt", prompt: "visible task" })).toMatchObject({ action: "started", task: "visible task" });
  });
});

describe("task references from other tools", () => {
  it("reads the session link another tool wrote into the commit message", () => {
    expect(foreignTaskRef("Fix it\n\nClaude-Session: https://claude.ai/code/session_1\nEntire-Checkpoint: abc123def456\n")).toBe("https://claude.ai/code/session_1");
    expect(foreignTaskRef("Fix it\n\nAgent-Logs-Url: https://github.com/o/r/sessions/9")).toBe("https://github.com/o/r/sessions/9");
    expect(foreignTaskRef("Fix it\n\nentire-checkpoint: abc123def456")).toBe("entire:abc123def456");
    expect(foreignTaskRef("Fix it\n\nCo-Authored-By: x")).toBeUndefined();
    expect(foreignTaskRef("Note: the Claude-Session: link is not a trailer here")).toBeUndefined();
    // The hook passes the trailer paragraph, so a subject that reads like a trailer is not one.
    expect(foreignTaskRef(splitTrailers("Claude-Session: https://claude.ai/code/session_1").trailers)).toBeUndefined();
    expect(splitTrailers("Fix: the crash")).toEqual({ body: "Fix: the crash", trailers: "" });
    expect(splitTrailers("Fix the crash\n\nIt was null.\n\nCo-Authored-By: A <a@b>\nClaude-Session: x\n")).toEqual({ body: "Fix the crash\n\nIt was null.", trailers: "Co-Authored-By: A <a@b>\nClaude-Session: x" });
    expect(splitTrailers("Fix the crash\n\nIt was null, see issue: 42.")).toEqual({ body: "Fix the crash\n\nIt was null, see issue: 42.", trailers: "" });
  });

  it("fills Graft-Task-Ref from the Claude Code session variable without a policy, and from a foreign trailer at commit", async () => {
    expect(builtInRef({})).toBeUndefined();
    expect(builtInRef({ CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01ABC" })).toBe("https://claude.ai/code/session_01ABC");
    process.env.CLAUDE_CODE_REMOTE_SESSION_ID = "cse_01ABC";
    try {
      expect((await graft.start({ task: "cloud" })).ref).toBe("https://claude.ai/code/session_01ABC");
    } finally {
      delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
    }
    await graft.abandon({ discard: true });
    // A commit made by Claude Code itself carries Claude-Session; the git hook takes it as the ref.
    const bin = join(dir, ".bin");
    await mkdir(bin, { recursive: true });
    const cli = join(process.cwd(), "packages", "cli", "dist", "cli.js");
    await writeFile(join(bin, "graft"), `#!/bin/sh\nexec node ${JSON.stringify(cli)} "$@"\n`);
    await chmod(join(bin, "graft"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
    await installHooks(graft.git, dir, []);
    await graft.start({ task: "by hand" });
    await graft.evidenceNote("checked");
    await writeFile(join(dir, "a.txt"), "a\n");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "Add a\n\nClaude-Session: https://claude.ai/code/session_77"]);
    expect(git(["log", "-1", "--format=%(trailers:key=Graft-Task-Ref,valueonly)"])).toBe("https://claude.ai/code/session_77");
    expect(git(["log", "-1", "--format=%(trailers:key=Claude-Session,valueonly)"])).toBe("https://claude.ai/code/session_77");
    expect(git(["log", "-1", "--format=%B"])).toMatch(/^Add a\n\nEvidence:\n  \[note\] checked\n\nGraft-Change: \w+\n(Graft-[A-Za-z-]+: .*\n)+Claude-Session: https:\/\/claude\.ai\/code\/session_77$/);
    // The same through graft land, where the trailer comes in as an option.
    await graft.start({ task: "landed" });
    await graft.evidenceNote("checked");
    await writeFile(join(dir, "b.txt"), "b\n");
    await graft.land({ paths: ["b.txt"], title: "Add b", trailers: ["Agent-Logs-Url: https://github.com/o/r/sessions/9"] });
    expect(git(["log", "-1", "--format=%(trailers:key=Graft-Task-Ref,valueonly)"])).toBe("https://github.com/o/r/sessions/9");
  });
});

describe("hook installers", () => {
  it("writes each agent's config in its own shape, idempotently, keeping what is there", async () => {
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(join(dir, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "prettier" }] } }, null, 4));
    const first = await installHooks(graft.git, dir, [...CAPTURE_AGENTS]);
    expect(first.agents).toEqual({ "claude-code": "written", codex: "written", cursor: "written", copilot: "written", gemini: "written" });
    expect(first.claudeCode).toBe("written");

    const codex = JSON.parse(await readFile(join(dir, ".codex/hooks.json"), "utf8"));
    expect(codex.hooks.PostToolUse[0]).toMatchObject({ matcher: "Bash", hooks: [{ type: "command", command: expect.stringContaining("graft hook codex") }] });
    expect(codex.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/^command -v graft/);

    const gemini = JSON.parse(await readFile(join(dir, ".gemini/settings.json"), "utf8"));
    expect(gemini.hooks.AfterTool[0]).toMatchObject({ matcher: "run_shell_command", hooks: [{ type: "command", command: expect.stringContaining("graft hook gemini"), timeout: 15000 }] });
    expect(gemini.hooks.BeforeAgent[0].hooks[0].command).toContain("graft hook gemini");

    const cursorRaw = await readFile(join(dir, ".cursor/hooks.json"), "utf8");
    const cursor = JSON.parse(cursorRaw);
    expect(cursorRaw).toMatch(/^\{\n {4}"/);
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.afterFileEdit).toEqual([{ command: "prettier" }]);
    expect(cursor.hooks.beforeSubmitPrompt[0].command).toContain('{"continue":true}');
    expect(cursor.hooks.postToolUse[0]).toMatchObject({ matcher: "Shell", command: expect.stringContaining("graft hook cursor") });

    const copilot = JSON.parse(await readFile(join(dir, ".github/hooks/graft.json"), "utf8"));
    expect(copilot).toMatchObject({ version: 1, hooks: { userPromptSubmitted: [{ type: "command", bash: expect.stringContaining("graft hook copilot"), powershell: expect.stringContaining("graft hook copilot") }], postToolUse: [{ type: "command", timeoutSec: 15 }] } });

    const second = await installHooks(graft.git, dir, [...CAPTURE_AGENTS]);
    expect(second.agents).toEqual({ "claude-code": "present", codex: "present", cursor: "present", copilot: "present", gemini: "present" });
    expect(JSON.parse(await readFile(join(dir, ".cursor/hooks.json"), "utf8")).hooks.postToolUse).toHaveLength(1);

    // Only the agents asked for are touched.
    const only = await installHooks(graft.git, dir, ["codex"]);
    expect(Object.keys(only.agents)).toEqual(["codex"]);
    expect(only.claudeCode).toBe("present");
    for (const agent of CAPTURE_AGENTS) expect(HOOK_SPECS[agent].command).toContain(`graft hook ${agent}`);
  });
});

describe("the Claude Code plugin's hooks", () => {
  it("step aside where the repo's own hook file runs graft, and record otherwise", async () => {
    const cli = join(process.cwd(), "packages", "cli", "dist", "cli.js");
    const run = (flags: string[], payload: object) =>
      execFileSync("node", [cli, "hook", "claude-code", ...flags], { cwd: dir, encoding: "utf8", input: JSON.stringify(payload) }).trim();
    const prompt = { hook_event_name: "UserPromptSubmit", prompt: "Fix the flaky login test", session_id: "s" };
    // A repo that never ran graft init has no gate to land what the plugin would record: nothing is written there.
    expect(JSON.parse(run(["--plugin", "--json"], prompt))).toMatchObject({ action: "ignored", reason: expect.stringContaining("not set up for Graft") });
    expect(await graft.status()).toBeNull();
    await policy({});
    expect(await hasAgentHooks(dir, "claude-code")).toBe(false);
    run(["--plugin"], prompt);
    expect((await graft.status())?.task).toBe("Fix the flaky login test");
    await graft.abandon({ discard: true });

    await installHooks(graft.git, dir, ["claude-code"]);
    expect(await hasAgentHooks(dir, "claude-code")).toBe(true);
    run(["--plugin"], prompt);
    expect(await graft.status()).toBeNull();
    run([], prompt);
    expect((await graft.status())?.task).toBe("Fix the flaky login test");
  });
});
