import { spawn } from "node:child_process";
import { Git } from "./git.js";
import {
  type ChangeAuthor,
  type ChangeRecord,
  type Evidence,
  EVIDENCE_OUTPUT_CAP,
  NOTES_REF,
  TRAILER_KEYS,
  isChangeId,
  newChangeId,
  parseTrailers,
  trailersFor,
} from "./record.js";
import { OpenChangeStore } from "./store.js";
import { DEFAULT_POLICY, POLICY_PATH, readPolicy } from "./policy.js";
import { looksLikeSecretFile, redact } from "./redact.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class GraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraftError";
  }
}

export interface StartOptions {
  task: string;
  plan?: string;
  author?: Partial<ChangeAuthor>;
}

export interface LandOptions {
  /** Commit title. Defaults to the task, truncated to 72 chars. */
  title?: string;
  /** Stage everything (git add -A) before committing. Off by default; prefer `paths`. */
  all?: boolean;
  /** Stage these paths (git add -- <paths>) before committing. */
  paths?: string[];
  /** Land even though a staged file looks like a credential (.env, *.pem, ...). */
  allowSecrets?: boolean;
  /** Extra commit trailers, each "Key: value", appended after Graft's own (e.g. Co-Authored-By). */
  trailers?: string[];
  /** Final plan, overriding whatever was recorded at start. */
  plan?: string;
  /** Allow landing with no evidence recorded. */
  allowNoEvidence?: boolean;
}

export interface InitResult {
  topLevel: string;
  /** Config keys that were set by this call (already-correct keys are omitted). */
  configured: string[];
  /** True if .graft/policy.json was written. */
  policyWritten: boolean;
  remote?: string;
}

export interface SyncResult {
  remote: string;
  fetched: boolean;
  merged: boolean;
  pushed: boolean;
  /** Why the push was refused, when it was. Fetch and merge still happened. */
  pushError?: string;
}

export interface LandedChange {
  record: ChangeRecord;
  commit: string;
}

export interface LogEntry {
  commit: string;
  title: string;
  /** Git author name and ISO date of the commit. */
  authorName: string;
  authoredAt: string;
  record: ChangeRecord | null;
  /** Trailers parsed from the message, even when the note is missing. */
  trailers: Record<string, string>;
}

/** The Graft API: start, evidence, land, log. The CLI and MCP server both call this. */
export class Graft {
  readonly git: Git;
  private readonly store: OpenChangeStore;

  constructor(cwd: string = process.cwd()) {
    this.git = new Git(cwd);
    this.store = new OpenChangeStore(this.git);
  }

  async status(): Promise<ChangeRecord | null> {
    return this.store.read();
  }

  async start(opts: StartOptions): Promise<ChangeRecord> {
    const open = await this.store.read();
    if (open) {
      throw new GraftError(
        `A change is already open (${open.id}: ${open.task}). Land it or run \`graft abandon\` first.`,
      );
    }
    if (!opts.task?.trim()) throw new GraftError("A task is required.");
    const record: ChangeRecord = {
      version: 1,
      id: newChangeId(),
      task: opts.task.trim(),
      plan: opts.plan?.trim() || undefined,
      author: defaultAuthor(opts.author),
      startedAt: new Date().toISOString(),
      evidence: [],
    };
    await this.store.write(record);
    return record;
  }

  async abandon(): Promise<ChangeRecord | null> {
    const open = await this.store.read();
    await this.store.clear();
    return open;
  }

  async setPlan(plan: string): Promise<ChangeRecord> {
    const open = await this.requireOpen();
    open.plan = plan.trim();
    await this.store.write(open);
    return open;
  }

  /** Run a command, capture its result as evidence. The command runs in the repo root. */
  async evidenceCommand(command: string, label?: string): Promise<Evidence> {
    const open = await this.requireOpen();
    const cwd = await this.git.topLevel();
    const started = Date.now();
    const { exitCode, output } = await runShell(command, cwd);
    const ev: Evidence = {
      kind: "command",
      at: new Date().toISOString(),
      command,
      exitCode,
      durationMs: Date.now() - started,
      output: capOutput(redact(output)),
      label,
    };
    open.evidence.push(ev);
    await this.store.write(open);
    return ev;
  }

  /** Record evidence that was produced elsewhere (a manual check, a CI link). */
  async evidenceNote(text: string, label?: string): Promise<Evidence> {
    const open = await this.requireOpen();
    if (!text.trim()) throw new GraftError("Evidence text is required.");
    const ev: Evidence = { kind: "note", at: new Date().toISOString(), text: redact(text.trim()), label };
    open.evidence.push(ev);
    await this.store.write(open);
    return ev;
  }

