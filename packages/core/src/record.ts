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
  /** The harness session that opened the change, when a capture hook did; runs from other sessions are not recorded on it. */
  sessionId?: string;
  /**
   * Set when a capture hook opened the change from a run with no task to
   * give it, so `task` is a placeholder naming the session. Cleared by the
   * `graft start` that names it; under policy `task: "named"` the gate
   * refuses to land while it is set.
   */
  taskPlaceholder?: boolean;
  /**
   * Changes abandoned in this worktree since the last land, folded into the
   * change that did land: the plans that did not work and why, kept so the
   * next reader does not rediscover them. Written as the `Tried:` block.
   */
  attempts?: Attempt[];
  /** The change id or commit this change undoes, when it was opened by `graft revert`. Written as `Graft-Reverts`. */
  reverts?: string;
  /**
   * Files this change produced, by content hash, so a binary found in the
   * field resolves to its task, plan and evidence. One `Graft-Artifact`
   * trailer each.
   */
  artifacts?: Artifact[];
  /**
   * The gate checks a caller overrode to land this change (`--allow-no-evidence`,
   * `--allow-secrets` or their environment variables), set only when the
   * gate would otherwise have refused. One `Graft-Override` trailer each, so
   * a bypass is visible where the commit is read.
   */
  overrides?: Override[];
}

/** A landing-gate check a caller can override. */
export type Override = "no-evidence" | "secrets";
export const OVERRIDES: readonly Override[] = ["no-evidence", "secrets"];

export interface Artifact {
  /** A file name, as a reader would see it: `nova.exe`, `app-1.4.2.tar.gz`. */
  name: string;
  /** Lower-case hex SHA-256 of the file's content. */
  sha256: string;
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
  /** The model an agent ran on, when the harness or GRAFT_AUTHOR_MODEL says. Written as `Graft-Model`. */
  model?: string;
}

export type Evidence = CommandEvidence | NoteEvidence | ReviewEvidence;

/** One thing a reviewer found. */
export interface ReviewFinding {
  /** blocker: must change before landing; warning: should; nit: may. Only blockers make the verdict request-changes. */
  severity: "blocker" | "warning" | "nit";
  /** Path relative to the repo root, when the finding is about one file. */
  file?: string;
  line?: number;
  text: string;
}

/**
 * An independent review of the change by a model, under instructions the
 * record identifies by hash: the one kind of evidence that is not the
 * author's own run. `graft evidence <name>` records one for a review the
 * policy names; `graft check --rerun` runs it again on each commit.
 */
export interface ReviewEvidence {
  kind: "review";
  at: string;
  /** The policy's review name this satisfies (`reviews` in the policy). */
  name?: string;
  /** Optional label, as for a command. A record rebuilt from a message keeps the name here. */
  label?: string;
  /** The model that reviewed, as the API or the reviewer command reported it. */
  model: string;
  verdict: "approve" | "request-changes";
  /** One or two sentences from the reviewer. */
  summary: string;
  findings: ReviewFinding[];
  /** SHA-256 of the instructions the reviewer was given, so a record says which prompt judged it. */
  promptSha256: string;
  /** SHA-256 of the diff that was reviewed. */
  diffSha256: string;
  durationMs: number;
  /** The working-tree hash the review looked at, as for a command; land compares it with what is committed. */
  tree?: string;
  /** Set at land when the reviewed tree differs from what is committed in a file a rule covers. */
  stale?: true;
}

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
  const reviews = evidence.filter((e): e is ReviewEvidence => e.kind === "review");
  const notes = evidence.length - cmds.length - reviews.length;
  const stale = cmds.filter((c) => c.stale).length;
  const passed = cmds.filter((c) => c.exitCode === 0 && !c.stale).length;
  const parts: string[] = [];
  if (cmds.length) parts.push(`${cmds.length} command${cmds.length === 1 ? "" : "s"}, ${passed} passed${stale ? `, ${stale} stale` : ""}`);
  if (reviews.length) {
    const approved = reviews.filter((r) => r.verdict === "approve" && !r.stale).length;
    parts.push(`${reviews.length} review${reviews.length === 1 ? "" : "s"}, ${approved} approved`);
  }
  if (notes) parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  return parts.length ? parts.join("; ") : "none";
}

