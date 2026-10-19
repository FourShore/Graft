import { DEFAULT_POLICY, Graft, GraftError, POLICY_PATH, evaluateRules, matchCatalog, parsePolicy, runShell, type CommandEvidence, type LogEntry, type Policy } from "@fourshore/graft-core";
import { parseDiff } from "./diff.js";
import { triage, type Triage } from "./triage.js";

export interface CheckOptions {
  repo?: string;
  /** Commits in `base..HEAD` are checked. */
  base: string;
  /** Re-run the recorded passing commands the policy allows once on the current checkout. */
  rerun?: boolean;
  /** Upper bound on commits examined; a range with more fails rather than being cut short silently. */
  limit?: number;
}

export type Finding =
  | { kind: "no-record"; commit: string; title: string; files: string[] }
  | { kind: "note-missing"; commit: string; title: string; files: string[] }
  | { kind: "no-evidence"; commit: string; title: string; files: string[] }
  | { kind: "no-passing-command"; commit: string; title: string; files: string[] }
  | { kind: "rule-unmet"; commit: string; title: string; files: string[]; names: { name: string; command: string }[] }
  | { kind: "rerun-failed"; command: string; commits: string[]; exitCode: number; output: string }
  | { kind: "rerun-skipped"; command: string; commits: string[]; reason: string }
  | { kind: "no-commits"; base: string }
  | { kind: "limit-reached"; base: string; limit: number };

export interface CheckedCommit {
  entry: LogEntry;
  triage: Triage;
  /** Whether this commit alone satisfies the policy, and its recorded commands passed again when re-run. */
  ok: boolean;
  /** A merge commit, checked by what it changed beyond merging its parents (git's remerge diff). */
  merge?: boolean;
  /** With re-runs: whether this commit's recorded commands passed again, failed, or none of them was run. */
  rerun?: "pass" | "fail" | "not run";
}

