import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CoverageRule, Policy } from "./policy.js";

/** What `detectPolicy` found: the policy to write, and the build files it read it from. */
export interface DetectedPolicy {
  policy: Policy;
  from: string[];
}

interface Ecosystem {
  file: string;
  /** Prefix for a command whose name another ecosystem took first: go-test beside test. */
  tool: string;
  commands: Record<string, string>;
  /** Source files whose changes need the test run. */
  sources: string[];
}

/**
 * A starting policy for a repository that has none: the test, lint, type-check
 * and build commands its build files already define, and a rule that a change
 * to source files needs a passing test run. Without it a fresh install accepts
 * any evidence at all, a note included, which is not the point. Only what the
 * repository itself declares is used, so every command is one its developers
 * already run; the file is meant to be edited.
 */
export async function detectPolicy(topLevel: string): Promise<DetectedPolicy> {
  const found = (await Promise.all([node(topLevel), go(topLevel), rust(topLevel), python(topLevel), jvm(topLevel), ruby(topLevel)])).filter(
    (e): e is Ecosystem => e !== null,
  );
  const commands: Record<string, string> = {};
  const rules: CoverageRule[] = [];
  for (const eco of found) {
    let test: string | undefined;
    for (const [name, command] of Object.entries(eco.commands)) {
      const key = commands[name] === undefined ? name : `${eco.tool}-${name}`;
      commands[key] = command;
      if (name === "test") test = key;
    }
    if (test) rules.push({ paths: eco.sources, require: [test] });
  }
  const policy: Policy = { version: 1, requireEvidence: true };
  if (Object.keys(commands).length) policy.commands = commands;
  if (rules.length) policy.rules = rules;
  return { policy, from: found.map((e) => e.file) };
}

async function node(top: string): Promise<Ecosystem | null> {
  const pkg = await readJson(join(top, "package.json"));
  if (!pkg) return null;
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const pm = (await exists(join(top, "pnpm-lock.yaml")))
    ? "pnpm"
    : (await exists(join(top, "yarn.lock")))
      ? "yarn"
      : (await exists(join(top, "bun.lockb"))) || (await exists(join(top, "bun.lock")))
        ? "bun"
        : "npm";
  const run = (script: string) => (script === "test" && pm !== "bun" ? `${pm} test` : `${pm} run ${script}`);
  const commands: Record<string, string> = {};
  // npm init writes a test script that only fails; it is not a test suite.
  if (scripts.test && !/no test specified/.test(scripts.test)) commands.test = run("test");
  for (const [name, candidates] of [
    ["typecheck", ["typecheck", "type-check", "check-types", "types"]],
    ["lint", ["lint"]],
    ["build", ["build"]],
  ] as const) {
    const script = candidates.find((c) => scripts[c]);
    if (script) commands[name] = run(script);
  }
  return { file: "package.json", tool: "node", commands, sources: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.vue", "*.svelte"] };
}

async function go(top: string): Promise<Ecosystem | null> {
  if (!(await exists(join(top, "go.mod")))) return null;
  return { file: "go.mod", tool: "go", commands: { test: "go test ./...", lint: "go vet ./...", build: "go build ./..." }, sources: ["*.go"] };
}

async function rust(top: string): Promise<Ecosystem | null> {
  if (!(await exists(join(top, "Cargo.toml")))) return null;
  return { file: "Cargo.toml", tool: "cargo", commands: { test: "cargo test", lint: "cargo clippy", build: "cargo build" }, sources: ["*.rs"] };
}

async function python(top: string): Promise<Ecosystem | null> {
  const pyproject = await readText(join(top, "pyproject.toml"));
  const marker = pyproject !== null ? "pyproject.toml" : (await exists(join(top, "setup.py"))) ? "setup.py" : null;
  if (!marker) return null;
  const text = pyproject ?? "";
  const commands: Record<string, string> = {};
  if (/pytest/.test(text) || (await exists(join(top, "pytest.ini"))) || (await exists(join(top, "tests")))) commands.test = "python -m pytest";
  if (/\bruff\b/.test(text)) commands.lint = "ruff check .";
  if (/\bmypy\b/.test(text)) commands.typecheck = "mypy .";
  return { file: marker, tool: "python", commands, sources: ["*.py"] };
}

async function jvm(top: string): Promise<Ecosystem | null> {
  if (await exists(join(top, "pom.xml"))) {
    const mvn = (await exists(join(top, "mvnw"))) ? "./mvnw" : "mvn";
    return { file: "pom.xml", tool: "maven", commands: { test: `${mvn} -q test`, build: `${mvn} -q package -DskipTests` }, sources: ["*.java", "*.kt", "*.scala"] };
  }
  const gradle = (await exists(join(top, "build.gradle.kts"))) ? "build.gradle.kts" : (await exists(join(top, "build.gradle"))) ? "build.gradle" : null;
  if (!gradle) return null;
  const cmd = (await exists(join(top, "gradlew"))) ? "./gradlew" : "gradle";
  return { file: gradle, tool: "gradle", commands: { test: `${cmd} test`, build: `${cmd} assemble` }, sources: ["*.java", "*.kt", "*.kts", "*.scala", "*.groovy"] };
}

async function ruby(top: string): Promise<Ecosystem | null> {
  if (!(await exists(join(top, "Gemfile")))) return null;
  const test = (await exists(join(top, "spec"))) ? "bundle exec rspec" : (await exists(join(top, "Rakefile"))) ? "bundle exec rake test" : null;
  return { file: "Gemfile", tool: "ruby", commands: test ? { test } : {}, sources: ["*.rb"] };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch(() => null);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readText(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
