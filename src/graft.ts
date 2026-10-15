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
  /** Stage everything (git add -A) before committing. */
  all?: boolean;
  /** Final plan, overriding whatever was recorded at start. */
  plan?: string;
  /** Allow landing with no evidence recorded. */
  allowNoEvidence?: boolean;
}

export interface LandedChange {
  record: ChangeRecord;
  commit: string;
}

export interface LogEntry {
  commit: string;
  title: string;
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
      output: capOutput(output),
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
    const ev: Evidence = { kind: "note", at: new Date().toISOString(), text: text.trim(), label };
    open.evidence.push(ev);
    await this.store.write(open);
    return ev;
  }

  /** Commit the staged changes with the record in trailers and a git note. */
  async land(opts: LandOptions = {}): Promise<LandedChange> {
    const open = await this.requireOpen();
    if (opts.plan) open.plan = opts.plan.trim();
    if (open.evidence.length === 0 && !opts.allowNoEvidence) {
      throw new GraftError(
        "No evidence recorded. Run `graft evidence -- <command>` or pass --allow-no-evidence.",
      );
    }
    if (opts.all) await this.git.run(["add", "-A"]);
    if (!(await this.git.hasStagedChanges())) {
      throw new GraftError("Nothing staged to commit. Stage files or pass --all.");
    }

    open.landedAt = new Date().toISOString();
    const message = buildCommitMessage(open, opts.title);
    await this.git.run(["commit", "-q", "-F", "-"], { input: message });
    const commit = (await this.git.head())!;
    open.commit = commit;

    await this.git.run(["notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", "-", commit], {
      input: JSON.stringify(open, null, 2) + "\n",
    });
    await this.store.clear();
    return { record: open, commit };
  }

  /** History as changes. Commits without a Graft record are included with record: null. */
  async log(opts: { limit?: number; onlyGraft?: boolean } = {}): Promise<LogEntry[]> {
    if (!(await this.git.head())) return [];
    const limit = opts.limit ?? 20;
    const raw = await this.git.run([
      "log",
      `--max-count=${limit}`,
      "--format=%H%x1f%s%x1f%B%x1e",
    ]);
    const entries: LogEntry[] = [];
    for (const chunk of raw.split("\x1e")) {
      if (!chunk.trim()) continue;
      const [commit, title, body] = chunk.replace(/^\n/, "").split("\x1f");
      const trailers = parseTrailers(body ?? "");
      if (opts.onlyGraft && !trailers[TRAILER_KEYS.change]) continue;
      const record = trailers[TRAILER_KEYS.change] ? await this.readNote(commit) : null;
      entries.push({ commit, title, trailers, record });
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
    const sha = await this.git.run(["rev-parse", "--verify", `${ref}^{commit}`]);
    const body = await this.git.run(["log", "-1", "--format=%B", sha]);
    const title = await this.git.run(["log", "-1", "--format=%s", sha]);
    const trailers = parseTrailers(body);
    return { commit: sha, title, trailers, record: await this.readNote(sha) };
  }

  private async readNote(commit: string): Promise<ChangeRecord | null> {
    try {
      const raw = await this.git.run(["notes", `--ref=${NOTES_REF}`, "show", commit]);
      return JSON.parse(raw) as ChangeRecord;
    } catch {
      return null;
    }
  }

  private async requireOpen(): Promise<ChangeRecord> {
    const open = await this.store.read();
    if (!open) throw new GraftError("No change is open. Run `graft start <task>` first.");
    return open;
  }
}

export function buildCommitMessage(record: ChangeRecord, title?: string): string {
  const subject = (title?.trim() || record.task).split("\n")[0].slice(0, 72);
  const lines = [subject, ""];
  if (record.task !== subject) lines.push(record.task, "");
  if (record.plan) lines.push("Plan:", indent(record.plan), "");
  for (const [k, v] of trailersFor(record)) lines.push(`${k}: ${v}`);
  return lines.join("\n") + "\n";
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