export interface Rerun {
  command: string;
  /** The catalog name whose current definition was run, when the record carried one. */
  name?: string;
  commits: string[];
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface CheckResult {
  /** The base as resolved: `main` becomes `origin/main` in a clone that has no local branch of that name. */
  base: string;
  head: string;
  policy: Policy;
  commits: CheckedCommit[];
  reruns: Rerun[];
  findings: Finding[];
  /** False when any finding blocks. */
  ok: boolean;
  /** True when recorded commands were re-run; otherwise every recorded pass is the author's claim. */
  rerun: boolean;
  /** Things a reviewer should know that do not fail the check, such as a branch that changes the policy. */
  notes: string[];
  /** Set when `rerun` was asked for but this check is itself a re-run command of an outer check, so it ran nothing. */
  nested?: boolean;
}

/** The mark the commit message puts on a command it cut short. */
const CLIPPED = "\u2026";

/** Set in the environment of every re-run command, so a recorded `graft check --rerun` does not re-run itself without end. */
export const RERUN_ENV = "GRAFT_CHECK_RERUN";

/**
 * Verify a branch's records the way a reviewer would at merge time: every
 * commit that changed behavior must carry a record with evidence that meets
 * the policy, and with `rerun` every recorded passing command is run again
 * on the current checkout, turning the author's claim into a fact (or a
 * failure). Commits that touch tests need evidence like behavior; mechanical
 * commits (docs, lockfiles, generated files) need nothing.
 */
export async function runCheck(opts: CheckOptions): Promise<CheckResult> {
  const graft = new Graft(opts.repo ?? process.cwd());
  const topLevel = await graft.git.topLevel();
  if ((await graft.git.run(["rev-parse", "--is-shallow-repository"])) === "true") {
    throw new GraftError("This clone is shallow, so base..HEAD may be cut short or missing. Fetch the whole history (actions/checkout with fetch-depth: 0, or git fetch --unshallow) and check again.");
  }
  const head = (await graft.git.head()) ?? "";
  const base = await resolveBase(graft, opts.base);
  const notes: string[] = [];
  // The policy comes from the base: a pull request must not be able to relax the rules it is checked against.
  const policy = await checkPolicy(graft, base, notes);
  const limit = opts.limit ?? 200;
  // One past the limit, to tell a range that fits from one that was cut short.
  const all = await graft.log({ range: `${base}..HEAD`, limit: limit + 1 });
  const entries = all.slice(0, limit);
  const findings: Finding[] = [];
  if (all.length === 0) findings.push({ kind: "no-commits", base });
  if (all.length > limit) findings.push({ kind: "limit-reached", base, limit });
  const merges = new Set((await graft.git.run(["rev-list", "--merges", `${base}..HEAD`])).split("\n").filter(Boolean));
  const remerge = merges.size > 0 && (await supportsRemergeDiff(graft));
  if (merges.size && !remerge) {
    notes.push(`${merges.size} merge commit${merges.size === 1 ? " was" : "s were"} not inspected: this git has no --remerge-diff (2.36 or newer), so an edit made inside a merge is not checked.`);
  }
  const commits: CheckedCommit[] = [];
  for (const entry of entries) {
    const merge = merges.has(entry.commit);
    if (merge && !remerge) continue;
    const files = parseDiff(await graft.diff(entry.commit, { remerge: merge }));
    // A clean merge changes nothing beyond merging; only one with its own edits (or conflict resolutions) needs a record.
    if (merge && !files.length) continue;
    const t = triage(entry.record, files, entry.trailers, entry.recordSource, policy.behaviorFiles);
    // Tests count: weakening an assertion is the cheapest way to green, so a tests-only commit needs evidence too.
    const behavior = [...t.groups.behavior, ...t.groups.tests].map((f) => f.path);
    // "partial" is triage's name for a record whose evidence lives only in a note this clone lacks.
    const partial = t.risk === "partial";
    // A rename is covered by the rules for where the file came from as well as where it went.
    const paths = [...new Set(files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])))];
    const unmet = partial ? [] : evaluateRules(policy, paths, entry.record?.evidence ?? []);
    let ok = true;
    if (behavior.length && policy.requireEvidence) {
      const base = { commit: entry.commit, title: entry.title, files: behavior };
      if (!entry.record) {
        findings.push({ kind: "no-record", ...base });
        ok = false;
      } else if (partial) {
        findings.push({ kind: "note-missing", ...base });
        ok = false;
      } else if (entry.record.evidence.length === 0) {
        findings.push({ kind: "no-evidence", ...base });
        ok = false;
      } else if (policy.requireEvidence === "command" && !passingCommands(entry).length) {
        findings.push({ kind: "no-passing-command", ...base });
        ok = false;
      }
    }
    if (unmet.length) {
      const ruleFiles = [...new Set(unmet.flatMap((u) => u.files))];
      if (!entry.record) {
        if (ok) findings.push({ kind: "no-record", commit: entry.commit, title: entry.title, files: ruleFiles });
      } else if (partial) {
        if (ok) findings.push({ kind: "note-missing", commit: entry.commit, title: entry.title, files: ruleFiles });
      } else {
        findings.push({
          kind: "rule-unmet",
          commit: entry.commit,
          title: entry.title,
          files: ruleFiles,
          names: unmet.map((u) => ({ name: u.name, command: u.command })),
        });
      }
      ok = false;
    }
    commits.push({ entry, triage: t, ok, ...(merge ? { merge: true } : {}) });
  }

  const reruns: Rerun[] = [];
  const nested = Boolean(opts.rerun && process.env[RERUN_ENV]);
  const rerun = Boolean(opts.rerun && !nested);
  if (rerun) {
    // A run recorded under a catalog name, or as a catalog command's text, re-runs the name's current definition.
    const byCommand = new Map<string, { shas: string[]; name?: string }>();
    for (const c of commits) {
      for (const ev of passingCommands(c.entry, true)) {
        // A record read from the commit message carries the name as the label.
        const named = ev.name ?? ev.label;
        const name = named && policy.commands?.[named] ? named : matchCatalog(policy, ev.command) ?? undefined;
        const command = name ? policy.commands![name] : ev.command;
        const slot = byCommand.get(command) ?? { shas: [], ...(name ? { name } : {}) };
        if (!slot.shas.includes(c.entry.commit)) slot.shas.push(c.entry.commit);
        byCommand.set(command, slot);
      }
    }
    for (const [command, { shas, name }] of byCommand) {
      // Anything else is text from a commit message: run it only when the policy allows it in full.
      if (!name && !policy.checkCommands?.some((p) => fullMatch(p, command))) {
        const reason = policy.checkCommands
          ? "not a policy command, and it matches no checkCommands pattern in full"
          : "not a policy command, and the policy sets no checkCommands to allow other commands";
        findings.push({ kind: "rerun-skipped", command, commits: shas, reason });
        continue;
      }
      if (command.endsWith(CLIPPED)) {
        // The record came from the commit message, which cuts long commands; running the stump would prove nothing.
        findings.push({ kind: "rerun-skipped", command, commits: shas, reason: "cut short in the commit message; fetch refs/notes/graft for the full command" });
        continue;
      }
      const started = Date.now();
      const previous = process.env[RERUN_ENV];
      process.env[RERUN_ENV] = "1";
      let result: { exitCode: number; output: string };
      try {
        result = await runShell(command, topLevel);
      } finally {
        if (previous === undefined) delete process.env[RERUN_ENV];
        else process.env[RERUN_ENV] = previous;
      }
      const { exitCode, output } = result;
      reruns.push({ command, ...(name ? { name } : {}), commits: shas, exitCode, durationMs: Date.now() - started, output });
      if (exitCode !== 0) findings.push({ kind: "rerun-failed", command, commits: shas, exitCode, output });
    }
    for (const c of commits) {
      const mine = reruns.filter((x) => x.commits.includes(c.entry.commit));
      c.rerun = mine.some((x) => x.exitCode !== 0) ? "fail" : mine.length ? "pass" : "not run";
      if (c.rerun === "fail") c.ok = false;
    }
  }
  const ok = findings.every((f) => f.kind === "rerun-skipped");
  return { base, head, policy, commits, reruns, findings, ok, rerun, notes, ...(nested ? { nested: true } : {}) };
}

