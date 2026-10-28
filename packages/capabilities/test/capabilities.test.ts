import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Graft, reviewViaCommand } from "@fourshore/graft-core";
import { runCheck } from "@fourshore/graft-review";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, buildManifest, capabilitiesOf, workspacePackages } from "../src/analyze.js";
import { filesInDiff, parseNameStatus, unquote } from "../src/diff.js";
import { allowedFor, globToRegExp, parseManifest } from "../src/manifest.js";
import { grantKey, scanSource } from "../src/scan.js";
import { packageGrants, packageName } from "../src/table.js";
import { GitTree, WorkTree } from "../src/tree.js";

const CLI = join(process.cwd(), "packages", "capabilities", "dist", "cli.js");

describe("scanSource", () => {
  const caps = (text: string, path = "src/a.ts") => scanSource(path, text).grants.map((g) => `${grantKey(g)}@${g.line}`);

  it("reads capabilities off imports of built-ins, with and without the node: prefix, and ignores harmless ones", () => {
    expect(caps('import { readFile } from "node:fs/promises";\nimport { spawn } from "child_process";\nimport { join } from "node:path";\n')).toEqual(["fs@1", "process@2"]);
    expect(caps('export * from "node:https";\nimport net = require("node:net");\n')).toEqual(["net@1", "net@2"]);
  });

  it("ignores type-only imports", () => {
    expect(caps('import type { ChildProcess } from "node:child_process";\nexport type { Server } from "node:http";\n')).toEqual([]);
  });

  it("reads require() and import() with literal arguments, and counts computed ones as eval", () => {
    expect(caps('const fs = require("fs");\nconst m = await import("node:vm");\n', "lib.cjs")).toEqual(["fs@1", "eval@2"]);
    expect(caps("const x = require(name);\nconst y = await import(`./plugins/${p}.js`);\n", "lib.js")).toEqual(["eval@1", "eval@2"]);
  });

  it("reads the globals: fetch, WebSocket, eval, new Function, process.env, process.exit, process.dlopen", () => {
    const text = [
      'const r = await fetch("https://x");', // 1
      'const ws = new WebSocket("wss://x");', // 2
      "eval(code);", // 3
      'const f = new Function("a", "return a");', // 4
      "const key = process.env.KEY;", // 5
      "process.exit(1);", // 6
      'process.dlopen(m, "x.node");', // 7
      "globalThis.fetch(u);", // 8
    ].join("\n");
    expect(caps(text)).toEqual(["net@1", "net@2", "eval@3", "eval@4", "env@5", "process@6", "native@7"]);
  });

  it("does not take a name the file declares itself for the global", () => {
    expect(caps("function fetch(u: string) { return u; }\nfetch('x');\n")).toEqual([]);
    expect(caps("const process = { env: {} };\nconsole.log(process.env.X);\n")).toEqual([]);
    expect(caps('import { fetch } from "undici";\nfetch("x");\n')).toEqual(["net@1"]);
    expect(caps("const { eval: run } = tools;\nrun(x);\n")).toEqual([]);
  });

  it("maps third-party packages through the table, scoped prefixes included, and reports unknown ones as dep", () => {
    expect(caps('import axios from "axios";\nimport { S3 } from "@aws-sdk/client-s3";\nimport leftPad from "left-pad";\nimport z from "zod";\n')).toEqual(["net@1", "net@2", "dep:left-pad@3"]);
    expect(caps('import "dotenv/config";\n')).toEqual(["env@1", "fs@1"]);
    expect(packageName("@scope/pkg/deep/path")).toBe("@scope/pkg");
    expect(packageName("lodash/fp")).toBe("lodash");
    expect(packageGrants("@octokit/rest", {})).toBeUndefined();
  });

  it("takes the manifest's packages over the built-in table, and the repo's own packages as project code", () => {
    const text = 'import sdk from "my-sdk";\nimport { Graft, reviewViaCommand } from "@fourshore/graft-core";\n';
    expect(scanSource("a.ts", text).grants.map(grantKey)).toEqual(["dep:my-sdk", "dep:@fourshore/graft-core"]);
    expect(scanSource("a.ts", text, { packages: { "my-sdk": ["net"] }, internal: new Set(["@fourshore/graft-core"]) }).grants.map(grantKey)).toEqual(["net"]);
  });

  it("counts a .node addon as native, lists relative imports for inheritance, and reads nothing off other file types", () => {
    const s = scanSource("src/a.ts", 'import addon from "./build/addon.node";\nimport { git } from "./git.js";\nimport x from "../x";\n');
    expect(s.grants.map(grantKey)).toEqual(["native"]);
    expect(s.imports).toEqual([{ specifier: "./git.js", line: 2 }, { specifier: "../x", line: 3 }]);
    expect(scanSource("README.md", 'import fs from "node:fs";').grants).toEqual([]);
    expect(scanSource("src/a.ts", 'import "./native.node";').grants.map(grantKey)).toEqual(["native"]);
  });

  it("resolves names by scope: a local binding hides the global only where it is in scope", () => {
    // A parameter called process in one function does not hide the global in the rest of the file.
    expect(caps("export function f(process: string[]) { return process.length; }\nexport const k = process.env.K;\n")).toEqual(["env@2"]);
    // Neither does an unrelated function's own fetch.
    expect(caps("function withFetch(fetch: any) { return fetch; }\nexport const r = fetch(u);\n")).toEqual(["net@2"]);
    // Block scope and catch clauses bind too.
    expect(caps("{ const fetch = () => 1; fetch(); }\ntry {} catch (process) { process.exit(); }\n")).toEqual([]);
    // A var is hoisted to its function, past the block it is written in.
    expect(caps("function g() { fetch('x'); if (a) { var fetch = h; } }\n")).toEqual([]);
  });

  it("takes require from createRequire and process from node:process for the real thing, under any name", () => {
    const esm = 'import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nreq("node:child_process").execSync("x");\n';
    expect(caps(esm, "a.mjs")).toEqual(["process@3"]);
    expect(caps('const require = createRequire(import.meta.url);\nrequire("child_process");\n', "a.mjs")).toEqual(["process@2"]);
    expect(caps('import proc from "node:process";\nexport const s = proc.env.SECRET;\nproc.exit(1);\n')).toEqual(["env@2", "process@3"]);
    expect(caps('import * as p from "process";\nexport const s = p.env.S;\n')).toEqual(["env@2"]);
    expect(caps('import { env, exit, cwd } from "node:process";\nexport const s = env.S;\n')).toEqual(["env@1", "process@1"]);
    expect(caps("const { env, argv } = process;\nexport const s = env.S;\n")).toEqual(["env@1"]);
    expect(caps('const p = require("process");\np.kill(1);\n', "a.cjs")).toEqual(["process@2"]);
    expect(caps("export const s = globalThis.process.env.S;\nglobalThis.eval(x);\n")).toEqual(["env@1", "eval@2"]);
  });

  it("does not count imports whose every name is a type", () => {
    expect(caps('import { type Stats } from "node:fs";\nimport { type ChildProcess, type SpawnOptions } from "node:child_process";\nexport { type Server } from "node:http";\n')).toEqual([]);
    expect(caps('import { type Stats, readFileSync } from "node:fs";\nimport {} from "node:http";\n')).toEqual(["fs@1", "net@2"]);
  });

  it("does not take a package named after an object property for a table entry", () => {
    expect(caps('import c from "constructor";\nimport t from "toString";\n')).toEqual(["dep:constructor@1", "dep:toString@2"]);
    expect(packageGrants("constructor", {})).toBeUndefined();
    expect(packageGrants("@scope/hasOwnProperty", {})).toBeUndefined();
  });

  it("resolves tsconfig path aliases as project files", () => {
    const s = scanSource("src/app/page.tsx", 'import { cn } from "@/lib/utils";\nimport { x } from "@scope/pkg";\n', { aliases: [{ pattern: "@/*", target: "src/*" }] });
    expect(s.imports).toEqual([{ specifier: "/src/lib/utils", line: 1 }]);
    expect(s.grants.map(grantKey)).toEqual(["dep:@scope/pkg"]);
  });

  it("tolerates a file that does not parse", () => {
    expect(() => scanSource("a.ts", "import { from 'node:fs'; const = ;")).not.toThrow();
  });
});