  /** Commit the staged changes with the record in trailers and a git note. */
  async land(opts: LandOptions = {}): Promise<LandedChange> {
    const open = await this.requireOpen();
    if (opts.plan) open.plan = opts.plan.trim();
    const policy = await readPolicy(await this.git.topLevel());
    if (open.evidence.length === 0 && policy.requireEvidence && !opts.allowNoEvidence) {
      throw new GraftError(
        "No evidence recorded. Run `graft evidence -- <command>` or pass --allow-no-evidence.",
      );
    }
    if (opts.paths?.length) await this.git.run(["add", "--", ...opts.paths]);
    if (opts.all) await this.git.run(["add", "-A"]);
    const staged = await this.git.stagedFiles();
    if (staged.length === 0) {
      throw new GraftError("Nothing staged to commit. Stage files, name paths, or pass --all.");
    }
    const suspicious = staged.filter((p) => looksLikeSecretFile(p, policy.secretFiles));
    if (suspicious.length > 0 && !opts.allowSecrets) {
      throw new GraftError(
        `Refusing to land: staged files look like credentials: ${suspicious.join(", ")}. ` +
          "Unstage them (git restore --staged <file>) or pass --allow-secrets if they are not.",
      );
    }

    open.landedAt = new Date().toISOString();
    const message = buildCommitMessage(open, opts.title, opts.trailers);
    await this.git.run(["commit", "-q", "-F", "-"], { input: message });
    const commit = (await this.git.head())!;
    open.commit = commit;

    await this.git.run(["notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", "-", commit], {
      input: JSON.stringify(open, null, 2) + "\n",
    });
    await this.store.clear();
    return { record: open, commit };
  }

