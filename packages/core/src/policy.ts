import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { globToRegExp } from "./redact.js";
import type { CommandEvidence, Evidence } from "./record.js";

/** Which named commands a change that touches these paths must carry as passing evidence. */
export interface CoverageRule {
  /** Globs relative to the repo root, same rules as secretFiles. */
  paths: string[];
  /** Names from `commands`. */
  require: string[];
}

/**
 * Repo policy, read from .graft/policy.json at the working tree root.
 * Version 1 has one rule. More arrive with the review view and the server.
 */
export interface Policy {
  version: 1;
  /**
   * Refuse to land a change that has no evidence. Default true. "command"
   * is stricter: at least one recorded command must have exited 0, so a note
   * alone ("checked it") does not satisfy the gate.
   */
  requireEvidence: boolean | "command";
  /**
   * Extra files that must not be landed without --allow-secrets, as globs
   * relative to the repo root ("nova.json", "config/*.secret", "keys/**").
   * Added to the built-in list (.env, *.pem, ...).
   */
  secretFiles?: string[];
  /**
   * Files the review view must treat as behavior even though its heuristics
   * would file them as mechanical or tests: globs relative to the repo root,
   * for example a schema written in Markdown ("docs/platinum-schema.md",
   * "specs/**"). Same glob rules as secretFiles.
   */
  behaviorFiles?: string[];
  /**
   * Trailers added to every landed commit, each "Key: value", so the ones you
   * pass on every land (a session link, a Co-Authored-By) cannot be forgotten.
   * `$NAME` and `${NAME}` expand from the environment; a trailer that names a
   * variable which is not set is left out of that commit rather than written
   * with a hole in it.
   */
  trailers?: string[];
  /**
   * Extra regular expressions (as strings) for commands the capture hooks
   * record as evidence, on top of the built-in test, build, lint and
   * type-check patterns: for example "^\\./scripts/verify".
   */
  captureCommands?: string[];
  /**
   * Recorded commands `graft check --rerun` may run besides the catalog's:
   * regular expressions (as strings), each matched against the whole command
   * (`^(?:pattern)$`). A run recorded under a catalog name, or whose text is
   * a catalog command, is always re-run (by the base policy's definition);
   * any other recorded command is re-run only when it fully matches one of
   * these, so unset means only catalog commands are re-run.
   */
  checkCommands?: string[];
  /**
   * Where a change's task comes from when `graft start` is given no `--ref`:
   * a URL template with the same `$NAME` / `${NAME#prefix}` expansion as
   * `trailers`, usually built from the harness's session variable, so every
   * change carries a `Graft-Task-Ref` without anyone passing one. Left out
   * of a change when a variable it names is unset.
   */
  ref?: string;
  /**
   * The repo's checks, named once: `{ "test": "go test ./...", "vet386":
   * "env GOOS=windows GOARCH=386 go vet ./..." }`. `graft evidence <name>`
   * runs one; the capture hooks record a typed command that matches one
   * under its name; `graft check --rerun` runs the current definition of a
   * name, so a command can change without invalidating history. Names are
   * what `rules` refer to.
   */
  commands?: Record<string, string>;
  /**
   * The repo's definition of done, by path: a change that touches a file
   * matching a rule's `paths` must carry a passing run (by Graft or a
   * harness, not attested) of every command the rule names. `land` refuses
   * otherwise, and `graft check` fails the commit.
   */
  rules?: CoverageRule[];
}

export const DEFAULT_POLICY: Policy = { version: 1, requireEvidence: true };

export const POLICY_PATH = ".graft/policy.json";

export async function readPolicy(topLevel: string): Promise<Policy> {
  let raw: string;
  try {
    raw = await readFile(join(topLevel, POLICY_PATH), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY;
    throw err;
  }
  return parsePolicy(raw);
}

/** A policy file's text, parsed and validated the way `readPolicy` does, for a policy read from a commit rather than the working tree. */
export function parsePolicy(raw: string): Policy {
  const parsed = JSON.parse(raw) as Partial<Policy>;
  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new Error(`Unsupported policy version ${String(parsed.version)} in ${POLICY_PATH}`);
  }
  const policy: Policy = { ...DEFAULT_POLICY, ...parsed, version: 1 };
  validatePolicy(policy);
  return policy;
}

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

function validatePolicy(policy: Policy): void {
  for (const [name, command] of Object.entries(policy.commands ?? {})) {
    if (!COMMAND_NAME.test(name)) throw new Error(`${POLICY_PATH}: command name "${name}" must be a word (letters, digits, _ . : -).`);
    if (typeof command !== "string" || !command.trim()) throw new Error(`${POLICY_PATH}: command "${name}" must be a non-empty string.`);
  }
  for (const rule of policy.rules ?? []) {
    if (!Array.isArray(rule.paths) || !rule.paths.length) throw new Error(`${POLICY_PATH}: every rule needs a non-empty "paths" list.`);
    if (!Array.isArray(rule.require) || !rule.require.length) throw new Error(`${POLICY_PATH}: every rule needs a non-empty "require" list.`);
    for (const name of rule.require) {
      if (!policy.commands?.[name]) {
        throw new Error(`${POLICY_PATH}: rule for ${rule.paths.join(", ")} requires "${name}", which "commands" does not define.`);
      }
    }
  }
}

