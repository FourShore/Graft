/**
 * Which shell commands count as evidence when a harness reports every
 * command an agent ran. The filter is deliberately a list of well-known
 * test, build, lint and type-check invocations: recording everything would
 * bury the record in `ls` and `cat`, and curating by hand is where lying
 * creeps in. Policy can widen it with `captureCommands`.
 */
export type CaptureKind = "test" | "build" | "lint" | "typecheck";

/** A shell command split at its control operators, each piece with the operator that follows it. */
interface Segment {
  text: string;
  next: string;
}

// `&` alone backgrounds; `2>&1`, `&>` and `>&2` are redirections, not operators.
const OPERATOR = /(\|\||&&|\|&|\||;|\n|(?<![<>&\d])&(?![>&]))/;

export function splitCommand(command: string): Segment[] {
  const parts = command.split(OPERATOR);
  const out: Segment[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i].trim().replace(/^[({]\s*/, "").replace(/\s*[)}]$/, "").trim();
    const next = parts[i + 1] ?? "";
    if (text) out.push({ text, next });
    else if (out.length && next) out[out.length - 1].next = next;
  }
  return out;
}

function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
}

/** Programs that run the next word as the command: `env`, `timeout 600`, `npx`, `uv run`, `python -m`. */
function stripWrappers(w: string[]): string[] {
  for (;;) {
    const before = w.length;
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    const head = basename(w[0] ?? "");
    if (head === "env" || head === "nice" || head === "nohup" || head === "time" || head === "sudo" || head === "command" || head === "exec" || head === "xvfb-run") {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(/^-(n|u|s|k)$/.test(w[0]) ? 2 : 1);
    } else if (head === "timeout") {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(/^-(s|k)$/.test(w[0]) ? 2 : 1);
      w = w.slice(1);
    } else if (head === "npx" || head === "bunx") {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(/^(-p|--package)$/.test(w[0]) ? 2 : 1);
    } else if (/^(pnpm|yarn)$/.test(head) && /^(exec|dlx)$/.test(w[1] ?? "")) {
      w = w.slice(2);
    } else if (/^(uv|poetry|pipenv|hatch|pdm|rye|bundle)$/.test(head) && /^(run|exec)$/.test(w[1] ?? "")) {
      w = w.slice(2);
      while (w.length && w[0].startsWith("-")) w = w.slice(1);
    } else if (/^python[\d.]*$/.test(head) && w[1] === "-m") {
      w = w.slice(2);
    }
    if (w.length === before) return w;
  }
}

function basename(word: string): string {
  return word.replace(/^.*[\\/]/, "");
}

/** A package script, workspace task or make target name, read as a kind. */
function scriptKind(name: string): CaptureKind | null {
  // A script that rewrites files (`lint:fix`, `format`) is not a check.
  if (/(^|:)(fix|write|format|fmt)$/.test(name) || /^(format|fmt)$/.test(name)) return null;
  if (/^(test|tests|spec|specs|check|unit|e2e|integration)(:[\w:.-]+)?$/.test(name)) return "test";
  if (/^(typecheck|type-check|types|tsc|check-types|check:types)(:[\w:.-]+)?$/.test(name)) return "typecheck";
  if (/^(lint|eslint|format:check|fmt:check|check:format|stylelint)(:[\w:.-]+)?$/.test(name)) return "lint";
  if (/^(build|compile|bundle|all)(:[\w:.-]+)?$/.test(name)) return "build";
  return null;
}

const SINGLE: Record<string, CaptureKind> = {
  vitest: "test", jest: "test", mocha: "test", ava: "test", pytest: "test", "py.test": "test", nose2: "test", unittest: "test",
  rspec: "test", minitest: "test", phpunit: "test", pest: "test", ctest: "test", tox: "test", nox: "test", karma: "test",
  tap: "test", uvu: "test", bats: "test", jasmine: "test",
  tsc: "typecheck", "vue-tsc": "typecheck", "svelte-check": "typecheck", mypy: "typecheck", pyright: "typecheck", basedpyright: "typecheck",
  eslint: "lint", flake8: "lint", pylint: "lint", "golangci-lint": "lint", rubocop: "lint", shellcheck: "lint", stylelint: "lint",
  oxlint: "lint", hadolint: "lint", markdownlint: "lint", "markdownlint-cli2": "lint", ktlint: "lint", swiftlint: "lint", standard: "lint",
  webpack: "build", esbuild: "build", rollup: "build", tsup: "build", ninja: "build",
};