/** Git trailers written into the commit message. Keys are stable; see CHANGE.md. */
export const TRAILER_KEYS = {
  change: "Graft-Change",
  task: "Graft-Task",
  ref: "Graft-Task-Ref",
  reverts: "Graft-Reverts",
  artifact: "Graft-Artifact",
  author: "Graft-Author",
  model: "Graft-Model",
  override: "Graft-Override",
  evidence: "Graft-Evidence",
} as const;

export function trailersFor(record: ChangeRecord): Array<[string, string]> {
  const t: Array<[string, string]> = [
    [TRAILER_KEYS.change, record.id],
    [TRAILER_KEYS.task, oneLine(record.task)],
  ];
  if (record.ref) t.push([TRAILER_KEYS.ref, oneLine(record.ref)]);
  if (record.reverts) t.push([TRAILER_KEYS.reverts, record.reverts]);
  for (const a of record.artifacts ?? []) t.push([TRAILER_KEYS.artifact, `sha256:${a.sha256} ${oneLine(a.name)}`]);
  t.push([TRAILER_KEYS.author, `${record.author.kind}:${record.author.name}`]);
  if (record.author.model) t.push([TRAILER_KEYS.model, oneLine(record.author.model)]);
  for (const o of record.overrides ?? []) t.push([TRAILER_KEYS.override, o]);
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

const ARTIFACT_TRAILER = /^Graft-Artifact:\s*sha256:([0-9a-f]{64})\s+(.+?)\s*$/;

/** Every `Graft-Artifact` trailer in a message; `parseTrailers` keeps one value per key, and a change may produce several files. */
export function parseArtifactTrailers(message: string): Artifact[] {
  const out: Artifact[] = [];
  for (const line of message.split("\n")) {
    const m = ARTIFACT_TRAILER.exec(line);
    if (m) out.push({ sha256: m[1], name: m[2] });
  }
  return out;
}

export function isSha256(s: string): boolean {
  return /^(sha256:)?[0-9a-f]{64}$/i.test(s);
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
 * The evidence list as commit-message lines: one per command, so the record
 * travels with the commit even when the note does not. Output stays in the
 * note; the message carries the command, its exit code and duration. The
 * status and the optional label share the bracket, so a command or note that
 * contains ": " is never mistaken for a label.
 *
 *   [pass unit tests] npm test (12.3s)
 *   [stale test] npm test (12.3s)
 *   [fail 1] npm run lint (0.4s)
 *   [pass lint] npm run lint (3.0s; earlier: 2 runs, 1 failed)
 *   [attested go tests] go test ./...
 *   [attested fail 2 build] yarn build
 *   [note] manually verified in browser
 *   [review approve code] claude-opus-5-5 (prompt 4f3a2b1c; 0 findings)
 *   [review request-changes code] claude-opus-5-5 (prompt 4f3a2b1c; 2 findings)
 *
 * A review line names the model, the first 8 hex digits of the hash of the
 * instructions it reviewed under, and how many findings it made; the note
 * keeps the findings themselves. A stale review reads `[review stale code]`.
 *
 * Repeated runs of one command (by catalog name, else by its label and text) keep only
 * the last, with a count of the earlier ones; the note keeps every run. When
 * the last run did not pass, the latest passing run stays too, so a reader of
 * the message alone reaches the same verdict on the policy as one with the note.
 */
export function evidenceLines(evidence: Evidence[]): string[] {
  const keep = collapseRuns(evidence);
  return evidence.flatMap((ev, i) => {
    const earlier = keep.get(i);
    if (earlier === undefined) return [];
    // A catalog name is the run's identity, so it is what the message keeps; a free label rides in the note.
    const shown = ev.kind !== "note" && ev.name ? ev.name : ev.label;
    const label = shown ? ` ${bracketSafe(shown)}` : "";
    if (ev.kind === "note") return [`  [note${label}] ${clip(oneLine(ev.text))}`];
    if (ev.kind === "review") {
      const status = ev.stale ? "stale" : ev.verdict;
      return [`  [review ${status}${label}] ${oneLine(ev.model)} (prompt ${ev.promptSha256.slice(0, 8)}; ${ev.findings.length} finding${ev.findings.length === 1 ? "" : "s"})`];
    }
    const failed = ev.exitCode === 0 ? "" : ` fail ${ev.exitCode}`;
    if (ev.attested) return [`  [attested${failed}${label}] ${clip(oneLine(ev.command))}`];
    const status = ev.exitCode !== 0 ? `fail ${ev.exitCode}` : ev.stale ? "stale" : "pass";
    const more = earlier.runs ? `; earlier: ${earlier.runs} run${earlier.runs === 1 ? "" : "s"}${earlier.failed ? `, ${earlier.failed} failed` : ""}` : "";
    return [`  [${status}${label}] ${clip(oneLine(ev.command))} (${(ev.durationMs / 1000).toFixed(1)}s${more})`];
  });
}

/**
 * Which evidence entries the message shows, by index, each with the runs it
 * stands for that are not shown. Notes and attested runs are always shown;
 * repeated Graft or harness runs of one command (same catalog name, or same
 * label and text) collapse to the last, plus
 * the latest passing one when the last did not pass.
 */
function collapseRuns(evidence: Evidence[]): Map<number, { runs: number; failed: number }> {
  const groups = new Map<string, number[]>();
  const keep = new Map<number, { runs: number; failed: number }>();
  evidence.forEach((ev, i) => {
    if (ev.kind !== "command" || ev.attested) {
      // Reviews are never collapsed: each is a separate judgement, and the policy reads the last one.
      keep.set(i, { runs: 0, failed: 0 });
      return;
    }
    // Without a catalog name the label is part of the identity: a rule can be met by a run labelled with its name.
    const key = ev.name ? `name:${ev.name}` : `command:${ev.label ?? ""}\u0000${oneLine(ev.command)}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const idx of groups.values()) {
    const last = idx[idx.length - 1];
    const lastRun = evidence[last] as CommandEvidence;
    const shown = [last];
    if (lastRun.exitCode !== 0 || lastRun.stale) {
      const pass = [...idx].reverse().find((i) => {
        const r = evidence[i] as CommandEvidence;
        return r.exitCode === 0 && !r.stale;
      });
      if (pass !== undefined) shown.unshift(pass);
    }
    const hidden = idx.filter((i) => !shown.includes(i));
    for (const i of shown) keep.set(i, { runs: 0, failed: 0 });
    keep.set(last, { runs: hidden.length, failed: hidden.filter((i) => (evidence[i] as CommandEvidence).exitCode !== 0).length });
  }
  return keep;
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
const REVIEW_LINE = /^\s*\[review (approve|request-changes|stale)(?: ([^\]]*))?\] (\S+) \(prompt ([0-9a-f]{8,64}); (\d+) findings?\)$/;
const DURATION = /^(.*) \((\d+(?:\.\d+)?)s(?:; earlier: \d+ runs?(?:, \d+ failed)?)?\)$/;
/** A bracket that carries a label, which only the current format writes. */
const LABELLED_BRACKET = /^\s*\[(?:pass|stale|fail -?\d+|note|attested(?: fail -?\d+)?|review \S+) [^\]]+\] /;
/**
 * The 0.0.6 `label: command` split, taken only when the label reads like one
 * (plain words) and what follows reads like a command rather than the rest of
 * a sentence: more than one word, or a path. `echo status: ok` stays whole.
 */
const LEGACY_LABEL = /^([A-Za-z0-9][A-Za-z0-9 _-]{0,59}): (\S+(?:[ /.]\S*)+)$/;

/**
 * Rebuild a record from a commit message alone: trailers, the Plan: block and
 * the Evidence: block. Used when the note is missing. Command output is not in
 * the message, so `output` is empty; timestamps fall back to `authoredAt`.
 * Returns null when the message carries no Graft-Change trailer.
 */
export function parseMessageRecord(message: string, authoredAt: string): ChangeRecord | null {
  const lines = message.split("\n");
  const found = recordBlockOf(lines);
  if (!found) return null;
  // Only the record Graft wrote: its own trailer paragraph and the blocks just
  // above it, so a task that mentions "Evidence:" or a squash of several
  // landed commits reads as the one record the chosen Graft-Change belongs to.
  const trailerText = found.trailers.join("\n");
  const trailers = parseTrailers(trailerText);
  const id = trailers[TRAILER_KEYS.change];
  if (!id) return null;
  const plan = found.blocks.get("Plan:") ?? null;
  const evidence: Evidence[] = [];
  const evidenceBlock = found.blocks.get(EVIDENCE_HEADER)?.split("\n") ?? [];
  // Graft 0.0.6 wrote the label outside the bracket, as `[pass] label: command`.
  // Such a block never has a label inside a bracket, which is how it is told apart.
  const legacy = evidenceBlock.every((l) => !LABELLED_BRACKET.test(l));
  for (const line of evidenceBlock) {
    const review = REVIEW_LINE.exec(line);
    if (review) {
      const [, status, name, model, prompt, count] = review;
      // The message keeps the count and the verdict; the findings themselves are in the note.
      evidence.push({
        kind: "review",
        at: authoredAt,
        ...(name ? { label: name } : {}),
        model,
        verdict: status === "request-changes" ? "request-changes" : "approve",
        summary: "",
        findings: Array.from({ length: Number(count) }, () => ({ severity: "warning" as const, text: "(in the git note)" })),
        promptSha256: prompt,
        diffSha256: "",
        durationMs: 0,
        ...(status === "stale" ? { stale: true as const } : {}),
      });
      continue;
    }
    const m = EVIDENCE_LINE.exec(line);
    if (!m) continue;
    const [, status, failCode, attestedFailCode, rawLabel, tail] = m;
    let label = rawLabel || undefined;
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
    if (legacy && !label) {
      const old = LEGACY_LABEL.exec(rest);
      if (old) [, label, rest] = old;
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
  for (const line of found.blocks.get(TRIED_HEADER)?.split("\n") ?? []) {
    const m = ATTEMPT_LINE.exec(line);
    if (!m) continue;
    attempts.push({ id: m[1], task: m[2], summary: m[2], evidenceSummary: m[3], startedAt: authoredAt, abandonedAt: authoredAt, evidence: [] });
  }
  const artifacts = parseArtifactTrailers(trailerText);
  const overrides = parseOverrideTrailers(trailerText);
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
      ...(trailers[TRAILER_KEYS.model] ? { model: trailers[TRAILER_KEYS.model] } : {}),
    },
    startedAt: authoredAt,
    landedAt: authoredAt,
    evidence,
    ...(attempts.length ? { attempts } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(overrides.length ? { overrides } : {}),
  };
}

/** Every `Graft-Override` trailer in a message, known values only; `parseTrailers` keeps one value per key. */
export function parseOverrideTrailers(message: string): Override[] {
  const found = new Set<string>();
  for (const line of message.split("\n")) {
    const m = /^Graft-Override:\s*(\S+)\s*$/.exec(line);
    if (m) found.add(m[1]);
  }
  return OVERRIDES.filter((o) => found.has(o));
}

/** The headings of the blocks Graft writes into a message, in the order they appear. */
export const RECORD_HEADERS = ["Plan:", TRIED_HEADER, EVIDENCE_HEADER];

/**
 * The record Graft wrote into a message: the trailer paragraph holding the
 * last `Graft-Change` line, and the Plan:, Tried: and Evidence: blocks in
 * the paragraphs immediately before it, in that order. A header elsewhere in
 * the message (in the task's own text, or in an earlier record of a squash)
 * is not read. Null when the message names no change.
 */
function recordBlockOf(lines: string[]): { trailers: string[]; blocks: Map<string, string> } | null {
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Graft-Change:/.test(lines[i])) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  let start = at;
  while (start > 0 && lines[start - 1].trim()) start--;
  let end = at;
  while (end + 1 < lines.length && lines[end + 1].trim()) end++;
  const blocks = new Map<string, string>();
  // Walk back over the blocks: each is a header line, then indented (or blank) lines.
  let allowed = RECORD_HEADERS.length;
  let i = start - 1;
  while (i >= 0) {
    while (i >= 0 && !lines[i].trim()) i--;
    let h = i;
    while (h >= 0 && (!lines[h].trim() || lines[h].startsWith("  "))) h--;
    if (h < 0 || h === i) break; // no indented body above, so not a block
    const which = RECORD_HEADERS.indexOf(lines[h]);
    if (which < 0 || which >= allowed) break;
    blocks.set(lines[h], readBlock(lines, h));
    allowed = which;
    i = h - 1;
  }
  return { trailers: lines.slice(start, end + 1), blocks };
}

/**
 * The indented lines that follow the header at `start`. Blank lines are
 * kept while the next non-blank line is still indented, so a multi-paragraph
 * plan survives; the block ends at the first unindented line.
 */
function readBlock(lines: string[], start: number): string {
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
