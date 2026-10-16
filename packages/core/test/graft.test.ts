import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { Graft, GraftError } from "../src/graft.js";
import { isChangeId, newChangeId, parseTrailers, shellJoin } from "../src/record.js";

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

  it("satisfies a policy that requires a passing command", async () => {
    await mkdir(join(dir, ".graft"), { recursive: true });
    await writeFile(join(dir, ".graft/policy.json"), JSON.stringify({ version: 1, requireEvidence: "command" }));
    await graft.start({ task: "attach under policy" });
    await writeFile(join(dir, "a.txt"), "a\n");
    await graft.evidenceAttested("make check", 1);
    await expect(graft.land({ all: true })).rejects.toThrow(/passing command/);
    await graft.evidenceAttested("make check", 0);
    await expect(graft.land({ all: true })).resolves.toBeTruthy();
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
    expect(all.text).toContain("plain commit touching a\n  (no change record)");

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