/**
 * The policy a branch is checked against: the base's, so the branch cannot
 * relax it. Only when the base has no policy file (the pull request that
 * adopts Graft) is the branch's own used. Either way a branch that changes
 * the file gets a note saying so.
 */
async function checkPolicy(graft: Graft, base: string, notes: string[]): Promise<Policy> {
  const atBase = await policyAt(graft, base);
  const atHead = await policyAt(graft, "HEAD");
  if (atBase !== null) {
    if (atHead !== atBase) notes.push(`This branch changes ${POLICY_PATH}; it was checked against the base's policy, and the change applies once it merges.`);
    return parsePolicy(atBase);
  }
  if (atHead !== null) {
    notes.push(`The base has no ${POLICY_PATH}, so this branch was checked against the policy it adds.`);
    return parsePolicy(atHead);
  }
  return DEFAULT_POLICY;
}

/** The policy file's text at a commit, or null when it has none. */
async function policyAt(graft: Graft, commit: string): Promise<string | null> {
  try {
    await graft.git.run(["cat-file", "-e", `${commit}:${POLICY_PATH}`]);
  } catch {
    return null;
  }
  return graft.git.run(["show", `${commit}:${POLICY_PATH}`]);
}

/** `git show --remerge-diff` arrived in git 2.36. */
async function supportsRemergeDiff(graft: Graft): Promise<boolean> {
  const m = /(\d+)\.(\d+)/.exec(await graft.git.run(["version"]));
  return Boolean(m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 36)));
}

/**
 * A CI checkout has `origin/main` but no local `main`, so a recorded
 * `graft check --base main` would fail there for no reason of its own: when
 * the base is not a ref in this clone, try the same name under `origin/`.
 */
