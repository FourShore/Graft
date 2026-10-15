import { randomBytes } from "node:crypto";

/**
 * A change record: everything git never stored about why a change exists.
 * See docs/CHANGE.md for the spec and the on-disk encoding.
 */
export interface ChangeRecord {
  /** Schema version of this record. */
  version: 1;
  /** Stable identifier, survives rebases and amends. */
  id: string;
  /** What the author was asked to do, in their own words. */
  task: string;
  /** How they intended to do it. Optional while a change is open. */
  plan?: string;
  /** Who did the work. */
  author: ChangeAuthor;
  /** ISO 8601 timestamps. */
  startedAt: string;
  landedAt?: string;
  /** Evidence collected while the change was open. */
  evidence: Evidence[];
  /**
   * Commit SHA this record was first landed on. Informational: the note follows
   * the commit through amend and rebase, so after a rewrite this names the
   * original SHA, not the one the note is now attached to.
   */
  commit?: string;
}

export interface ChangeAuthor {
  /** "agent" or "human". */
  kind: "agent" | "human";
  /** e.g. "claude-code", "cursor", or a person's handle. */
  name: string;
  /** Model identifier when the author is an agent. */
  model?: string;
}

export type Evidence = CommandEvidence | NoteEvidence;

export interface CommandEvidence {
  kind: "command";
  at: string;
  /** The command as run. */
  command: string;
  exitCode: number;
  durationMs: number;
  /** Trimmed tail of combined stdout/stderr, capped at EVIDENCE_OUTPUT_CAP bytes. */
  output: string;
  /** Optional label, e.g. "unit tests". */
  label?: string;
}

export interface NoteEvidence {
  kind: "note";
  at: string;
  /** Free-form evidence a tool or person recorded, e.g. "manually verified in browser". */
  text: string;
  label?: string;
}

export const EVIDENCE_OUTPUT_CAP = 4096;

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase

/** 20-char sortable id: 8 chars of timestamp + 12 chars of randomness. */
export function newChangeId(now = Date.now()): string {
  let t = now;
  let ts = "";
  for (let i = 0; i < 8; i++) {
    ts = ID_ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(12);
  let rand = "";
  for (let i = 0; i < 12; i++) rand += ID_ALPHABET[bytes[i] % 32];
  return ts + rand;
}

export function isChangeId(s: string): boolean {
  return /^[0-9a-hjkmnp-tv-z]{20}$/.test(s);
}

export function evidenceSummary(evidence: Evidence[]): string {
  const cmds = evidence.filter((e): e is CommandEvidence => e.kind === "command");
  const notes = evidence.length - cmds.length;
  const passed = cmds.filter((c) => c.exitCode === 0).length;
  const parts: string[] = [];
  if (cmds.length) parts.push(`${cmds.length} command${cmds.length === 1 ? "" : "s"}, ${passed} passed`);
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  return parts.length ? parts.join("; ") : "none";
}

/** Git trailers written into the commit message. Keys are stable; see CHANGE.md. */
export const TRAILER_KEYS = {
  change: "Graft-Change",
  task: "Graft-Task",
  author: "Graft-Author",
  model: "Graft-Model",
  evidence: "Graft-Evidence",
} as const;

export function trailersFor(record: ChangeRecord): Array<[string, string]> {
  const t: Array<[string, string]> = [
    [TRAILER_KEYS.change, record.id],
    [TRAILER_KEYS.task, oneLine(record.task)],
    [TRAILER_KEYS.author, `${record.author.kind}:${record.author.name}`],
  ];
  if (record.author.model) t.push([TRAILER_KEYS.model, record.author.model]);
  t.push([TRAILER_KEYS.evidence, evidenceSummary(record.evidence)]);
  return t;
}

export function parseTrailers(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const m = /^(Graft-[A-Za-z]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The notes ref where full records live. */
export const NOTES_REF = "refs/notes/graft";