function classifySegment(segment: string): CaptureKind | null {
  const w = stripWrappers(words(segment));
  if (!w.length) return null;
  const tool = basename(w[0]).replace(/\.(exe|cmd|bat)$/i, "");
  const args = w.slice(1);
  // Asking a tool about itself, or letting it rewrite files, is not a check of the change.
  if (args.some((a) => /^(--version|-V|--help|-h|--fix|--fix-dry-run|--write|--apply|--watch)$/.test(a))) return null;
  const sub = args[0];
  if (tool in SINGLE) {
    if (tool === "tsc" && args.includes("--init")) return null;
    return SINGLE[tool];
  }
  switch (tool) {
    case "graft":
    case "git":
      return null;
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
    case "composer": {
      // Drop workspace and directory flags with their values; what is left starts with the subcommand or script.
      const valued = /^(-w|--workspace|--filter|-F|-C|--dir|--prefix|--cwd)$/;
      const rest = args.filter((a, i) => !valued.test(a) && !valued.test(args[i - 1] ?? "") && !a.startsWith("-"));
      let arg = rest[0];
      let after = rest.slice(1);
      if (tool === "yarn" && arg === "workspace") {
        arg = after[1];
        after = after.slice(2);
      } else if (tool === "yarn" && arg === "workspaces" && after[0] === "foreach") {
        arg = after[1];
        after = after.slice(2);
      }
      if (arg === "run" || arg === "run-script") arg = after[0];
      if (tool === "bun" && arg === "test") return "test";
      if (!arg || /^(install|i|ci|add|remove|uninstall|update|upgrade|init|create|publish|pack|link|exec|dlx|outdated|audit|why|ls|list|view|info)$/.test(arg)) return null;
      return scriptKind(arg);
    }
    case "turbo":
    case "nx":
    case "lerna":
    case "moon": {
      let rest = args;
      if (rest[0] === "run" || rest[0] === "run-many" || rest[0] === "affected") rest = rest.slice(1);
      const t = rest.findIndex((a) => a === "-t" || a === "--target" || a === "--targets");
      const task = t >= 0 ? rest[t + 1] : rest.find((a) => !a.startsWith("-"));
      return task ? scriptKind(task.split(",")[0].replace(/^.*:/, "")) : null;
    }
    case "make":
    case "gmake":
    case "just":
    case "task":
    case "rake":
    case "invoke": {
      const targets = args.filter((a, i) => !a.startsWith("-") && !a.includes("=") && !/^-(C|f|j)$/.test(args[i - 1] ?? ""));
      if (!targets.length) return tool === "make" || tool === "gmake" ? "build" : null;
      return targetsKind(targets);
    }
    case "mvn":
    case "mvnw":
    case "gradle":
    case "gradlew": {
      const goals = args.filter((a, i) => !a.startsWith("-") && !/^-(pl|f|P|D|p)$/.test(args[i - 1] ?? "")).map((g) => g.replace(/^.*:/, ""));
      return targetsKind(goals);
    }
    case "cargo":
      return ({ test: "test", t: "test", nextest: "test", clippy: "lint", build: "build", b: "build", check: "typecheck", c: "typecheck" } as Record<string, CaptureKind>)[sub ?? ""] ??
        (sub === "fmt" && args.includes("--check") ? "lint" : null);
    case "go":
      return ({ test: "test", vet: "lint", build: "build" } as Record<string, CaptureKind>)[sub ?? ""] ?? null;
    case "dotnet":
    case "swift":
    case "bazel":
    case "bazelisk":
    case "zig":
      return sub === "test" ? "test" : sub === "build" ? "build" : null;
    case "mix":
      return sub === "test" ? "test" : sub === "compile" ? "build" : sub === "format" && args.includes("--check-formatted") ? "lint" : null;
    case "deno":
      return sub === "test" ? "test" : sub === "check" ? "typecheck" : sub === "lint" ? "lint" : null;
    case "node":
      return args.includes("--test") ? "test" : null;
    case "rails":
    case "artisan":
      return sub === "test" || sub === "spec" ? "test" : null;
    case "php":
      return basename(sub ?? "") === "artisan" && args[1] === "test" ? "test" : null;
    case "playwright":
      return sub === "test" ? "test" : null;
    case "cypress":
      return sub === "run" ? "test" : null;
    case "flow":
      return sub === undefined || sub === "check" ? "typecheck" : null;
    case "biome":
      return sub === "check" || sub === "lint" || sub === "ci" ? "lint" : null;
    case "prettier":
      return args.includes("--check") || args.includes("-c") ? "lint" : null;
    case "black":
    case "isort":
      return args.includes("--check") || args.includes("--check-only") ? "lint" : null;
    case "ruff":
      return sub === "format" ? (args.includes("--check") ? "lint" : null) : "lint";
    case "vite":
    case "next":
    case "nuxt":
    case "astro":
    case "parcel":
    case "remix":
      return sub === "build" ? "build" : null;
    case "docker":
    case "podman":
      return sub === "build" || (sub === "buildx" && args[1] === "build") ? "build" : null;
    case "cmake":
      return args.includes("--build") ? "build" : null;
    default:
      return null;
  }
}

