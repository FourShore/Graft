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
  /** Where the task came from: the thread, issue or ticket that asked for it, as a URL or id. */
  ref?: string;
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
  /**
   * Set when a capture hook opened the change from the harness's own event
   * (the prompt, or a recorded run with nothing open) rather than an explicit
   * `graft start`. A later `graft start` adopts such a change, naming the
   * task and keeping the evidence, instead of refusing.
   */
  capturedBy?: string;
  /**
   * Changes abandoned in this worktree since the last land, folded into the
   * change that did land: the plans that did not work and why, kept so the
   * next reader does not rediscover them. Written as the `Tried:` block.
   */
  attempts?: Attempt[];
  /** The change id or commit this change undoes, when it was opened by `graft revert`. Written as `Graft-Reverts`. */
  reverts?: string;
}

/** A change that was abandoned rather than landed. */
export interface Attempt {
  id: string;
  task: string;
  plan?: string;
  /** Why it was abandoned, from `graft abandon --reason`. */
  reason?: string;
  ref?: string;
  startedAt: string;
  abandonedAt: string;
  evidence: Evidence[];
  /** The one line a commit message keeps per attempt; set on a record rebuilt from the message, where nothing else survives. */
  summary?: string;
  /** The evidence summary from that line, since the rebuilt attempt has no evidence entries. */
  evidenceSummary?: string;
}

export interface ChangeAuthor {
  /** "agent" or "human". */
  kind: "agent" | "human";
  /** e.g. "claude-code", "cursor", or a person's handle. */
  name: string;
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
  /** Optional label, e.g. "unit tests". Kept in the note; the message line carries `name` when there is one. */
  label?: string;
  /** The policy catalog name this run satisfies, when it was run or matched by name. */
  name?: string;
  /**
   * Set when a harness reported the run through a hook ("claude-code")
   * instead of Graft running it. The exit code and output are the harness's
   * own, so this is still a pass or a fail, not a claim.
   */
  via?: string;
  /**
   * True when the author attached a run they made themselves instead of
   * letting Graft run the command. The exit code and output are their claim;
   * readers show it as "attested", not "pass".
   */
  attested?: true;
  /**
   * Hash of the working tree (tracked and untracked files, ignored ones left
   * out) when the run finished, so land can tell whether the files being
   * committed are the ones the run checked. Absent when git could not say.
   */
  tree?: string;
  /**
   * Set at land when a passing run's `tree` differs, for a file a policy rule
   * covers, from what was committed: the run happened before the last edit.
   * A stale run does not satisfy a rule; the message line says `stale`.
   */
  stale?: true;
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
  ref: "Graft-Task-Ref",
  reverts: "Graft-Reverts",
  author: "Graft-Author",
  evidence: "Graft-Evidence",
} as const;

export function trailersFor(record: ChangeRecord): Array<[string, string]> {
  const t: Array<[string, string]> = [
    [TRAILER_KEYS.change, record.id],
    [TRAILER_KEYS.task, oneLine(record.task)],
  ];
  if (record.ref) t.push([TRAILER_KEYS.ref, oneLine(record.ref)]);
  if (record.reverts) t.push([TRAILER_KEYS.reverts, record.reverts]);
  t.push([TRAILER_KEYS.author, `${record.author.kind}:${record.author.name}`]);
  t.push([TRAILER_KEYS.evidence, evidenceSummary(record.evidence)]);
  return t;
}

