import { Graft, readPolicy, type LogEntry } from "@fourshore/graft-core";
import { parseDiff } from "./diff.js";
import { RISK_ORDER, triage, type Triage } from "./triage.js";

export { parseDiff, unquote } from "./diff.js";
export type { DiffFile, DiffHunk, DiffLine } from "./diff.js";
export { groupFile, judgeEvidence, triage, RISK_ORDER } from "./triage.js";
export type { EvidenceVerdict, FileGroup, Risk, Triage } from "./triage.js";
export { runCheck, renderCheckText, renderCheckGithub, describeFinding, escapeGithubData, escapeGithubProperty } from "./check.js";
export type { CheckOptions, CheckResult, CheckedCommit, Finding, Rerun } from "./check.js";

export interface ReviewOptions {
  /** Repository to review. Defaults to the current directory. */
  repo?: string;
  /** How many commits the queue shows. */
  limit?: number;
  /** Include commits without a Graft record. Default true, so unrecorded work is visible. */
  includeUnrecorded?: boolean;
}

export interface ReviewedChange {
  entry: LogEntry;
  triage: Triage;
}

/** Changes triaged by risk: the engine behind `graft check`, usable from code. */
export class Review {
  readonly graft: Graft;
  constructor(private readonly opts: ReviewOptions = {}) {
    this.graft = new Graft(opts.repo ?? process.cwd());
  }

  async repoName(): Promise<string> {
    return this.graft.git.topLevel();
  }

  async queue(): Promise<ReviewedChange[]> {
    const entries = await this.graft.log({
      limit: this.opts.limit ?? 50,
      onlyGraft: this.opts.includeUnrecorded === false,
    });
    const items = await Promise.all(entries.map((e) => this.triageEntry(e)));
    return items.sort(
      (a, b) =>
        RISK_ORDER.indexOf(a.triage.risk) - RISK_ORDER.indexOf(b.triage.risk) ||
        Date.parse(b.entry.authoredAt) - Date.parse(a.entry.authoredAt),
    );
  }

  async change(ref: string): Promise<ReviewedChange | null> {
    const entry = await this.graft.show(ref);
    return entry ? this.triageEntry(entry) : null;
  }

  private async triageEntry(entry: LogEntry): Promise<ReviewedChange> {
    const files = parseDiff(await this.graft.diff(entry.commit));
    const policy = await readPolicy(await this.graft.git.topLevel());
    return { entry, triage: triage(entry.record, files, entry.trailers, entry.recordSource, policy.behaviorFiles) };
  }
}