function targetsKind(targets: string[]): CaptureKind | null {
  const kinds = targets.map((t) => (/^(verify|integrationTest|connectedCheck)$/.test(t) ? "test" : /^(package|install|assemble|jar)$/.test(t) ? "build" : scriptKind(t)));
  return pick(kinds);
}

const PRIORITY: CaptureKind[] = ["test", "typecheck", "lint", "build"];

function pick(kinds: (CaptureKind | null)[]): CaptureKind | null {
  for (const k of PRIORITY) if (kinds.includes(k)) return k;
  return null;
}

/** What `analyzeCommand` makes of a command. */
export interface CommandAnalysis {
  kind: CaptureKind | "custom" | null;
  /**
   * Set when the shell's exit code is not the check's: the check is piped
   * into another program (`npm test | tail`), its failure is swallowed
   * (`|| true`), or another command runs after it (`; echo done`). The
   * harness reports the last program's exit, so recording it would record
   * a failing check as a pass.
   */
  masked: boolean;
}

/**
 * Classify a command and say whether its exit code stands for the check.
 * Each piece between `&&`, `||`, `|` and `;` is judged on its own, from its
 * first word after wrappers such as `env`, `npx` or `uv run`, so an `echo
 * "npm test"` or a `git commit -m "fix tests"` is not a test run.
 */
export function analyzeCommand(command: string, extra: string[] = []): CommandAnalysis {
  const c = command.trim();
  if (!c) return { kind: null, masked: false };
  const segments = splitCommand(c);
  const kinds = segments.map((s) => classifySegment(s.text));
  let kind: CaptureKind | "custom" | null = pick(kinds);
  if (!kind && matchesExtra(c, segments, extra)) kind = "custom";
  if (!kind) return { kind: null, masked: false };
  const pipefail = /\bset\s+(-\w*\s+)*-\w*o\s+pipefail\b/.test(c);
  const errexit = /\bset\s+-\w*e/.test(c);
  const checked = kind === "custom" ? segments.map((s) => matchesExtra(s.text, [], extra)) : kinds.map((k) => k !== null);
  const masked = segments.some((s, i) => {
    if (!checked[i]) return false;
    if (s.next === "&") return true;
    if (i === segments.length - 1) return false;
    const rest = segments[i + 1]?.text ?? "";
    if (s.next === "|" || s.next === "|&") return !pipefail;
    if (s.next === "||") return !/^(exit\b|false$|return\b)/.test(rest);
    return (s.next === ";" || s.next === "\n") && !errexit;
  });
  return { kind, masked };
}

function matchesExtra(command: string, segments: Segment[], extra: string[]): boolean {
  for (const p of extra) {
    try {
      const re = new RegExp(p);
      if (re.test(command) || segments.some((s) => re.test(s.text))) return true;
    } catch {
      // A bad pattern in policy should not break capture; it just never matches.
    }
  }
  return false;
}

/**
 * Rewrite absolute paths under the repository root as relative ones, so a
 * captured `cd /home/me/repo/pkg && go test ./...` re-runs on another
 * machine, where `graft check --rerun` executes it from the repository root.
 * A leading `cd` to the root itself is dropped. Both slash styles match.
 */
export function relativizeCommand(command: string, topLevel: string): string {
  const top = topLevel.replace(/[\\/]+$/, "");
  if (!top) return command;
  const root = top
    .split(/[\\/]/)
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]");
  const flags = /^[A-Za-z]:/.test(top) ? "gi" : "g";
  // Only a path that starts here (after a space, quote, `=` or an operator) is the root; `/mnt/x/home/me/repo` is not.
  const at = `(?<=^|[\\s"'=;&|(])${root}`;
  return command
    .replace(new RegExp(`${at}[\\\\/](?=[^\\s"';&|)])`, flags), "./")
    .replace(new RegExp(`${at}[\\\\/]?(?=["'\\s;&|)]|$)`, flags), ".")
    .replace(/(^|(?:&&|\|\||;)\s*)cd\s+["']?\.\/?["']?\s*(?:&&|;)\s*/g, "$1");
}

/**
 * Classify a command, or null when it is not one Graft records on its own.
 * `extra` holds policy patterns (regular expressions as strings) that also
 * count; a match there is labelled "custom".
 */
export function classifyCommand(command: string, extra: string[] = []): CaptureKind | "custom" | null {
  return analyzeCommand(command, extra).kind;
}
