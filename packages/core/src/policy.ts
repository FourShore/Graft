import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
}

export const DEFAULT_POLICY: Policy = { version: 1, requireEvidence: true };

export const POLICY_PATH = ".graft/policy.json";

export async function readPolicy(topLevel: string): Promise<Policy> {
  try {
    const raw = await readFile(join(topLevel, POLICY_PATH), "utf8");
    const parsed = JSON.parse(raw) as Partial<Policy>;
    if (parsed.version !== undefined && parsed.version !== 1) {
      throw new Error(`Unsupported policy version ${String(parsed.version)} in ${POLICY_PATH}`);
    }
    return { ...DEFAULT_POLICY, ...parsed, version: 1 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY;
    throw err;
  }
}

/**
 * Expand `$NAME` / `${NAME}` in policy trailers from `env`. Returns the
 * trailers to write and the ones skipped because a variable was unset, with
 * the variable's name, so the caller can say so.
 */
export function expandTrailers(
  trailers: string[],
  env: Record<string, string | undefined> = process.env,
): { trailers: string[]; skipped: { trailer: string; missing: string }[] } {
  const out: string[] = [];
  const skipped: { trailer: string; missing: string }[] = [];
  for (const t of trailers) {
    let missing: string | undefined;
    const expanded = t.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_, braced, bare) => {
      const name = braced ?? bare;
      const v = env[name];
      if (v === undefined || v === "") missing ??= name;
      return v ?? "";
    });
    if (missing) skipped.push({ trailer: t, missing });
    else out.push(expanded);
  }
  return { trailers: out, skipped };
}
