import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { Graft, GraftError } from "../src/graft.js";
import { isChangeId, newChangeId, parseTrailers, shellJoin } from "../src/record.js";
import { evaluateRules, expandTrailers, matchCatalog, readPolicy } from "../src/policy.js";
import { classifyCommand, relativizeCommand } from "../src/capture.js";
import { globToRegExp, secretFilesNamed } from "../src/redact.js";
import { handleClaudeCodeEvent } from "../src/claude-code.js";
import { installHooks, CLAUDE_SETTINGS_PATH } from "../src/hooks.js";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";

let dir: string;
let graft: Graft;

const sh = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "graft-"));
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.name", "Test"]);
  sh(["config", "user.email", "test@example.com"]);
  graft = new Graft(dir);
});

describe("change ids", () => {
  it("are 20 chars and time-sortable", () => {
    const a = newChangeId(1_000_000);
    const b = newChangeId(2_000_000);
    expect(isChangeId(a)).toBe(true);
    expect(a < b).toBe(true);
  });
});

describe("start / status / abandon", () => {
  it("opens one change at a time", async () => {
    const r = await graft.start({ task: "add rate limiting", author: { name: "test-agent", kind: "agent" } });
    expect(isChangeId(r.id)).toBe(true);
    expect((await graft.status())?.id).toBe(r.id);
    await expect(graft.start({ task: "another" })).rejects.toThrow(/opened \d+ min ago.*--replace/);
    const replaced = await graft.start({ task: "another", replace: true });
    expect(replaced.id).not.toBe(r.id);
    expect((await graft.status())?.task).toBe("another");
    await graft.abandon();
    expect(await graft.status()).toBeNull();
  });

  it("requires a task", async () => {
    await expect(graft.start({ task: "  " })).rejects.toThrow(/task/i);
  });
});

describe("shellJoin", () => {
  it("quotes argv elements so the shell sees them as given", async () => {
    expect(shellJoin(["npm", "test"])).toBe("npm test");
    expect(shellJoin(["node", "-e", 'console.log("a b")'])).toBe(`node -e 'console.log("a b")'`);
    expect(shellJoin(["echo", "it's"])).toBe(`echo 'it'\\''s'`);
    expect(shellJoin(["npm test && npm run lint"])).toBe("npm test && npm run lint");
    expect(shellJoin(["go", "version", "2>&1"])).toBe("go version '2>&1'");
    await graft.start({ task: "q" });
    const ev = await graft.evidenceCommand(shellJoin(["node", "-e", 'console.log("a b", (1+1))']));
    expect(ev.kind === "command" && [ev.exitCode, ev.output.trim()]).toEqual([0, "a b 2"]);
  });
});

describe("shellJoin on Windows", () => {
  it("quotes for cmd.exe and the C runtime instead of POSIX sh", () => {
    expect(shellJoin(["npm", "test"], "win32")).toBe("npm test");
    expect(shellJoin(["type", "C:\\logs\\out.txt"], "win32")).toBe("type C:\\logs\\out.txt");
    expect(shellJoin(["node", "-e", 'console.log("a b")'], "win32")).toBe('node -e ^"console.log^(\\^"a b\\^"^)^"');
    expect(shellJoin(["echo", "100%", "x&y"], "win32")).toBe('echo ^"100^%^" ^"x^&y^"');
    expect(shellJoin(["go", "version", "2>&1"], "win32")).toBe('go version ^"2^>^&1^"');
    expect(shellJoin(["dir", "C:\\a b\\"], "win32")).toBe('dir ^"C:\\a b\\\\^"');
    expect(shellJoin(["npm test && npm run lint"], "win32")).toBe("npm test && npm run lint");
  });
});

describe("evidence", () => {
  it("records a command's exit code and output", async () => {
    await graft.start({ task: "t" });
    const ok = await graft.evidenceCommand("echo hello", "smoke");
    expect(ok.kind === "command" && ok.exitCode).toBe(0);
    expect(ok.kind === "command" && ok.output.trim()).toBe("hello");
    const bad = await graft.evidenceCommand("exit 3");
    expect(bad.kind === "command" && bad.exitCode).toBe(3);
    expect((await graft.status())?.evidence).toHaveLength(2);
  });

  it("refuses evidence with no open change", async () => {
    await expect(graft.evidenceNote("x")).rejects.toThrow(/No change is open/);
  });
});

describe("land", () => {
  it("writes trailers and a note, then clears the open change", async () => {
    await graft.start({ task: "add greeting", plan: "write hello.txt", author: { name: "test-agent", model: "m-1", kind: "agent" } });
    await writeFile(join(dir, "hello.txt"), "hi\n");
    await graft.evidenceCommand("test -f hello.txt", "file exists");
    const { record, commit } = await graft.land({ all: true });

    expect(sh(["rev-parse", "HEAD"])).toBe(commit);
    const body = sh(["log", "-1", "--format=%B"]);
    const t = parseTrailers(body);
    expect(t["Graft-Change"]).toBe(record.id);
    expect(t["Graft-Task"]).toBe("add greeting");
    expect(t["Graft-Author"]).toBe("agent:test-agent");
    expect(t["Graft-Model"]).toBe("m-1");
    expect(t["Graft-Evidence"]).toBe("1 command, 1 passed");
    expect(body).toContain("Plan:\n  write hello.txt");

    const note = JSON.parse(sh(["notes", "--ref=refs/notes/graft", "show", commit]));
    expect(note.id).toBe(record.id);
    expect(note.evidence[0].command).toBe("test -f hello.txt");
    expect(note.commit).toBe(commit);
    expect(await graft.status()).toBeNull();
  });

  it("refuses to land without evidence unless allowed", async () => {
    await graft.start({ task: "t" });
    await writeFile(join(dir, "a.txt"), "a\n");
    await expect(graft.land({ all: true })).rejects.toThrow(/No evidence/);
    const { commit } = await graft.land({ all: true, allowNoEvidence: true });
    expect(sh(["log", "-1", "--format=%(trailers:key=Graft-Evidence,valueonly)", commit])).toBe("none");
  });

  it("refuses to land with nothing staged", async () => {
    await graft.start({ task: "t" });
    await graft.evidenceNote("checked");
    await expect(graft.land()).rejects.toThrow(/Nothing staged/);
  });

  it("stages only the named paths", async () => {
    await graft.start({ task: "t" });
    await graft.evidenceNote("checked");
    await writeFile(join(dir, "a.txt"), "a\n");
    await writeFile(join(dir, "b.txt"), "b\n");
    const { commit } = await graft.land({ paths: ["a.txt"] });
    expect(sh(["show", "--format=", "--name-only", commit])).toBe("a.txt");
    expect(sh(["status", "--porcelain"])).toBe("?? b.txt");
  });

  it("refuses staged files that look like credentials unless allowed", async () => {
    await graft.start({ task: "t" });
    await graft.evidenceNote("checked");
    await writeFile(join(dir, "src.ts"), "x\n");
    await writeFile(join(dir, ".env"), "SECRET=1\n");
    await writeFile(join(dir, ".env.example"), "SECRET=\n");
    await expect(graft.land({ all: true })).rejects.toThrow(/look like credentials: \.env\./);
    sh(["rm", "-q", "--cached", ".env"]);
    const { commit } = await graft.land();
    expect(sh(["show", "--format=", "--name-only", commit]).split("\n").sort()).toEqual([".env.example", "src.ts"]);
    await graft.start({ task: "t2" });
    await graft.evidenceNote("checked");
    const landed = await graft.land({ all: true, allowSecrets: true });
    expect(sh(["show", "--format=", "--name-only", landed.commit])).toBe(".env");
  });
});