  /**
   * Prepare a repository: make git carry notes through amend and rebase,
   * fetch the notes ref alongside branches, and write a starter policy file.
   * Safe to run more than once.
   */
  async init(opts: { remote?: string; force?: boolean } = {}): Promise<InitResult> {
    const topLevel = await this.git.topLevel();
    const configured: string[] = [];
    const want: Array<[string, string]> = [
      ["notes.rewriteRef", NOTES_REF],
      ["notes.rewriteMode", "overwrite"],
      ["notes.rewrite.amend", "true"],
      ["notes.rewrite.rebase", "true"],
    ];
    for (const [key, value] of want) {
      if ((await this.configGet(key)) !== value) {
        await this.git.run(["config", key, value]);
        configured.push(key);
      }
    }

    const remote = opts.remote ?? (await this.defaultRemote());
    if (remote) {
      const refspec = `+${NOTES_REF}:${NOTES_REF}`;
      const existing = await this.configGetAll(`remote.${remote}.fetch`);
      if (!existing.includes(refspec)) {
        await this.git.run(["config", "--add", `remote.${remote}.fetch`, refspec]);
        configured.push(`remote.${remote}.fetch`);
      }
    }

    let policyWritten = false;
    const policyFile = join(topLevel, POLICY_PATH);
    try {
      await readFile(policyFile, "utf8");
      if (opts.force) throw Object.assign(new Error("force"), { code: "ENOENT" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await mkdir(join(topLevel, ".graft"), { recursive: true });
      await writeFile(policyFile, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n");
      policyWritten = true;
    }
    return { topLevel, configured, policyWritten, remote: remote ?? undefined };
  }

  /**
   * Exchange change records with a remote: fetch its notes, merge them into
   * ours (records never conflict in practice since each commit has one), push.
   */
  async sync(opts: { remote?: string; push?: boolean } = {}): Promise<SyncResult> {
    const remote = opts.remote ?? (await this.defaultRemote());
    if (!remote) throw new GraftError("No remote configured. Pass --remote or add one with `git remote add`.");
    const theirs = `refs/notes/graft-${remote}`;
    let fetched = false;
    try {
      await this.git.run(["fetch", "-q", remote, `+${NOTES_REF}:${theirs}`]);
      fetched = true;
    } catch (err) {
      // A remote with no notes yet is normal on first sync; anything else is real.
      if (!/couldn't find remote ref|fatal: .*not found/i.test((err as Error).message)) throw err;
    }
    let merged = false;
    if (fetched) {
      const haveLocal = Boolean(await this.refExists(NOTES_REF));
      if (!haveLocal) {
        await this.git.run(["update-ref", NOTES_REF, theirs]);
      } else {
        await this.git.run(["notes", `--ref=${NOTES_REF}`, "merge", "-q", "-s", "cat_sort_uniq", theirs]);
      }
      merged = true;
    }
    let pushed = false;
    let pushError: string | undefined;
    if (opts.push !== false && (await this.refExists(NOTES_REF))) {
      try {
        await this.git.run(["push", "-q", remote, `${NOTES_REF}:${NOTES_REF}`]);
        pushed = true;
      } catch (err) {
        // Some hosts (and some agent sandboxes) refuse pushes to refs/notes.
        // The merge above still happened, so this is a warning, not a failure.
        pushError = (err as Error).message;
      }
    }
    return { remote, fetched, merged, pushed, pushError };
  }

  /** History as changes. Commits without a Graft record are included with record: null. */
  async log(opts: { limit?: number; onlyGraft?: boolean } = {}): Promise<LogEntry[]> {
    if (!(await this.git.head())) return [];
    const limit = opts.limit ?? 20;
    const raw = await this.git.run([
      "log",
      `--max-count=${limit}`,
      "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%B%x1e",
    ]);
    const entries: LogEntry[] = [];
    for (const chunk of raw.split("\x1e")) {
      if (!chunk.trim()) continue;
      const [commit, title, authorName, authoredAt, body] = chunk.replace(/^\n/, "").split("\x1f");
      const trailers = parseTrailers(body ?? "");
      if (opts.onlyGraft && !trailers[TRAILER_KEYS.change]) continue;
      const record = trailers[TRAILER_KEYS.change] ? await this.readNote(commit) : null;
      entries.push({ commit, title, authorName, authoredAt, trailers, record });
    }
    return entries;
  }

  /** Look up one change by id or commit SHA. */
  async show(ref: string): Promise<LogEntry | null> {
    if (isChangeId(ref)) {
      const raw = await this.git.run(["log", "--all", `--grep=^${TRAILER_KEYS.change}: ${ref}$`, "--format=%H"]);
      const commit = raw.split("\n")[0];
      if (!commit) return null;
      ref = commit;
    }
    let sha: string;
    try {
      sha = await this.git.run(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    } catch {
      return null;
    }
    const [title, authorName, authoredAt, body] = (
      await this.git.run(["log", "-1", "--format=%s%x1f%an%x1f%aI%x1f%B", sha])
    ).split("\x1f");
    const trailers = parseTrailers(body ?? "");
    return { commit: sha, title, authorName, authoredAt, trailers, record: await this.readNote(sha) };
  }

  /** The unified diff a commit introduced against its first parent (empty for a root commit's parent side). */
  async diff(commit: string): Promise<string> {
    return this.git.run(["show", "--format=", "--no-color", "--no-ext-diff", "-M", "--root", commit]);
  }

  private async readNote(commit: string): Promise<ChangeRecord | null> {
    try {
      const raw = await this.git.run(["notes", `--ref=${NOTES_REF}`, "show", commit]);
      return JSON.parse(raw) as ChangeRecord;
    } catch {
      return null;
    }
  }

  private async configGet(key: string): Promise<string | null> {
    try {
      return await this.git.run(["config", "--get", key]);
    } catch {
      return null;
    }
  }

  private async configGetAll(key: string): Promise<string[]> {
    try {
      return (await this.git.run(["config", "--get-all", key])).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  private async refExists(ref: string): Promise<string | null> {
    try {
      return await this.git.run(["rev-parse", "--verify", "-q", ref]);
    } catch {
      return null;
    }
  }

  private async defaultRemote(): Promise<string | null> {
    const remotes = (await this.git.run(["remote"])).split("\n").filter(Boolean);
    if (remotes.includes("origin")) return "origin";
    return remotes[0] ?? null;
  }

  private async requireOpen(): Promise<ChangeRecord> {
    const open = await this.store.read();
    if (!open) throw new GraftError("No change is open. Run `graft start <task>` first.");
    return open;
  }
}

export function buildCommitMessage(record: ChangeRecord, title?: string, extraTrailers: string[] = []): string {
  const subject = (title?.trim() || record.task).split("\n")[0].slice(0, 72);
  const lines = [subject, ""];
  if (record.task !== subject) lines.push(record.task, "");
  if (record.plan) lines.push("Plan:", indent(record.plan), "");
  for (const [k, v] of trailersFor(record)) lines.push(`${k}: ${v}`);
  for (const t of extraTrailers) lines.push(checkTrailer(t));
  return lines.join("\n") + "\n";
}

const TRAILER = /^([A-Za-z][A-Za-z0-9-]*): (\S.*)$/;

function checkTrailer(t: string): string {
  const m = TRAILER.exec(t.trim());
  if (!m) throw new GraftError(`Bad trailer '${t}': expected 'Key: value'.`);
  if (/^graft-/i.test(m[1])) throw new GraftError(`Trailer '${m[1]}' is reserved; Graft writes its own.`);
  return `${m[1]}: ${m[2]}`;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => (l ? "  " + l : l))
    .join("\n");
}

function defaultAuthor(partial?: Partial<ChangeAuthor>): ChangeAuthor {
  const env = process.env;
  const name = partial?.name ?? env.GRAFT_AUTHOR ?? (env.CLAUDECODE ? "claude-code" : env.USER ?? "unknown");
  const model = partial?.model ?? env.GRAFT_MODEL ?? env.ANTHROPIC_MODEL ?? undefined;
  const kind = partial?.kind ?? (model || env.CLAUDECODE || env.GRAFT_AUTHOR ? "agent" : "human");
  return { kind, name, model };
}

function capOutput(s: string): string {
  if (Buffer.byteLength(s) <= EVIDENCE_OUTPUT_CAP) return s;
  const tail = Buffer.from(s).subarray(-EVIDENCE_OUTPUT_CAP).toString("utf8");
  return "[... truncated ...]\n" + tail;
}

function runShell(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => resolve({ exitCode: 127, output: String(err) }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks).toString("utf8") }));
  });
}
