import { posix } from "node:path";
import { parseNameStatus, type ChangedFile } from "./diff.js";
import { MANIFEST_PATH, allowedFor, globToRegExp, parseManifest, type Manifest } from "./manifest.js";
import { grantKey, isSourcePath, pathAliases, scanSource, type Grant, type ScanOptions } from "./scan.js";
import { PACKAGES, packageGrants, type Capability } from "./table.js";
import { EMPTY_TREE, GitTree, WorkTree, git, remergeTree, type Tree } from "./tree.js";

/** What Graft sends a reviewer command on stdin. */
export interface ReviewRequest {
  name: string;
  task: string;
  diff: string;
  instructions?: string;
  /** The commit under review at `graft check`; absent when the working tree is. */
  commit?: string;
  /** The commit the diff is against; absent for a root commit and for a merge. */
  base?: string;
}

export interface Finding {
  severity: "blocker" | "warning" | "nit";
  file?: string;
  line?: number;
  text: string;
}

/** What a reviewer command prints on stdout. */
export interface ReviewResult {
  model: string;
  verdict: "approve" | "request-changes";
  summary: string;
  findings: Finding[];
}

/** A capability a file holds: directly, or through a project file it imports. */
export interface Held {
  key: string;
  cap: Capability;
  grant: Grant;
  /** The project file the capability comes through, when inherited. */
  via?: string;
}

export interface FileCapabilities {
  path: string;
  direct: Held[];
  inherited: Held[];
}

export interface Change {
  file: ChangedFile;
  before: FileCapabilities | null;
  after: FileCapabilities | null;
  gained: Held[];
  inherited: Held[];
  lost: Held[];
}

export interface Analysis extends ReviewResult {
  changes: Change[];
  /** New and removed entries in a package.json's dependencies. */
  dependencies: { path: string; name: string; added: boolean; grants?: readonly Capability[] }[];
  notes: string[];
  manifest: Manifest | null;
}

