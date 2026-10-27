import { CAPABILITIES, isCapability, type Capability } from "./table.js";

export const MANIFEST_PATH = ".graft/capabilities.json";

/**
 * What each path may hold. Without a manifest every capability a file gains is
 * a warning: the check passes and the reviewer sees the delta. With one, a
 * capability gained outside what the file's paths allow is a blocker. The
 * check reads the manifest from the base of the range it checks, like the
 * policy, so a change cannot widen what it is checked against; widen it in a
 * commit of its own first.
 */
export interface Manifest {
  version: 1;
  /** A file may hold the union of the capabilities of every rule whose paths match it; a file no rule matches may hold none. */
  allow: { paths: string[]; capabilities: Capability[] }[];
  /** Packages beyond the built-in table: what each grants. */
  packages?: Record<string, Capability[]>;
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${MANIFEST_PATH} is not JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${MANIFEST_PATH} must be an object.`);
  const m = raw as Record<string, unknown>;
  if (m.version !== 1) throw new Error(`${MANIFEST_PATH}: unknown version ${JSON.stringify(m.version)}; this graft-capabilities reads version 1.`);
  for (const key of Object.keys(m)) if (!["version", "allow", "packages"].includes(key)) throw new Error(`${MANIFEST_PATH}: unknown key "${key}".`);
  if (!Array.isArray(m.allow)) throw new Error(`${MANIFEST_PATH}: "allow" must be a list of { paths, capabilities }.`);
  const allow = m.allow.map((r, i) => {
    const rule = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    if (!Array.isArray(rule.paths) || !rule.paths.length || !rule.paths.every((p) => typeof p === "string" && p)) {
      throw new Error(`${MANIFEST_PATH}: allow[${i}].paths must be a non-empty list of globs.`);
    }
    if (!Array.isArray(rule.capabilities) || !rule.capabilities.every((c) => typeof c === "string" && isCapability(c))) {
      throw new Error(`${MANIFEST_PATH}: allow[${i}].capabilities must list capabilities from ${CAPABILITIES.join(", ")}.`);
    }
    return { paths: rule.paths as string[], capabilities: rule.capabilities as Capability[] };
  });
  const packages: Record<string, Capability[]> = {};
  if (m.packages !== undefined) {
    if (!m.packages || typeof m.packages !== "object" || Array.isArray(m.packages)) throw new Error(`${MANIFEST_PATH}: "packages" must map a package name to its capabilities.`);
    for (const [name, caps] of Object.entries(m.packages as Record<string, unknown>)) {
      if (!Array.isArray(caps) || !caps.every((c) => typeof c === "string" && isCapability(c))) {
        throw new Error(`${MANIFEST_PATH}: packages["${name}"] must list capabilities from ${CAPABILITIES.join(", ")}.`);
      }
      packages[name] = caps as Capability[];
    }
  }
  return { version: 1, allow, ...(m.packages !== undefined ? { packages } : {}) };
}

/** The capabilities the manifest lets `path` hold. */
export function allowedFor(manifest: Manifest, path: string): Set<Capability> {
  const out = new Set<Capability>();
  const normal = path.replace(/\\/g, "/");
  for (const rule of manifest.allow) {
    if (rule.paths.some((g) => globToRegExp(g).test(normal))) for (const c of rule.capabilities) out.add(c);
  }
  return out;
}

/** Same rules as Graft's policy globs: `**` crosses directories, `*` and `?` stay within one, and a glob with no `/` matches a basename anywhere. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(glob.includes("/") ? `^${body}$` : `(^|/)${body}$`);
}