describe("extra trailers", () => {
  it("appends them after Graft's own and rejects bad or reserved ones", async () => {
    await graft.start({ task: "t" });
    await graft.evidenceNote("checked");
    await writeFile(join(dir, "a.txt"), "a\n");
    await expect(graft.land({ all: true, trailers: ["no colon"] })).rejects.toThrow(/expected 'Key: value'/);
    await expect(graft.land({ all: true, trailers: ["Graft-Task: x"] })).rejects.toThrow(/reserved/);
    const { commit } = await graft.land({
      all: true,
      trailers: ["Co-Authored-By: Bot <bot@example.com>", "Session: https://example.com/s/1"],
    });
    const body = sh(["log", "-1", "--format=%B", commit]);
    const keys = body.split("\n").filter((l) => /^[A-Za-z-]+: /.test(l)).map((l) => l.split(":")[0]);
    expect(keys).toEqual(["Graft-Change", "Graft-Task", "Graft-Author", "Graft-Evidence", "Co-Authored-By", "Session"]);
    expect(sh(["log", "-1", "--format=%(trailers:key=Session,valueonly)", commit])).toBe("https://example.com/s/1");
  });
});

describe("redaction", () => {
  it("scrubs secret-looking env values from evidence output and notes", async () => {
    process.env.GRAFT_TEST_API_KEY = "hunter2hunter2";
    process.env.GRAFT_TEST_COLOR = "bluebluebluex";
    process.env.GRAFT_TEST_SEND_GRID_KEY = "SG.abcdefghij";
    try {
      process.env.GRAFT_TEST_AUTH_SERVER_URI = "https://auth.example.com";
      await graft.start({ task: "t" });
      const ev = await graft.evidenceCommand(
        "echo key=$GRAFT_TEST_API_KEY color=$GRAFT_TEST_COLOR uri=$GRAFT_TEST_AUTH_SERVER_URI sg=$GRAFT_TEST_SEND_GRID_KEY",
      );
      expect(ev.kind === "command" && ev.output.trim()).toBe(
        "key=[redacted GRAFT_TEST_API_KEY] color=bluebluebluex uri=https://auth.example.com sg=[redacted GRAFT_TEST_SEND_GRID_KEY]",
      );
      const note = await graft.evidenceNote("token was hunter2hunter2, oops");
      expect(note.kind === "note" && note.text).toBe("token was [redacted GRAFT_TEST_API_KEY], oops");
    } finally {
      delete process.env.GRAFT_TEST_API_KEY;
      delete process.env.GRAFT_TEST_COLOR;
      delete process.env.GRAFT_TEST_SEND_GRID_KEY;
      delete process.env.GRAFT_TEST_AUTH_SERVER_URI;
    }
  });
});

describe("policy trailers", () => {
  it("expands variables and skips trailers whose variable is unset", () => {
    const env = { SESSION: "https://s/1", EMPTY: "" };
    const r = expandTrailers(["Session: $SESSION", "Reviewed-By: ${EMPTY}", "Pair: $NOPE and $SESSION", "Plain: yes"], env);
    expect(r.trailers).toEqual(["Session: https://s/1", "Plain: yes"]);
    expect(r.skipped).toEqual([
      { trailer: "Reviewed-By: ${EMPTY}", missing: "EMPTY" },
      { trailer: "Pair: $NOPE and $SESSION", missing: "NOPE" },
    ]);
  });

  it("strips a literal prefix or suffix with ${NAME#p} and ${NAME%s}", () => {
    const env = { ID: "cse_01abc", FILE: "notes.md" };
    const r = expandTrailers(["Session: https://x/session_${ID#cse_}", "Base: ${FILE%.md}", "Same: ${ID#zzz}", "Gone: ${NOPE#cse_}"], env);
    expect(r.trailers).toEqual(["Session: https://x/session_01abc", "Base: notes", "Same: cse_01abc"]);
    expect(r.skipped).toEqual([{ trailer: "Gone: ${NOPE#cse_}", missing: "NOPE" }]);
  });

  it("writes policy trailers on land, after Graft's own and without duplicating explicit ones", async () => {
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(
      join(dir, ".graft/policy.json"),
      JSON.stringify({ version: 1, trailers: ["Session: $GRAFT_TEST_SESSION", "Co-Authored-By: Bot <bot@example.com>", "Gone: $GRAFT_TEST_UNSET"] }),
    );
    process.env.GRAFT_TEST_SESSION = "https://s/42";
    delete process.env.GRAFT_TEST_UNSET;
    try {
      await graft.start({ task: "trailers" });
      await writeFile(join(dir, "a.txt"), "a\n");
      await graft.evidenceNote("ok");
      const landed = await graft.land({ all: true, trailers: ["Co-Authored-By: Bot <bot@example.com>", "Extra: 1"] });
      expect(landed.skippedTrailers).toEqual([{ trailer: "Gone: $GRAFT_TEST_UNSET", missing: "GRAFT_TEST_UNSET" }]);
      const body = sh(["log", "-1", "--format=%B"]);
      const tail = body.trim().split("\n").slice(-4);
      expect(tail[0]).toMatch(/^Graft-/);
      expect(tail.slice(1)).toEqual(["Session: https://s/42", "Co-Authored-By: Bot <bot@example.com>", "Extra: 1"]);
      expect(body).not.toContain("Gone:");
    } finally {
      delete process.env.GRAFT_TEST_SESSION;
    }
  });
});

