import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Repo policy, read from .graft/policy.json at the working tree root.
 * Version 1 has one rule. More arrive with the review view and the server.
 */
export interface Policy {
  version: 1;
  /** Refuse to land a change that has no evidence. Default true. */
  requireEvidence: boolean;
  /**
   * Extra files that must not be landed without --allow-secrets, as globs
   * relative to the repo root ("nova.json", "config/*.secret", "keys/**").
   * Added to the built-in list (.env, *.pem, ...).
   */
  secretFiles?: string[];
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
