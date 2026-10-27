#!/usr/bin/env node
// graft-capabilities: a Graft reviewer command. With no arguments it reads the
// review request on stdin and prints the capability diff as a review result;
// `init` writes .graft/capabilities.json from the tree as it is, and `scan`
// prints what each file holds.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { analyze, buildManifest, capabilitiesOf, workspacePackages, type ReviewRequest } from "./analyze.js";
import { MANIFEST_PATH, parseManifest } from "./manifest.js";
import { isSourcePath } from "./scan.js";
import { GitTree, WorkTree, git } from "./tree.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `graft-capabilities ${version}: what each changed file can now do that it could not before.

  graft-capabilities                 read a Graft review request on stdin, print the review result (what the policy's "command" runs)
  graft-capabilities scan [paths]    print the capabilities each file holds (every tracked source file by default)
  graft-capabilities init            write ${MANIFEST_PATH} from the tree as it is, so the gate only catches what changes
  graft-capabilities --version

Capabilities: fs, net, process, env, eval, native, and dep for a package the table does not know.
Put it in .graft/policy.json as a review and require it like any other:

  { "reviews": { "capabilities": { "command": "npx graft-capabilities" } },
    "rules": [{ "paths": ["src/**"], "require": ["capabilities"] }] }
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-V") {
    console.log(version);
    return 0;
  }
  const cwd = await git(process.cwd(), ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new Error("not in a git repository");
  });
  if (cmd === "init") return init(cwd, rest.includes("--force"));
  if (cmd === "scan") return scan(cwd, rest);
  if (cmd !== undefined) {
    process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
    return 2;
  }
  return review(cwd);
}

async function review(cwd: string): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let request: ReviewRequest;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReviewRequest;
  } catch {
    process.stderr.write("Expected a Graft review request as JSON on stdin (name, task, diff, commit?, base?).\n");
    return 2;
  }
  if (!request || typeof request !== "object" || typeof request.diff !== "string") {
    process.stderr.write("The request on stdin has no diff.\n");
    return 2;
  }
  const r = await analyze(request, { cwd, version });
  console.log(JSON.stringify({ model: r.model, verdict: r.verdict, summary: r.summary, findings: r.findings }));
  return 0;
}

async function init(cwd: string, force: boolean): Promise<number> {
  const file = join(cwd, MANIFEST_PATH);
  let existing = null;
  const text = await readFile(file, "utf8").catch(() => null);
  if (text !== null) {
    if (!force) {
      process.stderr.write(`${MANIFEST_PATH} exists; pass --force to rewrite it from the tree (the "packages" table is kept).\n`);
      return 1;
    }
    existing = parseManifest(text);
  }
  const manifest = await buildManifest(new WorkTree(cwd), existing);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
  const files = manifest.allow.reduce((n, r) => n + r.paths.length, 0);
  console.log(`Wrote ${MANIFEST_PATH}: ${manifest.allow.length} rule${manifest.allow.length === 1 ? "" : "s"} covering ${files} file${files === 1 ? "" : "s"} that hold a capability today. Commit it; from then on a file that gains a capability its rules do not allow is a blocker.`);
  return 0;
}

async function scan(cwd: string, args: string[]): Promise<number> {
  let rev: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rev") rev = args[++i];
    else paths.push(args[i]);
  }
  const tree = rev ? new GitTree(cwd, rev) : new WorkTree(cwd);
  const manifestText = await tree.read(MANIFEST_PATH);
  const manifest = manifestText === null ? null : parseManifest(manifestText);
  const all = (await tree.list()).filter(isSourcePath);
  const wanted = paths.length ? all.filter((f) => paths.some((p) => f === p || f.startsWith(p.replace(/\/?$/, "/")))) : all;
  if (!wanted.length) {
    process.stderr.write(paths.length ? `No tracked source files under ${paths.join(", ")}.\n` : "No tracked source files.\n");
    return 1;
  }
  const width = Math.min(60, Math.max(...wanted.map((f) => f.length)));
  const internal = await workspacePackages(tree);
  for (const path of wanted.sort()) {
    const caps = await capabilitiesOf(tree, path, { packages: manifest?.packages, internal });
    if (!caps) continue;
    const direct = [...new Set(caps.direct.map((h) => (h.cap === "dep" ? `dep(${h.grant.pkg})` : h.cap)))];
    const inherited = [...new Set(caps.inherited.map((h) => `${h.cap} via ${h.via}`))];
    const line = [...direct, ...inherited.map((s) => `(${s})`)].join(" ") || "-";
    console.log(`${path.padEnd(width)}  ${line}`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`graft-capabilities: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
