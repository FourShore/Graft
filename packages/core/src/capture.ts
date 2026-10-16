/**
 * Which shell commands count as evidence when a harness reports every
 * command an agent ran. The filter is deliberately a list of well-known
 * test, build, lint and type-check invocations: recording everything would
 * bury the record in `ls` and `cat`, and curating by hand is where lying
 * creeps in. Policy can widen it with `captureCommands`.
 */
export type CaptureKind = "test" | "build" | "lint" | "typecheck";

const PATTERNS: [CaptureKind, RegExp][] = [
  [
    "test",
    /\b(vitest|jest|mocha|ava|pytest|unittest|nose2?|rspec|minitest|phpunit|cargo (test|nextest)|go test|dotnet test|gradlew? test|mvn (test|verify)|npm (run )?test(:\w+)?|pnpm (run )?test(:\w+)?|yarn (run )?test(:\w+)?|bun test|make (test|check)|ctest|tox|nox|swift test|mix test|deno test|playwright test|cypress run)\b/,
  ],
  [
    "typecheck",
    /\b(tsc|mypy|pyright|flow check|npm run (typecheck|type-check|types)|pnpm (run )?(typecheck|type-check)|yarn (run )?(typecheck|type-check))\b/,
  ],
  [
    "lint",
    /\b(eslint|biome (check|lint)|prettier --check|ruff( check)?|flake8|pylint|black --check|clippy|cargo clippy|golangci-lint|go vet|rubocop|shellcheck|npm run (lint|format:check)|pnpm (run )?lint|yarn (run )?lint|stylelint|oxlint)\b/,
  ],
  [
    "build",
    /\b(npm run build|pnpm (run )?build|yarn (run )?build|bun run build|cargo build|go build|dotnet build|gradlew? (build|assemble)|mvn (package|compile|install)|make( all)?$|make build|docker build|next build|vite build|webpack|esbuild|swift build|mix compile|zig build|cmake --build|ninja)\b/,
  ],
];

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
  const c = command.trim();
  if (!c) return null;
  for (const [kind, re] of PATTERNS) if (re.test(c)) return kind;
  for (const p of extra) {
    try {
      if (new RegExp(p).test(c)) return "custom";
    } catch {
      // A bad pattern in policy should not break capture; it just never matches.
    }
  }
  return null;
}
