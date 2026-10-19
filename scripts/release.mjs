#!/usr/bin/env node
// Bump every package to the same new version, point the workspace packages at
// each other by that version, commit, and tag. Pushing the tag triggers the
// Release workflow, which publishes all three packages to npm.
//
// The commit is landed with Graft itself (build and tests as evidence), so
// the release is a recorded change like every other commit in this repo.
//
//   npm run release -- patch     (or minor, major, or an exact version)
//   git push --follow-tags && git push -f origin v0
//
// Besides the exact tag (v0.1.1) the script moves the major tag (v0) to the
// same commit, so `uses: FourShore/Graft@v0` in other repos' workflows follows
// each release. A moved tag needs a forced push; --follow-tags does not move it.
// It also sets the default of action.yml's `version` input to the new version,
// so a workflow that pins the action to a release tag or its SHA installs that
// exact Graft rather than whatever npm calls latest.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const bump = process.argv[2];
if (!bump) {
  console.error("usage: npm run release -- <patch|minor|major|x.y.z>");
  process.exit(1);
}
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).trim();

if (run("git", ["status", "--porcelain"])) {
  console.error("working tree is not clean; commit or stash first");
  process.exit(1);
}

// A fresh clone has neither dependencies nor dist, and Graft itself is
// imported from dist. Install when tsc is missing; clean before building so a
// stale tsconfig.tsbuildinfo cannot make tsc skip a package whose dist is gone.
if (!existsSync("node_modules/.bin/tsc")) {
  console.log("installing dependencies...");
  execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { stdio: "inherit" });
}
console.log("building...");
execFileSync("npm", ["run", "clean"], { stdio: "inherit" });
execFileSync("npm", ["run", "build"], { stdio: "inherit" });
const { Graft } = await import("../packages/core/dist/index.js");

// npm version in a workspace tries to resolve sibling packages from the
// registry, which fails before the first publish, so bump the files directly.
const root = JSON.parse(readFileSync("package.json", "utf8"));
const version = next(root.version, bump);
const workspaces = ["packages/core", "packages/review", "packages/cli"];
const names = new Set(workspaces.map((w) => JSON.parse(readFileSync(`${w}/package.json`, "utf8")).name));
for (const file of ["package.json", ...workspaces.map((w) => `${w}/package.json`)]) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (names.has(dep)) pkg[field][dep] = version;
    }
  }
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}
run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
const action = readFileSync("action.yml", "utf8");
const pinned = action.replace(/(\n  version:\n    description: [^\n]*\n    default: )[^\n]*/, `$1"${version}"`);
if (pinned === action) {
  console.error("could not find the version input's default in action.yml");
  process.exit(1);
}
writeFileSync("action.yml", pinned);

const graft = new Graft(process.cwd());
if (await graft.status()) {
  console.error("a Graft change is already open; land or abandon it before releasing");
  process.exit(1);
}
await graft.start({
  task: `Release v${version}: bump every package to ${version}`,
  plan: "scripts/release.mjs rewrites the version fields and the lockfile; the Release workflow publishes on the tag",
  author: { kind: "human", name: process.env.GRAFT_AUTHOR ?? process.env.USER ?? "release" },
});
console.log("running build and tests as evidence...");
const check = await graft.evidenceCommand("npm run build && npm test", "build and tests");
if (check.exitCode !== 0) {
  // A release that failed its checks is not an attempt worth folding into the next land.
  await graft.abandon({ discard: true });
  console.error(check.output);
  console.error("build or tests failed; nothing committed (the version files are still modified)");
  process.exit(1);
}
await graft.land({
  title: `v${version}`,
  paths: ["package.json", "package-lock.json", "action.yml", ...workspaces.map((w) => `${w}/package.json`)],
});
run("git", ["tag", "-a", `v${version}`, "-m", `v${version}`]);
const major = `v${version.split(".")[0]}`;
run("git", ["tag", "-f", major, `v${version}`]);
console.log(`v${version} committed and tagged; ${major} now points at it.`);
console.log(`Now: git push --follow-tags && git push -f origin ${major}`);

function next(current, how) {
  const [major, minor, patch] = current.split(".").map(Number);
  if (/^\d+\.\d+\.\d+$/.test(how)) {
    const [a, b, c] = how.split(".").map(Number);
    if (a > major || (a === major && (b > minor || (b === minor && c > patch)))) return how;
    console.error(`${how} is not newer than the current version ${current}`);
    process.exit(1);
  }
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  console.error(`unknown bump '${how}'`);
  process.exit(1);
}