async function resolveBase(graft: Graft, base: string): Promise<string> {
  const exists = async (ref: string) => {
    try {
      await graft.git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  if (await exists(base)) return base;
  if (await exists(`origin/${base}`)) return `origin/${base}`;
  throw new GraftError(`Base "${base}" is not a commit in this clone (nor is origin/${base}). Fetch it, or pass --base <ref>.`);
}

/**
 * The commands recorded as exiting 0. An attested run is the author's claim,
 * so it does not satisfy the policy unless `withAttested` is set; re-runs
 * include it, since running it is how the claim becomes a fact.
 */
function passingCommands(entry: LogEntry, withAttested = false): CommandEvidence[] {
  return (entry.record?.evidence ?? []).filter(
    (e): e is CommandEvidence => e.kind === "command" && e.exitCode === 0 && (withAttested || !e.attested),
  );
}

/** Whether a checkCommands pattern matches the whole command, not just part of it. */
function fullMatch(pattern: string, s: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(s);
  } catch {
    return false;
  }
}

/** The result as lines for a terminal or a CI log. */
export function renderCheckText(r: CheckResult): string {
  const lines: string[] = [];
  const n = r.commits.length;
  lines.push(`Graft check: ${n} commit${n === 1 ? "" : "s"} in ${r.base}..${r.head.slice(0, 10)} (policy requireEvidence: ${JSON.stringify(r.policy.requireEvidence)})`);
  for (const c of r.commits) {
    const r0 = c.entry.record;
    const who = r0 ? `${r0.author.kind}:${r0.author.name}` : c.entry.authorName;
    const files = `${c.triage.groups.behavior.length} behavior, ${c.triage.groups.tests.length} tests, ${c.triage.groups.mechanical.length} mechanical`;
    const ev = r0 ? `${describePassing(c.entry)}, ${r0.evidence.length} evidence` : "no record";
    lines.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.entry.commit.slice(0, 10)}  ${c.entry.title}`);
    lines.push(`       ${c.merge ? "merge · " : ""}${c.triage.risk} · ${who} · ${files} · ${ev}${overridden(c)}${c.rerun ? ` · re-run: ${c.rerun}` : ""}`);
  }
  if (r.notes.length) {
    lines.push("", "Notes:");
    for (const n of r.notes) lines.push(`  - ${n}`);
  }
  if (r.nested) lines.push("", "Re-run skipped: this check is itself a command an outer graft check is re-running.");
  else if (!r.rerun && r.commits.length) lines.push("", NOT_RERUN);
  if (r.reruns.length) {
    lines.push("", `Re-ran ${r.reruns.length} recorded command${r.reruns.length === 1 ? "" : "s"} on this checkout:`);
    for (const x of r.reruns) {
      lines.push(`  ${x.exitCode === 0 ? "pass" : `FAIL ${x.exitCode}`}  ${x.name ? `${x.name}: ` : ""}${x.command} (${(x.durationMs / 1000).toFixed(1)}s, recorded on ${x.commits.map((s) => s.slice(0, 10)).join(", ")})`);
    }
  }
  const skipped = r.findings.filter((f) => f.kind === "rerun-skipped");
  const blocking = r.findings.filter((f) => f.kind !== "rerun-skipped");
  if (skipped.length) {
    lines.push("", `Not re-run (${skipped.length}):`);
    for (const f of skipped) lines.push(`  - ${describeFinding(f)}`);
  }
  if (blocking.length) {
    lines.push("", "Findings:");
    for (const f of blocking) lines.push(`  - ${describeFinding(f)}`);
  }
  lines.push("", r.ok ? "PASS: every behavior change carries evidence that meets the policy." : "FAIL: see findings above.");
  return lines.join("\n");
}

const NOT_RERUN = "Recorded evidence was not re-run: every pass above is the author's claim. Run with --rerun to make it a fact.";

/** The overrides a commit landed past the gate with, as a suffix for its line. */
function overridden(c: CheckedCommit): string {
  const o = c.entry.record?.overrides ?? [];
  return o.length ? ` · override: ${o.join(", ")}` : "";
}

function describePassing(entry: LogEntry): string {
  const run = passingCommands(entry).length;
  const attested = passingCommands(entry, true).length - run;
  return `${run} passing command${run === 1 ? "" : "s"}${attested ? ` (${attested} more attested)` : ""}`;
}

export function describeFinding(f: Finding): string {
  switch (f.kind) {
    case "no-record":
      return `${f.commit.slice(0, 10)} "${f.title}" changed ${f.files.join(", ")} with no change record. Land it with graft land, or commit with the Graft hooks installed.`;
    case "note-missing":
      return `${f.commit.slice(0, 10)} "${f.title}" changed ${f.files.join(", ")} and its evidence lives only in the git note, which this clone does not have. Fetch it (git fetch origin '+refs/notes/graft:refs/notes/graft', or graft sync) and check again.`;
    case "no-evidence":
      return `${f.commit.slice(0, 10)} "${f.title}" changed ${f.files.join(", ")} with a record but no evidence.`;
    case "no-passing-command":
      return `${f.commit.slice(0, 10)} "${f.title}" changed ${f.files.join(", ")} with no passing command as evidence (policy requireEvidence: "command"; notes and attested runs do not count).`;
    case "rule-unmet":
      return `${f.commit.slice(0, 10)} "${f.title}" changed ${f.files.join(", ")} without a passing run of ${f.names.map((n) => `"${n.name}" (${n.command})`).join(" and ")}, which the policy rules require for those paths.`;
    case "rerun-failed":
      return `"${f.command}" was recorded as passing on ${f.commits.map((s) => s.slice(0, 10)).join(", ")} but exits ${f.exitCode} on this checkout.\n${indent(tail(f.output, 20))}`;
    case "rerun-skipped":
      return `"${f.command}" was not re-run: ${f.reason}.`;
    case "no-commits":
      return `No commits to check in ${f.base}..HEAD. Is the base right, and was the pull request's head checked out with fetch-depth: 0?`;
    case "limit-reached":
      return `${f.base}..HEAD has more than ${f.limit} commits and only the newest ${f.limit} were checked. Raise --limit to check them all.`;
  }
}