export interface AnalyzeOptions {
  /** The repository's top level: where `git` runs and the working tree is read. */
  cwd: string;
  /** Named in the result's `model`, as a reviewer names itself. */
  version?: string;
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

/**
 * The capabilities each changed file holds before and after, and the
 * difference, as a ReviewResult: a capability a file gains is a warning (a
 * blocker when a manifest does not allow it there), one it inherits through an
 * import it adds is a nit, one it loses is a nit, and a new dependency is a
 * warning that says what the table knows of the package.
 */
export async function analyze(request: ReviewRequest, opts: AnalyzeOptions): Promise<Analysis> {
  const { cwd } = opts;
  const model = `graft-capabilities/${opts.version ?? "0"}`;
  const notes: string[] = [];
  const findings: Finding[] = [];

  // Trees: the commit under review and what its diff is against, or the working tree and HEAD.
  let after: Tree;
  let before: Tree;
  // Where the manifest is read from: the base, which for a merge is its first parent.
  let manifestRev: string | undefined;
  let files: ChangedFile[];
  if (request.base) await mustExist(cwd, request.base, "base");
  if (request.commit) {
    await mustExist(cwd, request.commit, "commit");
    after = new GitTree(cwd, request.commit);
    const parents = (await git(cwd, ["rev-list", "--parents", "-n", "1", request.commit])).split(/\s+/).slice(1);
    let from = request.base;
    if (!from && parents.length > 1) {
      // A merge: Graft reviews its diff against git's own re-merge of the parents, so only what the merge itself
      // changed (a conflict resolution, an edit) is under review, not what came in from either side.
      const remerged = parents.length === 2 ? await remergeTree(cwd, parents[0], parents[1]) : undefined;
      if (remerged) {
        from = remerged;
        notes.push("Compared against git's re-merge of the parents.");
      } else {
        from = parents[0];
        notes.push("Compared against the commit's first parent.");
      }
      manifestRev = parents[0];
    } else if (!from && parents.length === 1) {
      from = parents[0];
    }
    manifestRev ??= from;
    before = from ? new GitTree(cwd, from) : EMPTY_TREE;
    const args = ["-c", "core.quotePath=false", "diff-tree", "-r", "-M", "--no-commit-id", "--name-status", "-z", ...(from ? [from, request.commit] : ["--root", request.commit])];
    files = parseNameStatus(await git(cwd, args));
  } else {
    after = new WorkTree(cwd);
    const from = request.base ?? ((await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")) || undefined);
    manifestRev = from;
    before = from ? new GitTree(cwd, from) : EMPTY_TREE;
    // The files from git, not from the diff text, which Graft cuts at a size: a file past the cut is still reviewed.
    const untracked = parseNameStatus(
      (await git(cwd, ["-c", "core.quotePath=false", "ls-files", "-z", "--others", "--exclude-standard", ...(from ? [] : ["--cached"])]))
        .split("\0")
        .filter(Boolean)
        .map((f) => `A\0${f}`)
        .join("\0"),
    );
    const tracked = from ? parseNameStatus(await git(cwd, ["-c", "core.quotePath=false", "diff", "-M", "--name-status", "-z", from])) : [];
    files = [...tracked, ...untracked];
  }

  // The manifest comes from the base, like the policy: a change cannot widen what it is checked against.
  // One that does not parse gates with no rules at all, so breaking it opens nothing.
  let manifest: Manifest | null = null;
  const manifestText = await (manifestRev ? new GitTree(cwd, manifestRev) : after).read(MANIFEST_PATH);
  if (manifestText !== null) {
    try {
      manifest = parseManifest(manifestText);
    } catch (e) {
      manifest = { version: 1, allow: [] };
      findings.push({ severity: "warning", file: MANIFEST_PATH, text: `${(e as Error).message} Until it is fixed nothing is allowed, so every capability a file gains is a blocker.` });
    }
  }
  // A change to the manifest is checked here, so a broken one never lands to fail every later review.
  const touched = files.find((f) => f.path === MANIFEST_PATH && f.status !== "deleted");
  if (touched) {
    const next = await after.read(MANIFEST_PATH);
    if (next !== null) {
      try {
        parseManifest(next);
      } catch (e) {
        findings.push({ severity: "blocker", file: MANIFEST_PATH, text: `The new manifest does not parse: ${(e as Error).message}` });
      }
    }
  }
  const packages = manifest?.packages ? { ...PACKAGES, ...manifest.packages } : PACKAGES;
  const beforeOpts: ScanOptions = { packages: manifest?.packages, internal: await workspacePackages(before), aliases: await pathAliases(before) };
  const afterOpts: ScanOptions = { packages: manifest?.packages, internal: await workspacePackages(after), aliases: await pathAliases(after) };

  const changes: Change[] = [];
  const dependencies: Analysis["dependencies"] = [];
  for (const file of files) {
    if (posix.basename(file.path) === "package.json" && !/(^|\/)node_modules\//.test(file.path)) {
      const was = file.status === "added" ? null : await before.read(file.oldPath ?? file.path);
      const now = file.status === "deleted" ? null : await after.read(file.path);
      const wasDeps = dependenciesOf(was);
      const nowDeps = dependenciesOf(now);
      for (const name of nowDeps) {
        if (wasDeps.has(name) || afterOpts.internal?.has(name)) continue;
        const grants = packageGrants(name, packages);
        if (grants && !grants.length) continue; // the table says it reaches nothing outside the program
        dependencies.push({ path: file.path, name, added: true, ...(grants ? { grants } : {}) });
        findings.push({
          severity: "warning",
          file: file.path,
          text: grants ? `New dependency ${name}, which grants ${grants.join(", ")}.` : `New dependency ${name}, which the table does not know; files that import it hold dep.`,
        });
      }
      for (const name of wasDeps) {
        if (nowDeps.has(name)) continue;
        dependencies.push({ path: file.path, name, added: false });
        findings.push({ severity: "nit", file: file.path, text: `Dependency ${name} removed.` });
      }
      continue;
    }
    if (!isSourcePath(file.path) && !(file.oldPath && isSourcePath(file.oldPath))) continue;
    let b: FileCapabilities | null = null;
    let a: FileCapabilities | null = null;
    try {
      b = file.status === "added" ? null : await capabilitiesOf(before, file.oldPath ?? file.path, beforeOpts);
      a = file.status === "deleted" ? null : await capabilitiesOf(after, file.path, afterOpts);
    } catch (e) {
      // What cannot be read cannot be shown to be within the manifest, so under one it does not pass.
      findings.push({ severity: manifest ? "blocker" : "warning", file: file.path, text: `Not analyzed: ${(e as Error).message}.` });
      continue;
    }
    const beforeKeys = new Set([...(b?.direct ?? []), ...(b?.inherited ?? [])].map((h) => h.key));
    const beforeDirect = new Set((b?.direct ?? []).map((h) => h.key));
    const afterKeys = new Set([...(a?.direct ?? []), ...(a?.inherited ?? [])].map((h) => h.key));
    const gained = (a?.direct ?? []).filter((h) => !beforeDirect.has(h.key));
    const inherited = (a?.inherited ?? []).filter((h) => !beforeKeys.has(h.key));
    const lost = (b?.direct ?? []).filter((h) => !afterKeys.has(h.key));
    changes.push({ file, before: b, after: a, gained, inherited, lost });
    const allowed = manifest ? allowedFor(manifest, file.path) : null;
    for (const h of gained) {
      const ok = allowed ? allowed.has(h.cap) : null;
      findings.push({
        severity: ok === false ? "blocker" : ok === true ? "nit" : "warning",
        file: file.path,
        line: h.grant.line,
        text: `${h.cap} added: ${h.grant.why}.${ok === false ? ` ${MANIFEST_PATH} does not allow ${h.cap} for this path.` : ""}`,
      });
    }
    // A file moved to a path that may not hold what it holds: the capability did not change, but where it lives did.
    if (manifest && allowed && file.oldPath && file.oldPath !== file.path && a) {
      const was = allowedFor(manifest, file.oldPath);
      const gainedKeys = new Set(gained.map((h) => h.key));
      const reported = new Set<Capability>();
      for (const h of a.direct) {
        if (gainedKeys.has(h.key) || allowed.has(h.cap) || !was.has(h.cap) || reported.has(h.cap)) continue;
        reported.add(h.cap);
        findings.push({
          severity: "blocker",
          file: file.path,
          line: h.grant.line,
          text: `${h.cap} moved in from ${file.oldPath}: ${h.grant.why}. ${MANIFEST_PATH} does not allow ${h.cap} for this path.`,
        });
      }
    }
    for (const h of inherited) {
      findings.push({ severity: "nit", file: file.path, line: h.grant.line, text: `${h.cap} inherited: imports ${h.via}, which ${h.grant.why}.` });
    }
    for (const h of lost) {
      findings.push({ severity: "nit", file: file.path, text: `${h.cap} removed: no longer ${h.grant.why}.` });
    }
  }
  if (manifest && manifestRev) notes.push(`Gated by ${MANIFEST_PATH} at ${manifestRev.slice(0, 10)}.`);

  const order = { blocker: 0, warning: 1, nit: 2 };
  findings.sort((x, y) => order[x.severity] - order[y.severity] || (x.file ?? "").localeCompare(y.file ?? "") || (x.line ?? 0) - (y.line ?? 0));
  return {
    model,
    verdict: findings.some((f) => f.severity === "blocker") ? "request-changes" : "approve",
    summary: summarize(changes, dependencies, files.length, findings, notes),
    findings,
    changes,
    dependencies,
    notes,
    manifest,
  };
}

/** The capabilities one file holds in a tree: its own, and one level of those of the project files it imports. */
export async function capabilitiesOf(tree: Tree, path: string, opts: ScanOptions = {}): Promise<FileCapabilities | null> {
  const text = await tree.read(path);
  if (text === null) return null;
  const scan = scanSource(path, text, opts);
  const direct = scan.grants.map((grant) => ({ key: grantKey(grant), cap: grant.cap, grant }));
  const have = new Set(direct.map((h) => h.key));
  const inherited: Held[] = [];
  const seen = new Set<string>();
  for (const imp of scan.imports) {
    const target = await resolveImport(tree, path, imp.specifier);
    if (!target || target === path || seen.has(target)) continue;
    seen.add(target);
    const t = await tree.read(target);
    if (t === null) continue;
    for (const grant of scanSource(target, t, opts).grants) {
      const key = grantKey(grant);
      if (have.has(key)) continue;
      have.add(key);
      inherited.push({ key, cap: grant.cap, grant: { ...grant, line: imp.line }, via: imp.specifier });
    }
  }
  return { path, direct, inherited };
}

/** A relative import to the file it names: the path as written, with a source extension, `.js` read as `.ts`, or an index file. */
export async function resolveImport(tree: Tree, from: string, specifier: string): Promise<string | null> {
  const base = specifier.startsWith("/") ? specifier.slice(1) : posix.normalize(posix.join(posix.dirname(from), specifier));
  // A path that leaves the repository is not part of either tree.
  if (base === ".." || base.startsWith("../")) return null;
  const candidates = [base];
  const m = /\.(m|c)?jsx?$/.exec(base);
  if (m) {
    const stem = base.slice(0, -m[0].length);
    const ts = m[0].replace("js", "ts");
    candidates.push(`${stem}${ts}`, `${stem}.tsx`);
  }
  for (const ext of EXTENSIONS) candidates.push(`${base}${ext}`);
  for (const ext of EXTENSIONS) candidates.push(`${base}/index${ext}`);
  for (const c of candidates) {
    if (!isSourcePath(c)) continue;
    if ((await tree.read(c)) !== null) return c;
  }
  return null;
}

/**
 * The names of the repository's own packages: the root package.json's name and
 * those of its workspaces. A file that imports one imports project code, not a
 * dependency, so it is not reported as `dep`.
 */
export async function workspacePackages(tree: Tree): Promise<Set<string>> {
  const names = new Set<string>();
  const root = await tree.read("package.json");
  let pkg: Record<string, unknown> = {};
  try {
    if (root !== null) pkg = JSON.parse(root) as Record<string, unknown>;
  } catch {
    // Not JSON: no name and no workspaces from it.
  }
  if (typeof pkg.name === "string") names.add(pkg.name);
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray((pkg.workspaces as { packages?: unknown })?.packages) ? (pkg.workspaces as { packages: unknown[] }).packages : [];
  const globs = [...ws, ...pnpmWorkspaces(await tree.read("pnpm-workspace.yaml"))]
    .filter((w): w is string => typeof w === "string" && !w.startsWith("!"));
  if (!globs.length) return names;
  const manifests = (await tree.list()).filter((f) => posix.basename(f) === "package.json" && globs.some((g) => globToRegExp(g.replace(/\/$/, "")).test(posix.dirname(f))));
  for (const file of manifests) {
    try {
      const name = (JSON.parse((await tree.read(file)) ?? "{}") as { name?: unknown }).name;
      if (typeof name === "string") names.add(name);
    } catch {
      // Not JSON: not a package.
    }
  }
  return names;
}

/** The `packages` globs of a pnpm-workspace.yaml: the list under the top-level `packages:` key. */
export function pnpmWorkspaces(text: string | null): string[] {
  if (text === null) return [];
  const out: string[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line)) break;
    const m = /^\s+-\s*(['"]?)(.+?)\1\s*(#.*)?$/.exec(line);
    if (m) out.push(m[2]);
  }
  return out;
}

/** Fail rather than review against nothing: a missing base (a shallow clone) would make every capability look new, or none. */
async function mustExist(cwd: string, rev: string, what: string): Promise<void> {
  const ok = await git(cwd, ["cat-file", "-e", `${rev}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (!ok) throw new Error(`the ${what} ${rev} is not in this repository (a shallow clone? fetch with fetch-depth: 0)`);
}

function dependenciesOf(text: string | null): Set<string> {
  const out = new Set<string>();
  if (text === null) return out;
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    for (const field of ["dependencies", "optionalDependencies"]) {
      const deps = pkg[field];
      if (deps && typeof deps === "object") for (const name of Object.keys(deps as object)) out.add(name);
    }
  } catch {
    // Not JSON: nothing to compare.
  }
  return out;
}

function summarize(changes: Change[], deps: Analysis["dependencies"], fileCount: number, findings: Finding[], notes: string[]): string {
  const parts: string[] = [];
  const moved = changes.filter((c) => c.gained.length || c.inherited.length || c.lost.length);
  const scanned = changes.length + new Set(deps.map((d) => d.path)).size;
  if (!fileCount) parts.push("Nothing in the diff.");
  else if (!scanned) parts.push(`No JavaScript or TypeScript files among the ${fileCount} in the diff.`);
  else if (!moved.length && !deps.some((d) => d.added)) parts.push(`No capability changes in ${scanned} file${scanned === 1 ? "" : "s"}.`);
  else {
    const list = moved.map((c) => {
      const plus = [...new Set(c.gained.map((h) => h.cap))].map((cap) => `+${cap}`);
      const via = [...new Set(c.inherited.map((h) => h.cap))].map((cap) => `+${cap} (inherited)`);
      const minus = [...new Set(c.lost.map((h) => h.cap))].map((cap) => `-${cap}`);
      return `${c.file.path} ${[...plus, ...via, ...minus].join(" ")}`;
    });
    if (list.length) parts.push(`${list.length} of ${scanned} file${scanned === 1 ? "" : "s"} changed capabilities: ${clip(list.join("; "), 400)}.`);
    const added = deps.filter((d) => d.added);
    if (added.length) parts.push(`${added.length} new dependenc${added.length === 1 ? "y" : "ies"}: ${clip(added.map((d) => `${d.name} (${d.grants ? d.grants.join(", ") : "unknown"})`).join(", "), 200)}.`);
  }
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  if (blockers) parts.push(`${blockers} not allowed by the manifest.`);
  return [...parts, ...notes].join(" ");
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** The rules `graft-capabilities init` writes: one per distinct capability set, naming the files that hold it today. */
export async function buildManifest(tree: Tree, existing: Manifest | null = null): Promise<Manifest> {
  const groups = new Map<string, { capabilities: Capability[]; paths: string[] }>();
  const internal = await workspacePackages(tree);
  for (const path of (await tree.list()).filter(isSourcePath).sort()) {
    const caps = await capabilitiesOf(tree, path, { packages: existing?.packages, internal });
    if (!caps) continue;
    const set = [...new Set(caps.direct.map((h) => h.cap))].sort();
    if (!set.length) continue;
    const key = set.join(",");
    const g = groups.get(key) ?? { capabilities: set, paths: [] };
    // A root file is written anchored: a bare `index.js` would match every index.js in the repo.
    g.paths.push(path.includes("/") ? path : `./${path}`);
    groups.set(key, g);
  }
  const allow = [...groups.values()].sort((x, y) => x.paths[0].localeCompare(y.paths[0]));
  return { version: 1, allow, ...(existing?.packages ? { packages: existing.packages } : {}) };
}