describe("diff", () => {
  it("lists the files a diff touches with their status and renames", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/gone.js b/gone.js",
      "deleted file mode 100644",
      "--- a/gone.js",
      "+++ /dev/null",
      "diff --git a/fresh.mjs b/fresh.mjs",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/fresh.mjs",
      'diff --git "a/caf\\303\\251 b/x.ts" "b/caf\\303\\251 b/x.ts"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/caf\\303\\251 b/x.ts"',
      "",
    ].join("\n");
    expect(filesInDiff(diff)).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "new.ts", oldPath: "old.ts", status: "renamed" },
      { path: "gone.js", status: "deleted" },
      { path: "fresh.mjs", status: "added" },
      { path: "café b/x.ts", status: "added" },
    ]);
    expect(unquote('"a\\tb"')).toBe("a\tb");
  });

  it("reads git's --name-status -z output, renames and copies included", () => {
    expect(parseNameStatus("M\0a.ts\0A\0b.ts\0D\0c.ts\0R095\0d.ts\0e.ts\0C080\0f.ts\0g.ts\0")).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "b.ts", status: "added" },
      { path: "c.ts", status: "deleted" },
      { path: "e.ts", oldPath: "d.ts", status: "renamed" },
      { path: "g.ts", status: "added" },
    ]);
  });
});