describe("command catalog and rules", () => {
  const policy = {
    version: 1 as const,
    requireEvidence: true as const,
    commands: { test: "go test  ./...", vet386: "env GOOS=windows GOARCH=386 go vet ./..." },
    rules: [
      { paths: ["**/*.go"], require: ["test", "vet386"] },
      { paths: ["migrations/**"], require: ["test"] },
    ],
  };

  it("matches a typed command to a catalog name, ignoring whitespace", () => {
    expect(matchCatalog(policy, "go test ./...")).toBe("test");
    expect(matchCatalog(policy, "go test ./pkg/...")).toBeNull();
    expect(matchCatalog({ version: 1, requireEvidence: true }, "go test ./...")).toBeNull();
  });

  it("reports the named commands a change's files need and its evidence lacks", () => {
    const at = new Date().toISOString();
    const pass = (extra: object) => ({ kind: "command" as const, at, exitCode: 0, durationMs: 1, output: "", command: "x", ...extra });
    expect(evaluateRules(policy, ["README.md"], [])).toEqual([]);
    expect(evaluateRules(policy, ["cmd/a.go", "README.md"], [])).toEqual([
      { name: "test", command: "go test  ./...", files: ["cmd/a.go"] },
      { name: "vet386", command: "env GOOS=windows GOARCH=386 go vet ./...", files: ["cmd/a.go"] },
    ]);
    // Covered by name, by label (a record rebuilt from the message), or by the catalog's command text.
    expect(evaluateRules(policy, ["a.go"], [pass({ name: "test" }), pass({ label: "vet386" })])).toEqual([]);
    expect(evaluateRules(policy, ["a.go"], [pass({ command: "go test ./..." }), pass({ command: "env GOOS=windows GOARCH=386 go vet ./..." })])).toEqual([]);
    // Not covered by a failure, an attested run, or a note.
    expect(evaluateRules(policy, ["migrations/1.sql"], [pass({ name: "test", exitCode: 1 })]).map((u) => u.name)).toEqual(["test"]);
    expect(evaluateRules(policy, ["migrations/1.sql"], [pass({ name: "test", attested: true })]).map((u) => u.name)).toEqual(["test"]);
    expect(evaluateRules(policy, ["migrations/1.sql"], [{ kind: "note", at, text: "test" }]).map((u) => u.name)).toEqual(["test"]);
  });

  it("matches rule globs: ** spans directories, a trailing ** is everything beneath", () => {
    const want = (glob: string, path: string, hit: boolean) => expect(globToRegExp(glob).test(path), `${glob} vs ${path}`).toBe(hit);
    want("src/**", "src/a.ts", true);
    want("src/**", "src/deep/b.ts", true);
    want("src/**", "srcs/a.ts", false);
    want("**/*.go", "a.go", true);
    want("**/*.go", "cmd/x/a.go", true);
    want("**/*.go", "a.go.txt", false);
    want("*.go", "cmd/a.go", true);
    want("hasura/migrations/**", "hasura/migrations/1/up.sql", true);
  });

  it("rejects a policy whose rule names a command the catalog lacks", async () => {
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(join(dir, ".graft/policy.json"), JSON.stringify({ version: 1, rules: [{ paths: ["**/*.go"], require: ["test"] }] }));
    await expect(readPolicy(dir)).rejects.toThrow(/requires "test", which "commands" does not define/);
    await writeFile(join(dir, ".graft/policy.json"), JSON.stringify({ version: 1, commands: { "bad name": "x" } }));
    await expect(readPolicy(dir)).rejects.toThrow(/command name "bad name"/);
  });

  it("runs a command by name, records the name, and gates land on the rules for the staged files", async () => {
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(
      join(dir, ".graft/policy.json"),
      JSON.stringify({
        version: 1,
        commands: { test: "echo tests ok", lint: "echo lint ok" },
        rules: [{ paths: ["src/**"], require: ["test", "lint"] }],
      }),
    );
    expect(await graft.catalog()).toEqual({ test: "echo tests ok", lint: "echo lint ok" });
    await graft.start({ task: "catalog", ref: "https://example.com/thread/1" });
    await expect(graft.evidenceNamed("nope")).rejects.toThrow(/No command named "nope".*Known: test, lint/);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "a\n");
    await writeFile(join(dir, "README.md"), "r\n");
    const ev = await graft.evidenceNamed("test");
    expect(ev).toMatchObject({ kind: "command", name: "test", command: "echo tests ok", exitCode: 0, output: "tests ok\n" });
    await expect(graft.land({ all: true })).rejects.toThrow(/passing run of "lint" \(echo lint ok\) for changes to src\/a\.ts.*graft evidence lint/);
    // A file outside the rule's paths lands with what is there (the failed attempt above left src/a.ts staged).
    sh(["rm", "-q", "--cached", "src/a.ts"]);
    await expect(graft.land({ paths: ["README.md"] })).resolves.toBeTruthy();
    await graft.start({ task: "catalog 2" });
    await graft.evidenceNamed("test", "unit");
    await graft.evidenceCommand("echo lint ok", "the lint, typed by hand");
    const { commit } = await graft.land({ all: true });
    const body = sh(["log", "-1", "--format=%B"]);
    expect(body).toContain("Evidence:\n  [pass unit] echo tests ok (");
    expect(body).toContain("  [pass the lint, typed by hand] echo lint ok (");

    // Rebuilt from the message, a named run keeps its name as the label and a ref survives in its trailer.
    sh(["notes", "--ref=refs/notes/graft", "remove", commit]);
    await graft.start({ task: "catalog 3", ref: "https://example.com/thread/2" });
    await writeFile(join(dir, "src", "a.ts"), "b\n");
    await graft.evidenceNamed("test");
    await graft.evidenceNamed("lint");
    const third = await graft.land({ all: true });
    expect(sh(["log", "-1", "--format=%B"])).toMatch(/^Graft-Task-Ref: https:\/\/example\.com\/thread\/2$/m);
    sh(["notes", "--ref=refs/notes/graft", "remove", third.commit]);
    const rebuilt = await graft.show(third.commit);
    expect(rebuilt?.recordSource).toBe("message");
    expect(rebuilt?.record?.ref).toBe("https://example.com/thread/2");
    expect(rebuilt?.record?.evidence.map((e) => e.label)).toEqual(["test", "lint"]);
    expect(evaluateRules(await readPolicy(dir), ["src/a.ts"], rebuilt!.record!.evidence)).toEqual([]);
  });
});

