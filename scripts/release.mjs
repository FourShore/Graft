#!/usr/bin/env node
// Bump every package to the same new version, point the workspace packages at
// each other by that version, commit, and tag. Pushing the tag triggers the
// Release workflow, which publishes all three packages to npm.
//
//   npm run release -- patch     (or minor, major, or an exact version)
//   git push --follow-tags
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

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

run("git", ["add", "package.json", "package-lock.json", ...workspaces.map((w) => `${w}/package.json`)]);
run("git", ["commit", "-q", "-m", `v${version}`]);
run("git", ["tag", "-a", `v${version}`, "-m", `v${version}`]);
console.log(`v${version} committed and tagged. Now: git push --follow-tags`);

function next(current, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = current.split(".").map(Number);
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  console.error(`unknown bump '${how}'`);
  process.exit(1);
}
