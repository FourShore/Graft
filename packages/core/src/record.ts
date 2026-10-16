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

/** Header of the evidence section written into the commit message body. */
export const EVIDENCE_HEADER = "Evidence:";
const MESSAGE_LINE_CAP = 200;

/**
 * The evidence list as commit-message lines: one per entry, so the record
 * travels with the commit even when the note does not. Output stays in the
 * note; the message carries the command, its exit code and duration. The
 * status and the optional label share the bracket, so a command or note that
 * contains ": " is never mistaken for a label.
 *
 *   [pass unit tests] npm test (12.3s)
 *   [fail 1] npm run lint (0.4s)
 *   [note] manually verified in browser
 */
export function evidenceLines(evidence: Evidence[]): string[] {
  return evidence.map((ev) => {
    const label = ev.label ? ` ${bracketSafe(ev.label)}` : "";
    if (ev.kind === "note") return `  [note${label}] ${clip(oneLine(ev.text))}`;
    const status = ev.exitCode === 0 ? "pass" : `fail ${ev.exitCode}`;
    return `  [${status}${label}] ${clip(oneLine(ev.command))} (${(ev.durationMs / 1000).toFixed(1)}s)`;
  });
}

/** A label on one line with no brackets, so the bracket that holds it still closes where it should. */
function bracketSafe(label: string): string {
  return oneLine(label).replace(/[[\]]/g, "").slice(0, 60);
}

const EVIDENCE_LINE = /^\s*\[(pass|fail (-?\d+)|note)(?: ([^\]]*))?\] (.*)$/;
const DURATION = /^(.*) \((\d+(?:\.\d+)?)s\)$/;

/**
 * Rebuild a record from a commit message alone: trailers, the Plan: block and
 * the Evidence: block. Used when the note is missing. Command output is not in
 * the message, so `output` is empty; timestamps fall back to `authoredAt`.
 * Returns null when the message carries no Graft-Change trailer.
 */
export function parseMessageRecord(message: string, authoredAt: string): ChangeRecord | null {
  const trailers = parseTrailers(message);
  const id = trailers[TRAILER_KEYS.change];
  if (!id) return null;
  const lines = message.split("\n");
  const plan = readBlock(lines, "Plan:");
  const evidence: Evidence[] = [];
  for (const line of readBlock(lines, EVIDENCE_HEADER)?.split("\n") ?? []) {
    const m = EVIDENCE_LINE.exec(line);
    if (!m) continue;
    const label = m[3] || undefined;
    let rest = m[4];
    let durationMs = 0;
    if (m[1] !== "note") {
      const d = DURATION.exec(rest);
      if (d) {
        rest = d[1];
        durationMs = Math.round(Number(d[2]) * 1000);
      }
    }
    if (m[1] === "note") evidence.push({ kind: "note", at: authoredAt, text: rest, label });
    else evidence.push({ kind: "command", at: authoredAt, command: rest, exitCode: m[2] ? Number(m[2]) : 0, durationMs, output: "", label });
  }
  const [kind, ...name] = (trailers[TRAILER_KEYS.author] ?? "human:unknown").split(":");
  return {
    version: 1,
    id,
    task: trailers[TRAILER_KEYS.task] ?? lines[0],
    plan: plan || undefined,
    author: {
      kind: kind === "agent" ? "agent" : "human",
      name: name.join(":") || "unknown",
      model: trailers[TRAILER_KEYS.model] || undefined,
    },
    startedAt: authoredAt,
    landedAt: authoredAt,
    evidence,
  };
}

/**
 * The indented lines that follow `header` on its own line. Blank lines are
 * kept while the next non-blank line is still indented, so a multi-paragraph
 * plan survives; the block ends at the first unindented line.
 */
function readBlock(lines: string[], header: string): string | null {
  const start = lines.indexOf(header);
  if (start < 0) return null;
  const body: string[] = [];
  const rest = lines.slice(start + 1);
  for (let i = 0; i < rest.length; i++) {
    const line = rest[i];
    if (!line.trim()) {
      const next = rest.slice(i + 1).find((l) => l.trim());
      if (!next || !next.startsWith("  ")) break;
      body.push("");
      continue;
    }
    if (!line.startsWith("  ")) break;
    body.push(line.slice(2));
  }
  return body.join("\n");
}

function clip(s: string): string {
  return s.length > MESSAGE_LINE_CAP ? s.slice(0, MESSAGE_LINE_CAP - 1) + "…" : s;
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Turn an argv into one POSIX shell command string. Every element is quoted
 * unless it is plainly safe, so `node -e 'console.log("a b")'` survives the
 * trip through /bin/sh. A single element is returned as written, so
 * `graft evidence -- "npm test && npm run lint"` still runs through the shell.
 */
export function shellJoin(argv: string[]): string {
  if (argv.length === 1) return argv[0];
  return argv.map((a) => (SAFE_ARG.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