describe("capture", () => {
  it("classifies test, build, lint and type-check commands and nothing else", () => {
    expect(classifyCommand("npm test")).toBe("test");
    expect(classifyCommand("cd packages/core && npx vitest run --reporter dot")).toBe("test");
    expect(classifyCommand("go test ./...")).toBe("test");
    expect(classifyCommand("npm run build")).toBe("build");
    expect(classifyCommand("cargo clippy -- -D warnings")).toBe("lint");
    expect(classifyCommand("npx tsc -p .")).toBe("typecheck");
    expect(classifyCommand("ls -la")).toBeNull();
    expect(classifyCommand("git status")).toBeNull();
    expect(classifyCommand("./scripts/verify.sh", ["^\\./scripts/verify"])).toBe("custom");
    expect(classifyCommand("./scripts/verify.sh", ["("])).toBeNull();
  });

  it("rewrites absolute paths under the repository root so a captured command re-runs elsewhere", () => {
    const top = "/home/me/repo";
    expect(relativizeCommand("cd /home/me/repo && go test ./...", top)).toBe("go test ./...");
    expect(relativizeCommand("cd /home/me/repo/pkg && go test ./...", top)).toBe("cd ./pkg && go test ./...");
    expect(relativizeCommand('cd "/home/me/repo/" && npm test', top)).toBe("npm test");
    expect(relativizeCommand("npm test -- /home/me/repo/src/a.test.ts", top)).toBe("npm test -- ./src/a.test.ts");
    expect(relativizeCommand("echo a && cd /home/me/repo; npm test", top)).toBe("echo a && npm test");
    expect(relativizeCommand("cd /home/me/repository && x", top)).toBe("cd /home/me/repository && x");
    expect(relativizeCommand("cd /mnt/backup/home/me/repo/x && npm test", top)).toBe("cd /mnt/backup/home/me/repo/x && npm test");
    expect(relativizeCommand("cd /home/me/repo/ && npm test", top)).toBe("npm test");
    expect(relativizeCommand("ROOT=/home/me/repo npm test", top)).toBe("ROOT=. npm test");
    expect(relativizeCommand("npm test", top)).toBe("npm test");
    expect(relativizeCommand("cd C:\\Users\\z\\repo\\pkg && go test ./...", "C:/Users/z/repo")).toBe("cd ./pkg && go test ./...");
    expect(relativizeCommand("cd c:/users/z/repo && go test ./...", "C:/Users/z/repo")).toBe("go test ./...");
  });

  it("finds the credential files a command names", () => {
    expect(secretFilesNamed("cat nova.json && go test ./...", ["nova.json"])).toEqual(["nova.json"]);
    expect(secretFilesNamed("cat nova.json && go test ./...")).toEqual([]);
    expect(secretFilesNamed('docker run --env-file=.env img; cat "keys/id_rsa" | wc')).toEqual([".env", "keys/id_rsa"]);
    expect(secretFilesNamed("cp .env.example .env")).toEqual([".env"]);
    expect(secretFilesNamed("go test ./... -run TestKey")).toEqual([]);
  });

  it("opens a change from the prompt, records matching Bash runs with the harness's exit code, ignores the rest", async () => {
    expect(await handleClaudeCodeEvent(graft, { hook_event_name: "UserPromptSubmit", prompt: "  " })).toMatchObject({ action: "ignored" });
    expect(await handleClaudeCodeEvent(graft, { hook_event_name: "UserPromptSubmit", prompt: "/clear" })).toMatchObject({ action: "ignored" });
    const started = await handleClaudeCodeEvent(graft, { hook_event_name: "UserPromptSubmit", prompt: "Fix the flaky test" });
    expect(started).toMatchObject({ action: "started", task: "Fix the flaky test" });
    expect((await graft.status())?.capturedBy).toBe("claude-code");
    expect(await handleClaudeCodeEvent(graft, { hook_event_name: "UserPromptSubmit", prompt: "another prompt" })).toMatchObject({ action: "ignored" });

    expect(await handleClaudeCodeEvent(graft, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a" } })).toMatchObject({ action: "ignored" });
    expect(await handleClaudeCodeEvent(graft, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: {} })).toMatchObject({ action: "ignored" });
    const pass = await handleClaudeCodeEvent(graft, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "12 passed\n", stderr: "" },
      duration_ms: 2500,
    });
    expect(pass).toMatchObject({ action: "recorded", label: "test (captured)", exitCode: 0, opened: false });
    const fail = await handleClaudeCodeEvent(graft, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm run lint" },
      error: "Exit code 1\nsrc/a.ts:3 unused",
      duration_ms: 300,
    });
    expect(fail).toMatchObject({ action: "recorded", label: "lint (captured)", exitCode: 1 });
    expect(await handleClaudeCodeEvent(graft, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, error: "spawn failed" })).toMatchObject({ action: "ignored" });
    expect(await handleClaudeCodeEvent(graft, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "", interrupted: true } })).toMatchObject({ action: "ignored" });

    const open = (await graft.status())!;
    expect(open.evidence).toMatchObject([
      { kind: "command", command: "npm test", exitCode: 0, durationMs: 2500, output: "12 passed\n", via: "claude-code", label: "test (captured)" },
      { kind: "command", command: "npm run lint", exitCode: 1, durationMs: 300, output: "src/a.ts:3 unused", via: "claude-code" },
    ]);

    // An explicit start adopts the hook-opened change instead of refusing.
    const named = await graft.start({ task: "Fix the flaky retry test", plan: "bump the timeout" });
    expect(named.id).toBe(open.id);
    expect(named.task).toBe("Fix the flaky retry test");
    expect(named.evidence).toHaveLength(2);
    await expect(graft.start({ task: "again" })).resolves.toMatchObject({ id: open.id });
    await graft.abandon();

    // A run with nothing open opens a placeholder change so the evidence is not lost.
    const top = await graft.git.topLevel();
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(join(dir, ".graft/policy.json"), JSON.stringify({ version: 1, commands: { test: "npm test", vet386: "env GOOS=windows GOARCH=386 go vet ./..." } }));
    const byName = await handleClaudeCodeEvent(graft, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: `cd ${top} && env  GOOS=windows GOARCH=386 go vet ./...` },
      tool_response: { stdout: "" },
    });
    expect(byName).toMatchObject({ action: "recorded", name: "vet386", label: "vet386", command: "env  GOOS=windows GOARCH=386 go vet ./..." });
    expect((await graft.status())!.evidence.at(-1)).toMatchObject({ name: "vet386", label: "vet386", via: "claude-code" });
    await rm(join(dir, ".graft"), { recursive: true });
    const moved = await handleClaudeCodeEvent(graft, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: `cd ${top}/sub && npm test` },
      tool_response: { stdout: "ok" },
    });
    expect(moved).toMatchObject({ action: "recorded", command: "cd ./sub && npm test" });
    const leaky = await handleClaudeCodeEvent(graft, {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat .env && npm test" },
      tool_response: { stdout: "API_KEY=hunter2hunter2\n12 passed" },
    });
    expect(leaky).toMatchObject({ action: "recorded", exitCode: 0 });
    const captured = (await graft.status())!.evidence.at(-1);
    expect(captured).toMatchObject({ kind: "command", command: "cat .env && npm test", output: "[output withheld: the command names .env, which looks like a credential file]" });
    await graft.abandon();
    const orphan = await handleClaudeCodeEvent(graft, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm run build" }, tool_response: { stdout: "" } });
    expect(orphan).toMatchObject({ action: "recorded", opened: true });
    expect((await graft.status())?.task).toMatch(/prompt not captured/);
  });

  it("installs Claude Code and git hooks idempotently and leaves foreign hooks alone", async () => {
    const hooksDir = join(dir, ".git", "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, "post-commit"), "#!/bin/sh\necho mine\n");
    const first = await installHooks(graft.git, dir);
    expect(first).toMatchObject({ claudeCode: "written", git: { "prepare-commit-msg": "written", "post-commit": "foreign" } });
    const settings = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_PATH), "utf8"));
    expect(Object.keys(settings.hooks)).toEqual(["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"]);
    expect(settings.hooks.PostToolUse[0]).toMatchObject({ matcher: "Bash", hooks: [{ type: "command", command: "graft hook claude-code" }] });
    expect(await readFile(join(hooksDir, "post-commit"), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(await readFile(join(hooksDir, "prepare-commit-msg"), "utf8")).toContain("graft hook prepare-commit-msg");

    const second = await installHooks(graft.git, dir);
    expect(second).toMatchObject({ claudeCode: "present", git: { "prepare-commit-msg": "present", "post-commit": "foreign" } });

    // Other settings survive and the hooks are not added twice.
    await writeFile(join(dir, CLAUDE_SETTINGS_PATH), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier" }] }] } }));
    await installHooks(graft.git, dir);
    const merged = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_PATH), "utf8"));
    expect(merged.permissions.allow).toEqual(["Bash(npm test)"]);
    expect(merged.hooks.PostToolUse).toHaveLength(2);
  });

  it("prepare-commit-msg adds the record and post-commit attaches the note; merges and amends are left alone", async () => {
    await writeFile(join(dir, "a.txt"), "a\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "base"]);
    const msgFile = join(dir, ".git", "MSG");

    await writeFile(msgFile, "Anything\n");
    expect(await graft.prepareCommitMessage(msgFile)).toMatchObject({ applied: false, reason: "no change is open" });

    await graft.start({ task: "hooked change", plan: "do it" });
    await writeFile(join(dir, "a.txt"), "b\n");
    sh(["add", "a.txt"]);
    await writeFile(msgFile, "Title\n");
    await expect(graft.prepareCommitMessage(msgFile)).rejects.toThrow(/GRAFT_ALLOW_NO_EVIDENCE/);
    await graft.evidenceNote("looked");
    expect(await graft.prepareCommitMessage(msgFile, "merge")).toMatchObject({ applied: false });
    expect(await graft.prepareCommitMessage(msgFile, "commit")).toMatchObject({ applied: false });

    // Editor flow: git's comment block follows the record.
    await writeFile(msgFile, "\n# Please enter the commit message\n#\n# Changes to be committed:\n");
    const r = await graft.prepareCommitMessage(msgFile, "template");
    expect(r.applied).toBe(true);
    const prepared = await readFile(msgFile, "utf8");
    expect(prepared).toMatch(/^\n\nPlan:\n  do it\n\nEvidence:\n  \[note\] looked\n\nGraft-Change: /);
    expect(prepared.indexOf("# Please enter")).toBeGreaterThan(prepared.indexOf("Graft-Evidence:"));
    expect(await graft.prepareCommitMessage(msgFile)).toMatchObject({ applied: false, reason: "message already carries a record" });

    expect(await graft.finishCommit()).toMatchObject({ attached: false, reason: "HEAD does not carry the open change" });
    sh(["commit", "-q", "-F", msgFile, "--cleanup=strip"]);
    const fin = await graft.finishCommit();
    expect(fin).toMatchObject({ attached: true, id: r.id });
    expect(await graft.status()).toBeNull();
    const shown = await graft.show(fin.commit!);
    expect(shown?.recordSource).toBe("note");
    expect(shown?.record).toMatchObject({ id: r.id, task: "hooked change", plan: "do it", commit: fin.commit });
    expect(shown?.record?.landedAt).toBeTruthy();
  });

  it("a plain git commit lands the open change through the installed hooks", async () => {
    const cli = join(process.cwd(), "packages", "cli", "dist", "cli.js");
    if (!existsSync(cli)) return; // needs a build; npm test runs after npm run build
    const bin = join(dir, ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "graft"), `#!/bin/sh\nexec node ${JSON.stringify(cli)} "$@"\n`);
    await chmod(join(bin, "graft"), 0o755);
    await installHooks(graft.git, dir);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });

    await writeFile(join(dir, "a.txt"), "a\n");
    git(["add", "-A"]);
    await graft.start({ task: "via git commit" });
    await graft.evidenceCommand("true", "smoke");
    git(["commit", "-q", "-m", "Plain commit"]);
    const body = git(["log", "-1", "--format=%B"]);
    expect(body).toMatch(/^Plain commit\n\nEvidence:\n  \[pass smoke\] true/);
    expect(await graft.status()).toBeNull();
    const entry = (await graft.log())[0];
    expect(entry.recordSource).toBe("note");
    expect(entry.record?.task).toBe("via git commit");

    // graft land still works with the hooks installed and does not double-apply.
    await graft.start({ task: "via land" });
    await writeFile(join(dir, "a.txt"), "b\n");
    await graft.evidenceNote("ok");
    const landed = await graft.land({ all: true });
    expect(git(["log", "-1", "--format=%B"]).match(/Graft-Change:/g)).toHaveLength(1);
    expect((await graft.show(landed.commit))?.recordSource).toBe("note");
  });
});