/** Whitespace-insensitive form of a command, for matching what was typed against the catalog. */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

/** The catalog name whose command is what was typed, or null. */
export function matchCatalog(policy: Policy, command: string): string | null {
  const typed = normalizeCommand(command);
  for (const [name, c] of Object.entries(policy.commands ?? {})) if (normalizeCommand(c) === typed) return name;
  return null;
}

/** A named command that is not met by the evidence, with the files that asked for it. */
export interface UnmetRule {
  name: string;
  command: string;
  files: string[];
}

/**
 * Which named commands the rules demand for these files that the evidence
 * does not cover. A run covers a name when it was run by Graft or a harness
 * (not attested), carries the name or the catalog's command for it, passed,
 * and no later run of the same name failed. `labelIsName` also accepts a run
 * whose label is the name: a record rebuilt from a commit message keeps the
 * name only as the label. A live record has the real name, so there a free
 * `--label test` on some other command does not count.
 */
export function evaluateRules(policy: Policy, files: string[], evidence: Evidence[], opts: { labelIsName?: boolean } = {}): UnmetRule[] {
  const commands = policy.commands ?? {};
  const unmet = new Map<string, Set<string>>();
  for (const { rule, files: hit } of rulesHit(policy, files)) {
    for (const name of rule.require) {
      if (commands[name] && coveringRuns(evidence, name, commands[name], opts).length) continue;
      const set = unmet.get(name) ?? new Set<string>();
      for (const f of hit) set.add(f);
      unmet.set(name, set);
    }
  }
  return [...unmet].map(([name, set]) => ({ name, command: commands[name] ?? "", files: [...set] }));
}

/** The rules whose paths match any of `files`, each with the files that matched. */
export function rulesHit(policy: Policy, files: string[]): { rule: CoverageRule; files: string[] }[] {
  const out: { rule: CoverageRule; files: string[] }[] = [];
  for (const rule of policy.rules ?? []) {
    const hit = files.filter((f) => rule.paths.some((g) => globToRegExp(g).test(f.replace(/\\/g, "/"))));
    if (hit.length) out.push({ rule, files: hit });
  }
  return out;
}

/**
 * The runs that count for a named command: run by Graft or a harness (not
 * attested), carrying the name (or, with `labelIsName`, the name as label) or
 * the catalog's text, exited 0, not marked stale, and not followed by a later
 * run of the same command that failed: the latest result is the one that holds.
 */
export function coveringRuns(evidence: Evidence[], name: string, command: string, opts: { labelIsName?: boolean } = {}): CommandEvidence[] {
  const want = normalizeCommand(command);
  const labelIsName = opts.labelIsName ?? true;
  const runs = evidence.filter(
    (e): e is CommandEvidence =>
      e.kind === "command" &&
      !e.attested &&
      (e.name === name || (labelIsName && !e.name && e.label === name) || normalizeCommand(e.command) === want),
  );
  const lastFail = runs.map((r) => r.exitCode !== 0).lastIndexOf(true);
  return runs.slice(lastFail + 1).filter((r) => r.exitCode === 0 && !r.stale);
}

/**
 * Expand `$NAME` / `${NAME}` in a policy template from `env`. `${NAME#prefix}`
 * and `${NAME%suffix}` strip a literal affix, as in sh. `missing` names the
 * first variable that was unset or empty, in which case the value is not
 * usable and the caller leaves the line out rather than writing a hole.
 */
export function expandTemplate(
  template: string,
  env: Record<string, string | undefined> = process.env,
): { value: string; missing?: string } {
  let missing: string | undefined;
  const value = template.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:([#%])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_, braced, op, affix, bare) => {
      const name = braced ?? bare;
      let v = env[name];
      if (v === undefined || v === "") {
        missing ??= name;
        return "";
      }
      if (op === "#" && affix && v.startsWith(affix)) v = v.slice(affix.length);
      if (op === "%" && affix && v.endsWith(affix)) v = v.slice(0, -affix.length);
      return v;
    },
  );
  return missing ? { value, missing } : { value };
}

/**
 * Expand policy trailers from `env`. Returns the trailers to write and the
 * ones skipped because a variable was unset, with the variable's name, so the
 * caller can say so.
 */
export function expandTrailers(
  trailers: string[],
  env: Record<string, string | undefined> = process.env,
): { trailers: string[]; skipped: { trailer: string; missing: string }[] } {
  const out: string[] = [];
  const skipped: { trailer: string; missing: string }[] = [];
  for (const t of trailers) {
    const { value, missing } = expandTemplate(t, env);
    if (missing) skipped.push({ trailer: t, missing });
    else out.push(value);
  }
  return { trailers: out, skipped };
}