/** GitHub Actions workflow commands: one annotation per finding and note, plus a step summary in Markdown. */
export function renderCheckGithub(r: CheckResult): { annotations: string[]; summary: string } {
  const annotations = r.findings
    .filter((f) => f.kind !== "rerun-skipped")
    .map((f) => annotation("error", "Graft check", describeFinding(f).split("\n")[0]));
  for (const n of r.notes) annotations.push(annotation("warning", "Graft check", n));
  for (const c of r.commits) {
    const o = c.entry.record?.overrides ?? [];
    if (o.length) annotations.push(annotation("warning", "Graft override", `${c.entry.commit.slice(0, 10)} "${c.entry.title}" was landed past the gate with the ${o.join(" and ")} override (Graft-Override).`));
  }
  const rows = r.commits.map(
    (c) =>
      `| ${c.ok ? "✅" : "❌"} | \`${c.entry.commit.slice(0, 10)}\` | ${escapePipes(c.entry.title)} | ${escapePipes(taskCell(c))} | ${c.merge ? "merge, " : ""}${c.triage.risk}${overridden(c)} | ${c.entry.record ? passingCommands(c.entry).length : 0} |${r.rerun ? ` ${c.rerun ?? ""} |` : ""} ${c.triage.groups.behavior.length} |`,
  );
  const summary = [
    `### Graft check: ${r.ok ? "pass" : "fail"}`,
    "",
    `${r.commits.length} commit(s) in \`${r.base}..${r.head.slice(0, 10)}\`, policy \`requireEvidence: ${JSON.stringify(r.policy.requireEvidence)}\`.`,
    ...(!r.rerun && r.commits.length ? ["", `**${NOT_RERUN}**`] : []),
    "",
    `| | Commit | Title | Task | Risk | Passing commands |${r.rerun ? " Re-run |" : ""} Behavior files |`,
    `| --- | --- | --- | --- | --- | --- |${r.rerun ? " --- |" : ""} --- |`,
    ...rows,
    ...(r.notes.length ? ["", "#### Notes", "", ...r.notes.map((n) => `- ${n}`)] : []),
    ...(r.reruns.length
      ? ["", "#### Re-run on this checkout", "", "| | Command | Recorded on |", "| --- | --- | --- |", ...r.reruns.map((x) => `| ${x.exitCode === 0 ? "✅" : `❌ exit ${x.exitCode}`} | \`${escapePipes(x.command)}\` | ${x.commits.map((s) => `\`${s.slice(0, 10)}\``).join(", ")} |`)]
      : []),
    ...(r.findings.some((f) => f.kind === "rerun-skipped")
      ? ["", "#### Not re-run", "", ...r.findings.filter((f) => f.kind === "rerun-skipped").map((f) => `- ${describeFinding(f).split("\n")[0]}`)]
      : []),
    ...(r.findings.some((f) => f.kind !== "rerun-skipped")
      ? ["", "#### Findings", "", ...r.findings.filter((f) => f.kind !== "rerun-skipped").map((f) => `- ${describeFinding(f).split("\n")[0]}`)]
      : []),
    "",
  ].join("\n");
  return { annotations, summary };
}

/** The record's task for a table cell: one line, cut at about 80 characters. */
function taskCell(c: CheckedCommit): string {
  const task = (c.entry.record?.task ?? "").replace(/\s+/g, " ").trim();
  return task.length > 80 ? `${task.slice(0, 79)}\u2026` : task;
}

/** A workflow command for one annotation, with its message and title escaped so neither can end it early or start another. */
function annotation(level: "error" | "warning", title: string, message: string): string {
  return `::${level} title=${escapeGithubProperty(title)}::${escapeGithubData(message)}`;
}

/** Escape a workflow command's message, as the Actions toolkit does. */
export function escapeGithubData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escape a workflow command's property value (such as title), as the Actions toolkit does. */
export function escapeGithubProperty(s: string): string {
  return escapeGithubData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function tail(s: string, n: number): string {
  const lines = s.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "      " + l)
    .join("\n");
}