describe("attested evidence", () => {
  it("records a run the author made, marks it attested, and round-trips through the message", async () => {
    await graft.start({ task: "attach" });
    await writeFile(join(dir, "a.txt"), "a\n");
    const ok = await graft.evidenceAttested("go test ./...", 0, "ok  \tpkg\t0.3s\n", "go tests");
    expect(ok).toMatchObject({ kind: "command", attested: true, exitCode: 0, durationMs: 0, label: "go tests" });
    await graft.evidenceAttested("yarn build", 2);
    await expect(graft.evidenceAttested("  ", 0)).rejects.toThrow(/command/);
    await expect(graft.evidenceAttested("x", 1.5)).rejects.toThrow(/integer/);
    const { commit } = await graft.land({ all: true });
    const body = sh(["log", "-1", "--format=%B"]);
    expect(body).toContain("Evidence:\n  [attested go tests] go test ./...\n  [attested fail 2] yarn build\n");
    expect(body).toMatch(/^Graft-Evidence: 2 commands, 1 passed$/m);

    sh(["notes", "--ref=refs/notes/graft", "remove", commit]);
    const rebuilt = await graft.show(commit);
    expect(rebuilt?.recordSource).toBe("message");
    expect(rebuilt?.record?.evidence).toEqual([
      { kind: "command", at: expect.any(String), command: "go test ./...", exitCode: 0, durationMs: 0, output: "", label: "go tests", attested: true },
      { kind: "command", at: expect.any(String), command: "yarn build", exitCode: 2, durationMs: 0, output: "", label: undefined, attested: true },
    ]);
  });

  it("does not satisfy a policy that requires a passing command, since it is a claim", async () => {
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(join(dir, ".graft/policy.json"), JSON.stringify({ version: 1, requireEvidence: "command" }));
    await graft.start({ task: "attach under policy" });
    await writeFile(join(dir, "a.txt"), "a\n");
    await graft.evidenceAttested("make check", 0);
    await expect(graft.land({ all: true })).rejects.toThrow(/attested runs alone do not count/);
    await graft.evidenceCommand("true", "smoke");
    await expect(graft.land({ all: true })).resolves.toBeTruthy();
  });

  it("withholds the output of a command that names a credential file", async () => {
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(join(dir, ".graft/policy.json"), JSON.stringify({ version: 1, requireEvidence: true, secretFiles: ["nova.json"] }));
    await writeFile(join(dir, "nova.json"), '{"agentKey":"k-1234567890"}\n');
    await graft.start({ task: "leaky" });
    const run = await graft.evidenceCommand("cat nova.json && echo tests passed", "go tests");
    expect(run).toMatchObject({ kind: "command", exitCode: 0, output: "[output withheld: the command names nova.json, which looks like a credential file]" });
    const attested = await graft.evidenceAttested("cat nova.json && go test ./...", 0, '{"agentKey":"k-1234567890"}');
    expect(attested).toMatchObject({ output: "[output withheld: the command names nova.json, which looks like a credential file]" });
    const clean = await graft.evidenceCommand("echo nova", "clean");
    expect(clean).toMatchObject({ output: "nova\n" });
    const stored = (await graft.status())!;
    expect(JSON.stringify(stored)).not.toContain("k-1234567890");
  });
});