describe("manifest", () => {
  it("parses and validates", () => {
    const m = parseManifest('{"version":1,"allow":[{"paths":["src/git.ts"],"capabilities":["process","fs"]},{"paths":["src/**"],"capabilities":["env"]}],"packages":{"my-sdk":["net"]}}');
    expect([...allowedFor(m, "src/git.ts")].sort()).toEqual(["env", "fs", "process"]);
    expect([...allowedFor(m, "src/a.ts")]).toEqual(["env"]);
    expect([...allowedFor(m, "test/a.ts")]).toEqual([]);
    expect(() => parseManifest("{")).toThrow(/not JSON/);
    expect(() => parseManifest('{"version":2,"allow":[]}')).toThrow(/unknown version/);
    expect(() => parseManifest('{"version":1,"allow":[{"paths":[],"capabilities":[]}]}')).toThrow(/paths must be/);
    expect(() => parseManifest('{"version":1,"allow":[{"paths":["x"],"capabilities":["root"]}]}')).toThrow(/capabilities must list/);
    expect(() => parseManifest('{"version":1,"allow":[],"extra":1}')).toThrow(/unknown key/);
    expect(() => parseManifest('{"version":1,"allow":[],"packages":{"x":["nope"]}}')).toThrow(/packages\["x"\]/);
  });

  it("anchors a glob that starts with ./ to the root, and keeps a package named __proto__ as an entry", () => {
    expect(globToRegExp("./index.js").test("index.js")).toBe(true);
    expect(globToRegExp("./index.js").test("src/billing/index.js")).toBe(false);
    expect(globToRegExp("index.js").test("src/billing/index.js")).toBe(true);
    const m = parseManifest('{"version":1,"allow":[],"packages":{"__proto__":["net"]}}');
    expect(Object.keys(m.packages!)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(m.packages)).toBe(Object.prototype);
  });

  it("matches globs the way the policy does", () => {
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("*.test.ts").test("deep/a.test.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });
});

describe("analyze", () => {
  let dir: string;
  const sh = (args: string[], input?: string) => execFileSync("git", args, { cwd: dir, encoding: "utf8", input }).trim();
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  const commit = (title: string) => {
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", title]);
    return sh(["rev-parse", "HEAD"]);
  };
  const request = (commit?: string, base?: string, diff = "") => ({ name: "capabilities", task: "t", diff, ...(commit ? { commit } : {}), ...(base ? { base } : {}) });
  const diffOfWorktree = () => sh(["diff", "HEAD"]);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "capabilities-"));
    sh(["init", "-q", "-b", "main"]);
    sh(["config", "user.name", "Test"]);
    sh(["config", "user.email", "test@example.com"]);
    await write("package.json", JSON.stringify({ name: "app", dependencies: { zod: "1" } }));
    await write("src/a.ts", 'import { z } from "zod";\nexport const a = z.string();\n');
    await write("src/net.ts", 'import https from "node:https";\nexport const get = (u: string) => https.get(u);\n');
    commit("base");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("reports what a commit's files gained, directly and through a new import, and a new dependency", async () => {
    const base = sh(["rev-parse", "HEAD"]);
    await write("src/a.ts", 'import { z } from "zod";\nimport { get } from "./net.js";\nexport const a = () => fetch(String(z.string()) + get("x"));\n');
    await write("package.json", JSON.stringify({ name: "app", dependencies: { zod: "1", axios: "1", "left-pad": "1" } }));
    const head = commit("reach out");
    const r = await analyze(request(head, base), { cwd: dir, version: "9.9.9" });
    expect(r.model).toBe("graft-capabilities/9.9.9");
    expect(r.verdict).toBe("approve");
    expect(r.findings).toEqual([
      { severity: "warning", file: "package.json", text: "New dependency axios, which grants net." },
      { severity: "warning", file: "package.json", text: "New dependency left-pad, which the table does not know; files that import it hold dep." },
      { severity: "warning", file: "src/a.ts", line: 3, text: "net added: calls fetch." },
    ]);
    expect(r.summary).toBe("1 of 2 files changed capabilities: src/a.ts +net. 2 new dependencies: axios (net), left-pad (unknown).");
    // The inherited net is not a second finding: a.ts holds net itself now.
    expect(r.changes[0].inherited).toEqual([]);
  });

  it("reports a capability inherited through an import as a nit, and a loss as a nit", async () => {
    const base = sh(["rev-parse", "HEAD"]);
    await write("src/a.ts", 'import { get } from "./net.js";\nexport const a = get;\n');
    await write("src/net.ts", "export const get = (u: string) => u;\n");
    const head = commit("rewire");
    const r = await analyze(request(head, base), { cwd: dir });
    // net.ts lost net, so a.ts inherits nothing from it; a.ts lost zod, which was not a capability.
    expect(r.findings).toEqual([{ severity: "nit", file: "src/net.ts", text: "net removed: no longer imports node:https." }]);
    expect(r.summary).toBe("1 of 2 files changed capabilities: src/net.ts -net.");

    await write("src/net.ts", 'import https from "node:https";\nexport const get = (u: string) => https.get(u);\n');
    const again = commit("restore");
    const r2 = await analyze(request(again, head), { cwd: dir });
    expect(r2.findings.map((f) => [f.severity, f.file, f.text])).toEqual([["warning", "src/net.ts", "net added: imports node:https."]]);
    // a.ts inherits net again but did not change, so it is not in the diff and not reported.

    await write("src/b.ts", 'import { get } from "./net.js";\nexport const b = get;\n');
    const third = commit("use it");
    const r3 = await analyze(request(third, again), { cwd: dir });
    expect(r3.findings).toEqual([{ severity: "nit", file: "src/b.ts", line: 1, text: "net inherited: imports ./net.js, which imports node:https." }]);
    expect(r3.summary).toBe("1 of 1 file changed capabilities: src/b.ts +net (inherited).");
  });

  it("reviews the working tree against HEAD when no commit is given, files not yet tracked included", async () => {
    await write("src/a.ts", 'import { spawn } from "node:child_process";\nexport const a = spawn;\n');
    await write("src/new.ts", "export const key = process.env.KEY;\n");
    // Graft's diff of the working tree includes untracked files; a plain `git diff HEAD` does not, so add new.ts to the index for the diff text only.
    sh(["add", "-N", "src/new.ts"]);
    const r = await analyze(request(undefined, undefined, diffOfWorktree()), { cwd: dir });
    expect(r.findings.map((f) => [f.severity, f.file, f.line, f.text])).toEqual([
      ["warning", "src/a.ts", 1, "process added: imports node:child_process."],
      ["warning", "src/new.ts", 1, "env added: reads process.env."],
    ]);
    // An explicit base is honoured.
    const r2 = await analyze(request(undefined, sh(["rev-parse", "HEAD"]), diffOfWorktree()), { cwd: dir });
    expect(r2.findings).toEqual(r.findings);
  });

  it("gates with the manifest from the base: a capability the file's paths do not allow is a blocker, an allowed one a nit, and the change's own manifest does not count", async () => {
    await write(".graft/capabilities.json", JSON.stringify({ version: 1, allow: [{ paths: ["src/net.ts"], capabilities: ["net"] }, { paths: ["src/**"], capabilities: ["env"] }] }));
    const base = commit("manifest");
    await write("src/a.ts", 'import { readFile } from "node:fs/promises";\nexport const a = () => readFile(process.env.F!);\n');
    await write(".graft/capabilities.json", JSON.stringify({ version: 1, allow: [{ paths: ["src/**"], capabilities: ["fs", "env", "net"] }] }));
    const head = commit("read a file");
    const r = await analyze(request(head, base), { cwd: dir });
    expect(r.verdict).toBe("request-changes");
    expect(r.findings).toEqual([
      { severity: "blocker", file: "src/a.ts", line: 1, text: "fs added: imports node:fs/promises. .graft/capabilities.json does not allow fs for this path." },
      { severity: "nit", file: "src/a.ts", line: 2, text: "env added: reads process.env." },
    ]);
    expect(r.summary).toBe(`1 of 1 file changed capabilities: src/a.ts +fs +env. 1 not allowed by the manifest. Gated by .graft/capabilities.json at ${base.slice(0, 10)}.`);
    // Widening the manifest first, in its own commit, lets the same change through.
    const widened = analyze(request(head, head), { cwd: dir });
    await expect(widened).resolves.toMatchObject({ verdict: "approve", findings: [] });
  });

  it("gates with no rules under a manifest it cannot read, refuses a change that breaks it, and lets the fix through", async () => {
    await write(".graft/capabilities.json", JSON.stringify({ version: 1, allow: [{ paths: ["src/**"], capabilities: ["fs"] }] }));
    const good = commit("manifest");
    // The commit that breaks the manifest is the one refused.
    await write(".graft/capabilities.json", JSON.stringify({ version: 1, allow: [], deny: [] }));
    const broken = commit("break it");
    const r0 = await analyze(request(broken, good), { cwd: dir });
    expect(r0.verdict).toBe("request-changes");
    expect(r0.findings).toEqual([{ severity: "blocker", file: ".graft/capabilities.json", text: 'The new manifest does not parse: .graft/capabilities.json: unknown key "deny".' }]);

    // Under a broken manifest nothing is allowed, so breaking it opens nothing.
    await write("src/a.ts", 'import "node:fs";\n');
    const head = commit("fs");
    const r = await analyze(request(head, broken), { cwd: dir });
    expect(r.verdict).toBe("request-changes");
    expect(r.findings.map((f) => [f.severity, f.file])).toEqual([
      ["blocker", "src/a.ts"],
      ["warning", ".graft/capabilities.json"],
    ]);
    expect(r.findings[1].text).toMatch(/unknown key "deny"\. Until it is fixed nothing is allowed/);

    // The commit that repairs it changes no source, so it passes.
    await write(".graft/capabilities.json", JSON.stringify({ version: 1, allow: [{ paths: ["src/**"], capabilities: ["fs"] }] }));
    const fixed = commit("fix it");
    await expect(analyze(request(fixed, head), { cwd: dir })).resolves.toMatchObject({ verdict: "approve" });
  });

  it("follows a rename, and reads a root commit and a merge against what it can", async () => {
    // Enough unchanged lines for git to see the rename.
    const body = Array.from({ length: 8 }, (_, i) => `export const line${i} = ${i};`).join("\n");
    await write("src/net.ts", `import https from "node:https";\n${body}\nexport const get = (u: string) => https.get(u);\n`);
    const base = commit("longer");
    sh(["mv", "src/net.ts", "src/http.ts"]);
    await write("src/http.ts", `import https from "node:https";\nimport { spawn } from "node:child_process";\n${body}\nexport const get = (u: string) => https.get(u) && spawn;\n`);
    const head = commit("rename");
    const r = await analyze(request(head, base), { cwd: dir });
    expect(r.findings).toEqual([{ severity: "warning", file: "src/http.ts", line: 2, text: "process added: imports node:child_process." }]);

    // A root commit has no base: everything it holds is new.
    const root = sh(["rev-list", "--max-parents=0", "HEAD"]);
    const r0 = await analyze(request(root), { cwd: dir });
    expect(r0.findings.map((f) => f.text)).toEqual(["net added: imports node:https."]);
    expect(r0.summary).toBe("1 of 2 files changed capabilities: src/net.ts +net.");

    // A merge comes without a base, as graft check sends its remerge diff: it is compared against git's own re-merge
    // of its parents, so what came in from the side branch (reviewed on its own commit) is not the merge's.
    sh(["checkout", "-q", "-b", "side", root]);
    await write("src/side.ts", 'import { exec } from "node:child_process";\nexport const s = exec;\n');
    commit("side");
    sh(["checkout", "-q", "main"]);
    sh(["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    const merge = sh(["rev-parse", "HEAD"]);
    const rm_ = await analyze(request(merge), { cwd: dir });
    expect(rm_.findings).toEqual([]);
    expect(rm_.summary).toContain("Compared against git's re-merge of the parents.");

    // What the merge itself adds while resolving is still reviewed.
    sh(["checkout", "-q", "-b", "side2", merge]);
    await write("src/a.ts", 'import { z } from "zod";\nexport const a = 1;\n');
    commit("side2 edit");
    sh(["checkout", "-q", "main"]);
    await write("src/a.ts", 'import { z } from "zod";\nexport const a = 2;\n');
    commit("main edit");
    expect(() => sh(["merge", "-q", "--no-ff", "-m", "merge side2", "side2"])).toThrow();
    await write("src/a.ts", 'import { z } from "zod";\nexport const a = fetch("x");\n');
    const resolved = commit("merge side2");
    const rm2 = await analyze(request(resolved), { cwd: dir });
    expect(rm2.findings.map((f) => [f.file, f.text])).toEqual([["src/a.ts", "net added: calls fetch."]]);
  });

  it("refuses a file moved to a path that may not hold what it holds", async () => {
    await write(".graft/capabilities.json", JSON.stringify({ version: 1, allow: [{ paths: ["scripts/**"], capabilities: ["process"] }] }));
    const body = Array.from({ length: 8 }, (_, i) => `export const line${i} = ${i};`).join("\n");
    await write("scripts/deploy.ts", `import { execSync } from "node:child_process";\n${body}\nexport const deploy = () => execSync("x");\n`);
    const base = commit("deploy script");
    await mkdir(join(dir, "src/billing"), { recursive: true });
    sh(["mv", "scripts/deploy.ts", "src/billing/deploy.ts"]);
    const head = commit("move it");
    const r = await analyze(request(head, base), { cwd: dir });
    expect(r.verdict).toBe("request-changes");
    expect(r.findings).toEqual([
      { severity: "blocker", file: "src/billing/deploy.ts", line: 1, text: "process moved in from scripts/deploy.ts: imports node:child_process. .graft/capabilities.json does not allow process for this path." },
    ]);
    // The same move in the working tree, not yet committed.
    sh(["reset", "-q", "--soft", base]);
    const wt = await analyze(request(), { cwd: dir });
    expect(wt.verdict).toBe("request-changes");
  });

  it("takes the working tree's files from git, so a file past the diff's cut is still reviewed", async () => {
    await write(".graft/capabilities.json", JSON.stringify({ version: 1, allow: [] }));
    commit("manifest");
    await write("src/zz.ts", 'import { execSync } from "node:child_process";\nexport const z = execSync;\n');
    const cut = "diff --git a/src/aa.ts b/src/aa.ts\n+...\n[... 900000 more characters of diff were cut; the reviewer saw only the first 400000 ...]\n";
    const r = await analyze(request(undefined, undefined, cut), { cwd: dir });
    expect(r.verdict).toBe("request-changes");
    expect(r.findings.map((f) => [f.severity, f.file])).toEqual([["blocker", "src/zz.ts"]]);
  });

  it("fails rather than review against a base or commit that is not there", async () => {
    await expect(analyze(request(sh(["rev-parse", "HEAD"]), "0".repeat(40)), { cwd: dir })).rejects.toThrow(/the base 0{40} is not in this repository/);
    await expect(analyze(request("1".repeat(40)), { cwd: dir })).rejects.toThrow(/the commit 1{40} is not in this repository/);
  });

  it("does not pass a source file too large to read under a manifest", async () => {
    await write(".graft/capabilities.json", JSON.stringify({ version: 1, allow: [] }));
    const base = commit("manifest");
    await write("src/vendor.js", `require("child_process").execSync("x");\n/*${"x".repeat(4.5 * 1024 * 1024)}*/\n`);
    const head = commit("vendor");
    const r = await analyze(request(head, base), { cwd: dir });
    expect(r.verdict).toBe("request-changes");
    expect(r.findings).toEqual([{ severity: "blocker", file: "src/vendor.js", text: "Not analyzed: src/vendor.js is larger than 4 MB, so it was not read." }]);
    // Nothing changed in the working tree since: nothing to refuse.
    expect((await analyze(request(), { cwd: dir })).findings).toEqual([]);
    sh(["reset", "-q", "--soft", base]);
    expect((await analyze(request(), { cwd: dir })).findings.map((f) => f.severity)).toEqual(["blocker"]);
  });

  it("reads ./ workspace globs, pnpm workspaces and tsconfig path aliases as project code", async () => {
    await write("package.json", JSON.stringify({ name: "mono", workspaces: ["./packages/*"], dependencies: { zod: "1" } }));
    await write("packages/core/package.json", JSON.stringify({ name: "@acme/core" }));
    await write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - \"!apps/legacy\"\n");
    await write("apps/web/package.json", JSON.stringify({ name: "@acme/web" }));
    await write("tsconfig.json", '{\n  // comments are allowed here\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } }\n}\n');
    await write("src/lib/run.ts", 'import { spawn } from "node:child_process";\nexport const run = spawn;\n');
    const base = commit("workspaces");
    expect([...(await workspacePackages(new GitTree(dir, base)))].sort()).toEqual(["@acme/core", "@acme/web", "mono"]);
    await write("package.json", JSON.stringify({ name: "mono", workspaces: ["./packages/*"], dependencies: { zod: "1", "@acme/core": "workspace:*" } }));
    await write("src/app/page.tsx", 'import { v } from "@acme/core";\nimport { w } from "@acme/web";\nimport { run } from "@/lib/run";\nexport const p = [v, w, run];\n');
    const head = commit("use them");
    const r = await analyze(request(head, base), { cwd: dir });
    expect(r.findings).toEqual([{ severity: "nit", file: "src/app/page.tsx", line: 3, text: "process inherited: imports /src/lib/run, which imports node:child_process." }]);
  });

  it("does not read an import that leaves the repository", async () => {
    const outside = `${dir.split("/").pop()}-outside.js`;
    await writeFile(join(dir, "..", outside), 'require("node:child_process");\n');
    try {
      await write("src/a.ts", `import "../../${outside}";\nexport const a = 1;\n`);
      const r = await analyze(request(), { cwd: dir });
      expect(r.findings).toEqual([]);
    } finally {
      await rm(join(dir, "..", outside), { force: true });
    }
  });

  it("names the repo's own workspace packages as project code and reads capabilities through them", async () => {
    await write("package.json", JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
    await write("packages/core/package.json", JSON.stringify({ name: "@me/core" }));
    await write("packages/core/src/index.ts", 'import { spawn } from "node:child_process";\nexport const run = spawn;\n');
    const base = commit("workspaces");
    expect([...(await workspacePackages(new GitTree(dir, base)))].sort()).toEqual(["@me/core", "mono"]);
    await write("packages/cli/src/cli.ts", 'import { run } from "@me/core";\nimport yargs from "yargs";\nimport chalk from "chalk";\nimport oddball from "oddball";\nrun("ls");\n');
    const head = commit("cli");
    const r = await analyze(request(head, base), { cwd: dir });
    expect(r.findings.map((f) => f.text)).toEqual(["dep added: imports oddball, which the table does not know."]);
  });

  it("writes a manifest from the tree as it is, grouping files by what they hold", async () => {
    await write("src/env.ts", "export const k = process.env.K;\n");
    await write("src/env2.ts", "export const j = process.env.J;\n");
    await write("src/none.ts", "export const n = 1;\n");
    await write("src/c.js", 'import "oddball";\n');
    commit("more");
    const m = await buildManifest(new WorkTree(dir));
    expect(m).toEqual({
      version: 1,
      allow: [
        { paths: ["src/c.js"], capabilities: ["dep"] },
        { paths: ["src/env.ts", "src/env2.ts"], capabilities: ["env"] },
        { paths: ["src/net.ts"], capabilities: ["net"] },
      ],
    });
    const kept = await buildManifest(new WorkTree(dir), { version: 1, allow: [], packages: { oddball: ["net"] } });
    expect(kept.allow.find((r) => r.paths.includes("src/c.js"))?.capabilities).toEqual(["net"]);
    expect(kept.packages).toEqual({ oddball: ["net"] });
  });

  it("reads one level of inheritance through index files and .js specifiers that name .ts files", async () => {
    await write("src/lib/index.ts", 'export * from "./fsy.js";\n');
    await write("src/lib/fsy.ts", 'import fs from "node:fs";\nexport const f = fs;\n');
    await write("src/use.ts", 'import { f } from "./lib";\nimport { f as g } from "./lib/fsy.js";\nexport default [f, g];\n');
    commit("tree");
    const caps = await capabilitiesOf(new WorkTree(dir), "src/use.ts");
    // ./lib resolves to index.ts, which holds nothing of its own (its re-export is one level further); ./lib/fsy.js resolves to fsy.ts.
    expect(caps?.inherited.map((h) => [h.key, h.via])).toEqual([["fs", "./lib/fsy.js"]]);
  });
});

describe("graft-capabilities as a reviewer command", () => {
  let dir: string;
  const sh = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  };
  const command = `node ${JSON.stringify(CLI)}`;
  // These tests run graft check --rerun themselves; when this suite is itself a re-run of an outer check, the marker
  // the outer check set would make the inner one run nothing.
  let inheritedMarker: string | undefined;

  beforeEach(async () => {
    inheritedMarker = process.env.GRAFT_CHECK_RERUN;
    delete process.env.GRAFT_CHECK_RERUN;
    dir = await mkdtemp(join(tmpdir(), "capabilities-cli-"));
    sh(["init", "-q", "-b", "main"]);
    sh(["config", "user.name", "Test"]);
    sh(["config", "user.email", "test@example.com"]);
    await write(".graft/policy.json", JSON.stringify({ version: 1, requireEvidence: true, reviews: { capabilities: { command } }, rules: [{ paths: ["src/**"], require: ["capabilities"] }] }));
    await write("src/a.ts", "export const a = 1;\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "base"]);
  });
  afterEach(async () => {
    if (inheritedMarker === undefined) delete process.env.GRAFT_CHECK_RERUN;
    else process.env.GRAFT_CHECK_RERUN = inheritedMarker;
    await rm(dir, { recursive: true, force: true });
  });

  it("answers a request on stdin with a review result, and refuses what is not a request", () => {
    const run = (input: string) => spawnSync("node", [CLI], { cwd: dir, input, encoding: "utf8" });
    const r = run(JSON.stringify({ name: "capabilities", task: "t", diff: "" }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ model: expect.stringMatching(/^graft-capabilities\/\d+\.\d+\.\d+$/), verdict: "approve", summary: "Nothing in the diff.", findings: [] });
    expect(run("not json").status).toBe(2);
    expect(run("{}").status).toBe(2);
    const help = spawnSync("node", [CLI, "--help"], { cwd: dir, encoding: "utf8" });
    expect(help.stdout).toContain("graft-capabilities scan");
    expect(spawnSync("node", [CLI, "bogus"], { cwd: dir, encoding: "utf8" }).status).toBe(2);
  });

  it("writes a whole large review result to a pipe before it exits", async () => {
    for (let i = 0; i < 400; i++) await write(`src/f${i}.ts`, 'import "node:fs";\nimport "node:http";\nimport "node:child_process";\nexport const k = process.env.K;\n');
    const r = await reviewViaCommand(command, { name: "capabilities", task: "t", diff: "", instructions: "" }, dir, process.env);
    expect(r.findings).toHaveLength(1600);
  });

  it("init writes a root file anchored, so the rule does not reach a file of the same name elsewhere", async () => {
    await write("index.js", 'require("node:child_process");\n');
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "root"]);
    expect(spawnSync("node", [CLI, "init"], { cwd: dir, encoding: "utf8" }).status).toBe(0);
    expect(JSON.parse(await readFile(join(dir, ".graft/capabilities.json"), "utf8")).allow).toEqual([{ paths: ["./index.js"], capabilities: ["process"] }]);
    await writeFile(join(dir, ".graft/capabilities.json"), "{}");
    const again = spawnSync("node", [CLI, "init", "--force"], { cwd: dir, encoding: "utf8" });
    expect(again.status).toBe(0);
    expect(again.stderr).toMatch(/is not kept/);
  });

  it("records the capability diff as review evidence with graft, and graft check re-runs it on each commit", async () => {
    const graft = new Graft(dir);
    const base = sh(["rev-parse", "HEAD"]);
    await graft.start({ task: "shell out" });
    await write("src/a.ts", 'import { execSync } from "node:child_process";\nexport const a = () => execSync("ls");\n');
    const ev = await graft.evidenceReview("capabilities");
    expect(ev).toMatchObject({ kind: "review", name: "capabilities", verdict: "approve", findings: [{ severity: "warning", file: "src/a.ts", line: 1, text: "process added: imports node:child_process." }] });
    expect(ev.summary).toBe("1 of 1 file changed capabilities: src/a.ts +process.");
    const { commit } = await graft.land({ all: true });
    expect(sh(["log", "-1", "--format=%B", commit])).toMatch(/\[review approve capabilities\] graft-capabilities\/\d+\.\d+\.\d+ \(prompt [0-9a-f]{8}; 1 finding\)/);

    const r = await runCheck({ repo: dir, base, rerun: true });
    expect(r.ok).toBe(true);
    expect(r.reviews).toMatchObject([{ name: "capabilities", commit, verdict: "approve", findings: [{ severity: "warning", file: "src/a.ts" }] }]);
  });

  it("init writes the manifest, after which a disallowed capability refuses to land and fails the check", async () => {
    await write("src/a.ts", "export const a = process.env.A;\n");
    sh(["commit", "-q", "-am", "env"]);
    const init = spawnSync("node", [CLI, "init"], { cwd: dir, encoding: "utf8" });
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("Wrote .graft/capabilities.json: 1 rule covering 1 file");
    expect(JSON.parse(await readFile(join(dir, ".graft/capabilities.json"), "utf8"))).toEqual({ version: 1, allow: [{ paths: ["src/a.ts"], capabilities: ["env"] }] });
    expect(spawnSync("node", [CLI, "init"], { cwd: dir, encoding: "utf8" }).status).toBe(1);
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "manifest"]);
    const base = sh(["rev-parse", "HEAD"]);

    const graft = new Graft(dir);
    await graft.start({ task: "phone home" });
    await write("src/a.ts", 'export const a = () => fetch(process.env.A!);\n');
    const ev = await graft.evidenceReview("capabilities");
    expect(ev).toMatchObject({ verdict: "request-changes", findings: [{ severity: "blocker", file: "src/a.ts", line: 1 }] });
    await expect(graft.land({ all: true })).rejects.toThrow(/Policy requires an approving review "capabilities"/);
    const { commit } = await graft.land({ all: true, allowNoEvidence: true });
    const r = await runCheck({ repo: dir, base, rerun: true });
    expect(r.ok).toBe(false);
    expect(r.findings).toMatchObject([{ kind: "review-failed", name: "capabilities", commit, reason: "request-changes", findings: [{ severity: "blocker" }] }]);

    const scan = spawnSync("node", [CLI, "scan", "src"], { cwd: dir, encoding: "utf8" });
    expect(scan.stdout.trim()).toBe("src/a.ts  net env");
  });
});
