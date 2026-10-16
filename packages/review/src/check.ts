import { Graft, readPolicy, runShell, type CommandEvidence, type LogEntry, type Policy } from "@fourshore/graft-core";
import { parseDiff } from "./diff.js";
import { triage, type Triage } from "./triage.js";

export interface CheckOptions {
  repo?: string;
  /** Commits in `base..HEAD` are checked. */
  base: string;
  /** Re-run every recorded passing command once on the current checkout. */
  rerun?: boolean;
  /** Upper bound on commits examined. */
  limit?: number;
}

export type Finding =
  | { kind: "no-record"; commit: string; title: string; files: string[] }
  | { kind: "no-evidence"; commit: string; title: string; files: string[] }
  | { kind: "no-passing-command"; commit: string; title: string; files: string[] }
  | { kind: "rerun-failed"; command: string; commits: string[]; exitCode: number; output: string }
  | { kind: "rerun-skipped"; command: string; commits: string[]; reason: string };

export interface CheckedCommit {
  entry: LogEntry;
  triage: Triage;
  /** Whether this commit alone satisfies the policy. */
  ok: boolean;
}

export interface Rerun {
  command: string;
  commits: string[];
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface CheckResult {
  base: string;
  head: string;
  policy: Policy;
  commits: CheckedCommit[];
  reruns: Rerun[];
  findings: Finding[];
  /** False when any finding blocks. */
  ok: boolean;
  /** Set when `rerun` was asked for but this check is itself a re-run command of an outer check, so it ran nothing. */
  nested?: boolean;
}

/** Set in the environment of every re-run command, so a recorded `graft check --rerun` does not re-run itself without end. */
export const RERUN_ENV = "GRAFT_CHECK_RERUN";

/**
 * Verify a branch's records the way a reviewer would at merge time: every
 * commit that changed behavior must carry a record with evidence that meets
 * the policy, and with `rerun` every recorded passing command is run again
 * on the current checkout, turning the author's claim into a fact (or a
 * failure). Mechanical commits (docs, lockfiles, tests only) need nothing.
 */
export async function runCheck(opts: CheckOptions): Promise<CheckResult> {
  const graft = new Graft(opts.repo ?? process.cwd());
  const topLevel = await graft.git.topLevel();
  const policy = await readPolicy(topLevel);
  const head = (await graft.git.head()) ?? "";
  const entries = await graft.log({ range: `${opts.base}..HEAD`, limit: opts.limit ?? 200, noMerges: true });
  const findings: Finding[] = [];
  const commits: CheckedCommit[] = [];
  for (const entry of entries) {
    const files = parseDiff(await graft.diff(entry.commit));
    const t = triage(entry.record, files, entry.trailers, entry.recordSource, policy.behaviorFiles);
    const behavior = t.groups.behavior.map((f) => f.path);
    let ok = true;
    if (behavior.length && policy.requireEvidence) {
      const base = { commit: entry.commit, title: entry.title, files: behavior };
      if (!entry.record) {
        findings.push({ kind: "no-record", ...base });
        ok = false;
      } else if (entry.record.evidence.length === 0) {
        findings.push({ kind: "no-evidence", ...base });
        ok = false;
      } else if (policy.requireEvidence === "command" && !passingCommands(entry).length) {
        findings.push({ kind: "no-passing-command", ...base });
        ok = false;
      }
    }
    commits.push({ entry, triage: t, ok });
  }

  const reruns: Rerun[] = [];
  const nested = Boolean(opts.rerun && process.env[RERUN_ENV]);
  if (opts.rerun && !nested) {
    const byCommand = new Map<string, string[]>();
    for (const c of commits) {
      for (const ev of passingCommands(c.entry)) {
        const list = byCommand.get(ev.command) ?? [];
        list.push(c.entry.commit);
        byCommand.set(ev.command, list);
      }
    }
    for (const [command, shas] of byCommand) {
      if (policy.checkCommands && !policy.checkCommands.some((p) => safeTest(p, command))) {
        findings.push({ kind: "rerun-skipped", command, commits: shas, reason: "not in policy checkCommands" });
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
      reruns.push({ command, commits: shas, exitCode, durationMs: Date.now() - started, output });
      if (exitCode !== 0) findings.push({ kind: "rerun-failed", command, commits: shas, exitCode, output });
    }
  }
  const ok = findings.every((f) => f.kind === "rerun-skipped");
  return { base: opts.base, head, policy, commits, reruns, findings, ok, ...(nested ? { nested: true } : {}) };
}

function passingCommands(entry: LogEntry): CommandEvidence[] {
  return (entry.record?.evidence ?? []).filter((e): e is CommandEvidence => e.kind === "command" && e.exitCode === 0);
}

function safeTest(pattern: string, s: string): boolean {
  try {
    return new RegExp(pattern).test(s);
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
    const ev = r0
      ? `${passingCommands(c.entry).length} passing command${passingCommands(c.entry).length === 1 ? "" : "s"}, ${r0.evidence.length} evidence`
      : "no record";
    lines.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.entry.commit.slice(0, 10)}  ${c.entry.title}`);
    lines.push(`       ${c.triage.risk} · ${who} · ${files} · ${ev}`);
  }
  if (r.nested) lines.push("", "Re-run skipped: this check is itself a command an outer graft check is re-running.");
  if (r.reruns.length) {
    lines.push("", `Re-ran ${r.reruns.length} recorded command${r.reruns.length === 1 ? "" : "s"} on this checkout:`);
    for (const x of r.reruns) {
      lines.push(`  ${x.exitCode === 0 ? "pass" : `FAIL ${x.exitCode}`}  ${x.command} (${(x.durationMs / 1000).toFixed(1)}s, recorded on ${x.commits.map((s) => s.slice(0, 10)).join(", ")})`);
    }
  }
  if (r.findings.length) {
    lines.push("", "Findings:");
    for (const f of r.findings) lines.push(`  - ${describeFinding(f)}`);
  }
  lines.push("", r.ok ? "PASS: every behavior change carries evidence that meets the policy." : "FAIL: see findings above.");
  return lines.join("\n");
}

export function describeFinding(f: Finding): string {
  switch (f.kind) {
    case "no-record":
      return `${f.commit.slice(0, 10)} "${f.title}" changed ${f.files.join(", ")} with no change record. Land it with graft land, or commit with the Graft hooks installed.`;
    case "no-evidence":
      return `${f.commit.slice(0, 10)} "${f.title}" changed ${f.files.join(", ")} with a record but no evidence.`;
    case "no-passing-command":
      return `${f.commit.slice(0, 10)} "${f.title}" changed ${f.files.join(", ")} with no passing command as evidence (policy requireEvidence: "command").`;
    case "rerun-failed":
      return `"${f.command}" was recorded as passing on ${f.commits.map((s) => s.slice(0, 10)).join(", ")} but exits ${f.exitCode} on this checkout.\n${indent(tail(f.output, 20))}`;
    case "rerun-skipped":
      return `"${f.command}" was not re-run: ${f.reason}.`;
  }
}

/** GitHub Actions workflow commands: one annotation per finding, plus a step summary in Markdown. */
export function renderCheckGithub(r: CheckResult): { annotations: string[]; summary: string } {
  const annotations = r.findings
    .filter((f) => f.kind !== "rerun-skipped")
    .map((f) => `::error title=Graft check::${describeFinding(f).split("\n")[0].replace(/\r?\n/g, " ")}`);
  const rows = r.commits.map(
    (c) =>
      `| ${c.ok ? "✅" : "❌"} | \`${c.entry.commit.slice(0, 10)}\` | ${escapePipes(c.entry.title)} | ${c.triage.risk} | ${c.entry.record ? passingCommands(c.entry).length : 0} | ${c.triage.groups.behavior.length} |`,
  );
  const summary = [
    `### Graft check: ${r.ok ? "pass" : "fail"}`,
    "",
    `${r.commits.length} commit(s) in \`${r.base}..${r.head.slice(0, 10)}\`, policy \`requireEvidence: ${JSON.stringify(r.policy.requireEvidence)}\`.`,
    "",
    "| | Commit | Title | Risk | Passing commands | Behavior files |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    ...(r.reruns.length
      ? ["", "#### Re-run on this checkout", "", "| | Command | Recorded on |", "| --- | --- | --- |", ...r.reruns.map((x) => `| ${x.exitCode === 0 ? "✅" : `❌ exit ${x.exitCode}`} | \`${escapePipes(x.command)}\` | ${x.commits.map((s) => `\`${s.slice(0, 10)}\``).join(", ")} |`)]
      : []),
    ...(r.findings.length ? ["", "#### Findings", "", ...r.findings.map((f) => `- ${describeFinding(f).split("\n")[0]}`)] : []),
    "",
  ].join("\n");
  return { annotations, summary };
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