describe("context", () => {
  it("returns the recorded changes that touched the paths, newest first, within a budget", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "a\n");
    await writeFile(join(dir, "other.txt"), "o\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "plain commit touching a"]);

    await graft.start({ task: "first change to a", plan: "edit a\ncarefully" });
    await writeFile(join(dir, "src", "a.ts"), "a2\n");
    await graft.evidenceCommand("echo ok", "smoke");
    await graft.land({ all: true });

    await graft.start({ task: "only other" });
    await writeFile(join(dir, "other.txt"), "o2\n");
    await graft.evidenceNote("looked");
    await graft.land({ all: true });

    await graft.start({ task: "second change to a" });
    await writeFile(join(dir, "src", "a.ts"), "a3\n");
    await graft.evidenceNote("checked by hand");
    const second = await graft.land({ all: true });

    const ctx = await graft.context(["src"]);
    expect(ctx.entries.map((e) => e.record?.task)).toEqual(["second change to a", "first change to a"]);
    expect(ctx.entries[0].commit).toBe(second.commit);
    expect(ctx.entries[0].files).toEqual(["src/a.ts"]);
    expect(ctx.unrecorded).toBe(1);
    expect(ctx.omitted).toBe(0);
    expect(ctx.text).toContain("Context for src (2 recorded changes, newest first; 1 commit without a record)");
    expect(ctx.text).toContain("  plan: edit a\n        carefully");
    expect(ctx.text).toContain("  evidence: [pass smoke] echo ok (");
    expect(ctx.text).toContain("  files: src/a.ts");
    expect(ctx.text).not.toContain("plain commit");

    const all = await graft.context(["src/a.ts"], { all: true });
    expect(all.entries).toHaveLength(3);
    expect(all.text).toContain("plain commit touching a\n  (no change record)\n  files: src/a.ts");

    await writeFile(join(dir, "old.txt"), "old\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "plain commit touching old"]);
    const onlyPlain = await graft.context(["old.txt"]);
    expect(onlyPlain.entries).toHaveLength(0);
    expect(onlyPlain.unrecorded).toBe(1);
    expect(onlyPlain.text).toContain("pass --all to list them");
    expect((await graft.context(["old.txt"], { all: true })).text).not.toContain("pass --all");

    const whole = await graft.context([]);
    expect(whole.entries).toHaveLength(3);

    const tight = await graft.context(["src"], { budget: 300 });
    expect(tight.entries).toHaveLength(1);
    expect(tight.omitted).toBe(1);
    expect(tight.text).toContain("(1 older commit omitted to fit the budget");
    expect(tight.text.length).toBeLessThanOrEqual(300);

    const plans = await graft.context(["src"], { budget: 360 });
    expect(plans.entries).toHaveLength(2);
    expect(plans.text).not.toContain("carefully");
    expect(plans.text).toContain("evidence: 1 command, 1 passed");
  });

  it("is empty before the first commit", async () => {
    const ctx = await graft.context(["x"]);
    expect(ctx.entries).toEqual([]);
    expect(ctx.text).toContain("0 recorded changes");
  });
});

