import type { LogEntry } from "./graft.js";
import { evidenceLines, evidenceSummary } from "./record.js";

/** One commit that touched the requested paths. */
export interface ContextEntry extends LogEntry {
  /** The files this commit touched, repository-relative, limited to the requested paths. */
  files: string[];
}

export interface ContextOptions {
  /** How many commits touching the paths to scan, newest first. Default 50. */
  limit?: number;
  /** Characters of rendered text to stay within. Default 8000. */
  budget?: number;
  /** Include commits that have no change record, as one line each. Default false. */
  all?: boolean;
}

export interface ContextResult {
  /** The paths as given. */
  paths: string[];
  /** Commits that fit the budget, newest first. */
  entries: ContextEntry[];
  /** Matching commits cut to fit the budget. */
  omitted: number;
  /** Commits that touched the paths but carry no change record (counted even when not included). */
  unrecorded: number;
  /** The entries rendered as prompt-ready text, within the budget. */
  text: string;
}

export const DEFAULT_CONTEXT_LIMIT = 50;
export const DEFAULT_CONTEXT_BUDGET = 8000;

/**
 * Pick the newest entries that fit the budget and render them. Each entry is
 * tried in full (task, plan, evidence, files), then without its plan and with
 * evidence summarised, before it is dropped; everything older is dropped with
 * it, so the reader always gets the most recent history first.
 */
export function fitContext(
  paths: string[],
  matched: ContextEntry[],
  unrecorded: number,
  budget: number,
): ContextResult {
  const recorded = matched.filter((e) => e.record).length;
  const header = contextHeader(paths, recorded, unrecorded);
  const blocks: string[] = [];
  const entries: ContextEntry[] = [];
  let used = header.length;
  let omitted = 0;
  for (let i = 0; i < matched.length; i++) {
    const e = matched[i];
    const remaining = matched.length - i;
    const footer = (n: number) => (n ? `\n\n${footerLine(n)}` : "");
    const tryFit = (block: string) => {
      const cost = block.length + 2 + footer(remaining - 1).length;
      if (used + cost > budget) return false;
      blocks.push(block);
      entries.push(e);
      used += block.length + 2;
      return true;
    };
    if (tryFit(renderContextEntry(e, true)) || tryFit(renderContextEntry(e, false))) continue;
    omitted = remaining;
    break;
  }
  const parts = [header, ...blocks];
  if (omitted) parts.push(footerLine(omitted));
  return { paths, entries, omitted, unrecorded, text: parts.join("\n\n") };
}

function contextHeader(paths: string[], recorded: number, unrecorded: number): string {
  const what = paths.length ? paths.join(", ") : "the repository";
  const n = `${recorded} recorded change${recorded === 1 ? "" : "s"}`;
  const extra = unrecorded ? `; ${unrecorded} commit${unrecorded === 1 ? "" : "s"} without a record` : "";
  return `Context for ${what} (${n}, newest first${extra})`;
}

function footerLine(n: number): string {
  return `(${n} older commit${n === 1 ? "" : "s"} omitted to fit the budget; raise --budget or name fewer paths)`;
}

/** One commit as a block of text. `full` keeps the plan and every evidence line. */
export function renderContextEntry(e: ContextEntry, full: boolean): string {
  const who = e.record ? `${e.record.author.kind}:${e.record.author.name}` : e.authorName;
  const head = `${e.commit.slice(0, 10)}  ${e.authoredAt.slice(0, 10)}  ${who}  ${e.title}`;
  if (!e.record) return `${head}\n  (no change record)`;
  const r = e.record;
  const lines = [head, `  task: ${indentRest(r.task, 8)}`];
  if (full && r.plan) lines.push(`  plan: ${indentRest(r.plan, 8)}`);
  if (full && r.evidence.length) {
    lines.push(`  evidence: ${evidenceLines(r.evidence).map((l) => l.trim()).join("\n            ")}`);
  } else {
    lines.push(`  evidence: ${evidenceSummary(r.evidence)}`);
  }
  if (e.files.length) lines.push(`  files: ${e.files.join(", ")}`);
  if (e.recordSource === "message") lines.push(`  (note missing; rebuilt from the commit message)`);
  return lines.join("\n");
}

function indentRest(s: string, width: number): string {
  return s.trim().split("\n").join("\n" + " ".repeat(width));
}