export function parseTrailers(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const m = /^(Graft-[A-Za-z-]+):\s*(.*)$/.exec(line);
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
/** Header of the abandoned-attempts section written into the commit message body. */
export const TRIED_HEADER = "Tried:";
const MESSAGE_LINE_CAP = 200;

/**
 * The evidence list as commit-message lines: one per entry, so the record
 * travels with the commit even when the note does not. Output stays in the
 * note; the message carries the command, its exit code and duration. The
 * status and the optional label share the bracket, so a command or note that
 * contains ": " is never mistaken for a label.
 *
 *   [pass unit tests] npm test (12.3s)
 *   [stale test] npm test (12.3s)
 *   [fail 1] npm run lint (0.4s)
 *   [attested go tests] go test ./...
 *   [attested fail 2 build] yarn build
 *   [note] manually verified in browser
 */
export function evidenceLines(evidence: Evidence[]): string[] {
  return evidence.map((ev) => {
    // A catalog name is the run's identity, so it is what the message keeps; a free label rides in the note.
    const shown = ev.kind === "command" && ev.name ? ev.name : ev.label;
    const label = shown ? ` ${bracketSafe(shown)}` : "";
    if (ev.kind === "note") return `  [note${label}] ${clip(oneLine(ev.text))}`;
    const failed = ev.exitCode === 0 ? "" : ` fail ${ev.exitCode}`;
    if (ev.attested) return `  [attested${failed}${label}] ${clip(oneLine(ev.command))}`;
    const status = ev.exitCode !== 0 ? `fail ${ev.exitCode}` : ev.stale ? "stale" : "pass";
    return `  [${status}${label}] ${clip(oneLine(ev.command))} (${(ev.durationMs / 1000).toFixed(1)}s)`;
  });
}

/**
 * Abandoned attempts as commit-message lines, one per attempt: the id, then
 * the task with the reason it was abandoned (or its plan when no reason was
 * given), then the evidence summary in parentheses.
 *
 *   [m4z1gs7jgdyp3pj2za9c] Add rate limiting: tried a global bucket; 429s were not deterministic (2 commands, 1 passed)
 */
export function attemptLines(attempts: Attempt[]): string[] {
  return attempts.map((a) => `  [${a.id}] ${clip(oneLine(attemptText(a)))} (${a.evidence.length ? evidenceSummary(a.evidence) : a.evidenceSummary ?? "none"})`);
}

function attemptText(a: Attempt): string {
  if (a.summary) return a.summary;
  const why = a.reason ?? a.plan;
  return why ? `${a.task}: ${why}` : a.task;
}

const ATTEMPT_LINE = /^\s*\[([0-9a-hjkmnp-tv-z]{20})\] (.*) \(([^()]*)\)$/;

/** A label on one line with no brackets, so the bracket that holds it still closes where it should. */
function bracketSafe(label: string): string {
  return oneLine(label).replace(/[[\]]/g, "").slice(0, 60);
}

const EVIDENCE_LINE = /^\s*\[(pass|stale|fail (-?\d+)|note|attested(?: fail (-?\d+))?)(?: ([^\]]*))?\] (.*)$/;
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
    const [, status, failCode, attestedFailCode, rawLabel, tail] = m;
    const label = rawLabel || undefined;
    if (status === "note") {
      evidence.push({ kind: "note", at: authoredAt, text: tail, label });
      continue;
    }
    if (status.startsWith("attested")) {
      const exitCode = attestedFailCode ? Number(attestedFailCode) : 0;
      evidence.push({ kind: "command", at: authoredAt, command: tail, exitCode, durationMs: 0, output: "", label, attested: true });
      continue;
    }
    let rest = tail;
    let durationMs = 0;
    const d = DURATION.exec(rest);
    if (d) {
      rest = d[1];
      durationMs = Math.round(Number(d[2]) * 1000);
    }
    evidence.push({
      kind: "command",
      at: authoredAt,
      command: rest,
      exitCode: failCode ? Number(failCode) : 0,
      durationMs,
      output: "",
      label,
      ...(status === "stale" ? { stale: true as const } : {}),
    });
  }
  const attempts: Attempt[] = [];
  for (const line of readBlock(lines, TRIED_HEADER)?.split("\n") ?? []) {
    const m = ATTEMPT_LINE.exec(line);
    if (!m) continue;
    attempts.push({ id: m[1], task: m[2], summary: m[2], evidenceSummary: m[3], startedAt: authoredAt, abandonedAt: authoredAt, evidence: [] });
  }
  const [kind, ...name] = (trailers[TRAILER_KEYS.author] ?? "human:unknown").split(":");
  return {
    version: 1,
    id,
    task: trailers[TRAILER_KEYS.task] ?? lines[0],
    ref: trailers[TRAILER_KEYS.ref] || undefined,
    reverts: trailers[TRAILER_KEYS.reverts] || undefined,
    plan: plan || undefined,
    author: {
      kind: kind === "agent" ? "agent" : "human",
      name: name.join(":") || "unknown",
    },
    startedAt: authoredAt,
    landedAt: authoredAt,
    evidence,
    ...(attempts.length ? { attempts } : {}),
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
const WIN_SAFE_ARG = /^[A-Za-z0-9_@+=:,./\\-]+$/;
const WIN_META = /[()%!^"<>&|]/g;

/**
 * Turn an argv into one shell command string for the platform's shell.
 * Every element is quoted unless it is plainly safe, so
 * `node -e 'console.log("a b")'` survives the trip through /bin/sh, or
 * through cmd.exe on Windows, where the quoting follows the rules the C
 * runtime uses to split a command line and cmd's own metacharacters are
 * escaped with `^`. A single element is returned as written, so
 * `graft evidence -- "npm test && npm run lint"` still runs through the shell.
 * A redirect or pipe given as its own element is therefore a literal argument.
 */
export function shellJoin(argv: string[], platform: NodeJS.Platform = process.platform): string {
  if (argv.length === 1) return argv[0];
  const quote = platform === "win32" ? winQuote : posixQuote;
  return argv.map(quote).join(" ");
}

function posixQuote(a: string): string {
  return SAFE_ARG.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

function winQuote(a: string): string {
  if (WIN_SAFE_ARG.test(a)) return a;
  // Backslashes only escape when they precede a quote, so double those runs
  // and the trailing run, then escape quotes, then wrap in double quotes.
  const inner = a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  // cmd.exe reads the line before the program does; `^` makes it pass the
  // metacharacters, including the quotes, through untouched.
  return `"${inner}"`.replace(WIN_META, "^$&");
}