describe("log and show", () => {
  it("returns changes with records and finds by id", async () => {
    await writeFile(join(dir, "plain.txt"), "p\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "plain commit"]);

    await graft.start({ task: "first" });
    await writeFile(join(dir, "one.txt"), "1\n");
    await graft.evidenceNote("ok");
    const first = await graft.land({ all: true });

    const only = await graft.log({ onlyGraft: true });
    expect(only).toHaveLength(1);
    expect(only[0].record?.task).toBe("first");

    const all = await graft.log({ onlyGraft: false });
    expect(all).toHaveLength(2);
    expect(all[1].record).toBeNull();
    expect(all[1].title).toBe("plain commit");

    const byId = await graft.show(first.record.id);
    expect(byId?.commit).toBe(first.commit);
    const bySha = await graft.show(first.commit.slice(0, 8));
    expect(bySha?.record?.id).toBe(first.record.id);
  });

  it("survives a rebase: the id in the trailer follows the commit", async () => {
    await writeFile(join(dir, "base.txt"), "b\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "base"]);
    sh(["checkout", "-q", "-b", "feature"]);
    await graft.start({ task: "feature work" });
    await writeFile(join(dir, "f.txt"), "f\n");
    await graft.evidenceNote("ok");
    const { record } = await graft.land({ all: true });

    sh(["checkout", "-q", "main"]);
    await writeFile(join(dir, "m.txt"), "m\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "main moves"]);
    sh(["checkout", "-q", "feature"]);
    sh(["rebase", "-q", "main"]);

    const found = await graft.show(record.id);
    expect(found?.trailers["Graft-Task"]).toBe("feature work");
    // The note is keyed by SHA and does not follow by default; the message does.
    expect(found?.recordSource).toBe("message");
    expect(found?.record?.evidence).toEqual([{ kind: "note", at: expect.any(String), text: "ok", label: undefined }]);
  });

  it("rebuilds a record from the commit message when the note is missing", async () => {
    await graft.start({ task: "message record", plan: "first paragraph\n\nsecond paragraph", author: { name: "bot", model: "m-2", kind: "agent" } });
    await writeFile(join(dir, "a.txt"), "a\n");
    await graft.evidenceCommand("true", "unit tests");
    await graft.evidenceCommand("exit 3");
    await graft.evidenceNote("looked at it: twice", "manual");
    const { record, commit } = await graft.land({ all: true });
    const body = sh(["log", "-1", "--format=%B"]);
    expect(body).toMatch(/Evidence:\n  \[pass unit tests\] true \(\d+\.\ds\)\n  \[fail 3\] exit 3 \(\d+\.\ds\)\n  \[note manual\] looked at it: twice\n/);

    const withNote = await graft.show(commit);
    expect(withNote?.recordSource).toBe("note");
    sh(["notes", "--ref=refs/notes/graft", "remove", commit]);
    const rebuilt = await graft.show(commit);
    expect(rebuilt?.recordSource).toBe("message");
    expect(rebuilt?.record).toMatchObject({
      id: record.id,
      task: "message record",
      plan: "first paragraph\n\nsecond paragraph",
      author: { kind: "agent", name: "bot", model: "m-2" },
    });
    expect(rebuilt?.record?.evidence).toMatchObject([
      { kind: "command", command: "true", exitCode: 0, label: "unit tests", output: "" },
      { kind: "command", command: "exit 3", exitCode: 3, label: undefined },
      { kind: "note", text: "looked at it: twice", label: "manual" },
    ]);
    expect((await graft.log())[0].recordSource).toBe("message");
  });

  it("reads back unlabeled entries that contain ': ' exactly, and strips brackets from labels", async () => {
    await graft.start({ task: "colons" });
    await writeFile(join(dir, "a.txt"), "a\n");
    await graft.evidenceCommand("echo status: ok");
    await graft.evidenceNote("Docs only: nova.exe not rebuilt");
    await graft.evidenceCommand("true", "step [1]: lint");
    const { commit } = await graft.land({ all: true });
    sh(["notes", "--ref=refs/notes/graft", "remove", commit]);
    const rebuilt = (await graft.show(commit))?.record?.evidence;
    expect(rebuilt).toMatchObject([
      { kind: "command", command: "echo status: ok", label: undefined },
      { kind: "note", text: "Docs only: nova.exe not rebuilt", label: undefined },
      { kind: "command", command: "true", label: "step 1: lint" },
    ]);
  });
});

describe("init", () => {
  it("sets notes config, adds the fetch refspec, writes a policy file, and is idempotent", async () => {
    const remote = await mkdtemp(join(tmpdir(), "graft-remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(["remote", "add", "origin", remote]);

    const first = await graft.init();
    expect(first.policyWritten).toBe(true);
    expect(first.configured).toContain("notes.rewriteRef");
    expect(first.configured).toContain("remote.origin.fetch");
    expect(sh(["config", "--get", "notes.rewriteRef"])).toBe("refs/notes/graft");
    expect(sh(["config", "--get-all", "remote.origin.fetch"])).toContain("+refs/notes/graft:refs/notes/graft");
    const policy = JSON.parse(await readFile(join(dir, ".graft/policy.json"), "utf8"));
    expect(policy).toEqual({ version: 1, requireEvidence: true });

    const second = await graft.init();
    expect(second.configured).toEqual([]);
    expect(second.policyWritten).toBe(false);
  });

  it("writes the agent instructions to AGENTS.md once and reports the CLAUDE.md hint", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# My repo\n\nRun the linter.\n");
    const first = await graft.init();
    expect(first.agents).toEqual({ written: true, alreadyThere: false, claudeHint: true });
    const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# My repo\n\nRun the linter.\n\n## Version control\n")).toBe(true);
    expect(agents).toContain("graft start");
    expect(agents).toContain("graft_land");

    await writeFile(join(dir, "CLAUDE.md"), "Notes.\n\n@AGENTS.md\n");
    const second = await graft.init();
    expect(second.agents).toEqual({ written: false, alreadyThere: true, coveredBy: "AGENTS.md", claudeHint: false });
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(agents);

    expect((await graft.init({ agents: false })).agents).toBeUndefined();
  });

  it("leaves AGENTS.md alone when CLAUDE.md already covers Graft", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "## Version control\n\nRun `graft start` before editing.\n");
    const r = await graft.init();
    expect(r.agents).toEqual({ written: false, alreadyThere: true, coveredBy: "CLAUDE.md", claudeHint: false });
    await expect(readFile(join(dir, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("creates AGENTS.md when there is none", async () => {
    const r = await graft.init();
    expect(r.agents?.written).toBe(true);
    expect((await readFile(join(dir, "AGENTS.md"), "utf8")).startsWith("## Version control\n")).toBe(true);
  });

  it("works with no remote and reports it", async () => {
    const r = await graft.init();
    expect(r.remote).toBeUndefined();
    expect(r.policyWritten).toBe(true);
  });
});

describe("policy", () => {
  it("requireEvidence: false lets a change land without evidence", async () => {
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(join(dir, ".graft/policy.json"), JSON.stringify({ version: 1, requireEvidence: false }));
    await graft.start({ task: "t" });
    await writeFile(join(dir, "a.txt"), "a\n");
    const { commit } = await graft.land({ all: true });
    expect(commit).toHaveLength(40);
  });

  it("requireEvidence: \"command\" refuses notes-only evidence", async () => {
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(join(dir, ".graft/policy.json"), JSON.stringify({ version: 1, requireEvidence: "command" }));
    await graft.start({ task: "t" });
    await writeFile(join(dir, "a.txt"), "a\n");
    await graft.evidenceNote("checked");
    await expect(graft.land({ all: true })).rejects.toThrow(/passing command/);
    await graft.evidenceCommand("false");
    await expect(graft.land({ all: true })).rejects.toThrow(/passing command/);
    await graft.evidenceCommand("true");
    expect((await graft.land({ all: true })).commit).toHaveLength(40);
  });

  it("rejects an unknown policy version", async () => {
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(join(dir, ".graft/policy.json"), JSON.stringify({ version: 2 }));
    await graft.start({ task: "t" });
    await graft.evidenceNote("ok");
    await writeFile(join(dir, "a.txt"), "a\n");
    await expect(graft.land({ all: true })).rejects.toThrow(/Unsupported policy version/);
  });
});

describe("sync", () => {
  it("pushes notes to a bare remote and a second clone receives the full record", async () => {
    const remote = await mkdtemp(join(tmpdir(), "graft-remote-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    sh(["remote", "add", "origin", remote]);
    await graft.init();

    await graft.start({ task: "shared work" });
    await writeFile(join(dir, "s.txt"), "s\n");
    await graft.evidenceNote("ok");
    const { record, commit } = await graft.land({ all: true });
    sh(["push", "-q", "origin", "main"]);

    const r1 = await graft.sync();
    expect(r1).toMatchObject({ remote: "origin", pushed: true });

    const clone = await mkdtemp(join(tmpdir(), "graft-clone-"));
    execFileSync("git", ["clone", "-q", remote, clone]);
    const other = new Graft(clone);
    expect((await other.show(commit))?.recordSource).toBe("message");
    const r2 = await other.sync();
    expect(r2).toMatchObject({ fetched: true, merged: true });
    const synced = await other.show(commit);
    expect(synced?.recordSource).toBe("note");
    expect(synced?.record?.id).toBe(record.id);
  });

  it("merges records from two clones instead of overwriting", async () => {
    const remote = await mkdtemp(join(tmpdir(), "graft-remote-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    sh(["remote", "add", "origin", remote]);
    await writeFile(join(dir, "base.txt"), "b\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "base"]);
    sh(["push", "-q", "origin", "main"]);

    const clone = await mkdtemp(join(tmpdir(), "graft-clone-"));
    execFileSync("git", ["clone", "-q", remote, clone]);
    execFileSync("git", ["config", "user.email", "b@b"], { cwd: clone });
    execFileSync("git", ["config", "user.name", "b"], { cwd: clone });
    const other = new Graft(clone);

    await graft.start({ task: "a" });
    await writeFile(join(dir, "a.txt"), "a\n");
    await graft.evidenceNote("ok");
    const a = await graft.land({ all: true });
    sh(["push", "-q", "origin", "main"]);
    await graft.sync();

    await other.start({ task: "b" });
    await writeFile(join(clone, "b.txt"), "b\n");
    await other.evidenceNote("ok");
    const b = await other.land({ all: true });
    execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/other"], { cwd: clone });
    await other.sync();

    sh(["fetch", "-q", "origin"]);
    await graft.sync();
    expect((await graft.show(a.commit))?.record?.task).toBe("a");
    expect((await graft.show(b.commit))?.record?.task).toBe("b");
  });

  it("show returns null for an unknown ref", async () => {
    expect(await graft.show("deadbeef")).toBeNull();
  });

  it("fails clearly with no remote", async () => {
    await expect(graft.sync()).rejects.toThrow(/No remote/);
  });

  it("reports a refused notes push instead of failing", async () => {
    const remote = await mkdtemp(join(tmpdir(), "graft-remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    await writeFile(join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho 'notes refused' >&2\nexit 1\n", { mode: 0o755 });
    sh(["remote", "add", "origin", remote]);
    await graft.start({ task: "t" });
    await graft.evidenceNote("checked");
    await writeFile(join(dir, "a.txt"), "a\n");
    await graft.land({ all: true });
    const r = await graft.sync();
    expect(r.pushed).toBe(false);
    expect(r.pushError).toMatch(/notes refused/);
  });
});

describe("policy secretFiles", () => {
  it("extends the credential guard with repo-specific globs", async () => {
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(
      join(dir, ".graft/policy.json"),
      JSON.stringify({ version: 1, requireEvidence: true, secretFiles: ["nova.json", "config/*.secret"] }),
    );
    await graft.start({ task: "t" });
    await graft.evidenceNote("checked");
    await writeFile(join(dir, "nova.json"), "{}\n");
    await expect(graft.land({ all: true })).rejects.toThrow(/credentials: nova\.json/);
    sh(["rm", "-q", "--cached", "nova.json"]);
    await rm(join(dir, "nova.json"));
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(join(dir, "config/db.secret"), "x\n");
    await writeFile(join(dir, "config/db.json"), "x\n");
    await expect(graft.land({ all: true })).rejects.toThrow(/config\/db\.secret/);
    sh(["rm", "-q", "--cached", "config/db.secret"]);
    await rm(join(dir, "config/db.secret"));
    const { commit } = await graft.land();
    expect(sh(["show", "--format=", "--name-only", commit]).split("\n").sort()).toEqual([".graft/policy.json", "config/db.json"]);
  });
});
