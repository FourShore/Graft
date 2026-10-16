import { spawn } from "node:child_process";
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_CONTEXT_LIMIT, fitContext, type ContextEntry, type ContextOptions, type ContextResult } from "./context.js";
import { Git } from "./git.js";
import {
  type Attempt,
  type ChangeAuthor,
  type ChangeRecord,
  type CommandEvidence,
  type Evidence,
  EVIDENCE_OUTPUT_CAP,
  NOTES_REF,
  TRAILER_KEYS,
  TRIED_HEADER,
  attemptLines,
  isChangeId,
  newChangeId,
  parseTrailers,
  parseMessageRecord,
  evidenceLines,
  EVIDENCE_HEADER,
  trailersFor,
} from "./record.js";
import { OpenChangeStore } from "./store.js";
import { DEFAULT_POLICY, POLICY_PATH, readPolicy, expandTemplate, expandTrailers, evaluateRules, rulesHit, coveringRuns, type Policy } from "./policy.js";
import { looksLikeSecretFile, redact, secretFilesNamed } from "./redact.js";
import { writeCiWorkflow, type CiResult } from "./ci.js";
import { writeAgentsSection, type AgentsResult } from "./agents.js";
import { installHooks, type HooksResult } from "./hooks.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  /** Where the task came from: the thread, issue or ticket that asked for it. */
  ref?: string;
  author?: Partial<ChangeAuthor>;
  /** Abandon a change left open (for example by a crashed session) instead of refusing. */
  replace?: boolean;
  /** Set by the capture hooks: which harness opened the change. */
  capturedBy?: string;
  /** Reuse an existing change id, so one change lands in several repositories. */
  id?: string;
  /** What this change undoes; set by `revert`. */
  reverts?: string;
}

export interface AbandonOptions {
  /** Why the change is being abandoned; kept with the attempt. */
  reason?: string;
  /** Keep nothing: the attempt is not folded into the next land. */
  discard?: boolean;
}

export interface RevertResult {
  /** The change opened for the revert; record evidence and land it. */
  record: ChangeRecord;
  /** The commit being undone. */
  commit: string;
  title: string;
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
  /** What happened to AGENTS.md; absent when `agents: false`. */
  agents?: AgentsResult;
  /** What happened to the capture hooks; absent when `hooks: false`. */
  hooks?: HooksResult;
  /** What happened to the check workflow; absent unless `ci: true`. */
  ci?: CiResult;
}

export interface CapturedRun {
  command: string;
  exitCode: number;
  output?: string;
  durationMs?: number;
  label?: string;
  /** The policy catalog name the command matched, when it did. */
  name?: string;
  /** Which harness reported it, e.g. "claude-code". */
  via: string;
}

export interface PrepareResult {
  /** True when the record was written into the message. */
  applied: boolean;
  reason?: string;
  id?: string;
}

export interface FinishResult {
  /** True when the note was attached to HEAD and the open change closed. */
  attached: boolean;
  reason?: string;
  commit?: string;
  id?: string;
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
  /** Policy trailers left out of this commit because a variable they name is not set. */
  skippedTrailers: { trailer: string; missing: string }[];
}

export interface LogEntry {
  commit: string;
  title: string;
  /** Git author name and ISO date of the commit. */
  authorName: string;
  authoredAt: string;
  record: ChangeRecord | null;
  /**
   * Where `record` came from: the git note (full record, with command output),
   * or the commit message alone (trailers plus the Plan: and Evidence: blocks,
   * no output) when the note is not in this clone. Null when there is no record.
   */
  recordSource: "note" | "message" | null;
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
    if (open?.capturedBy && !opts.replace) {
      // A hook opened this change from the prompt; an explicit start names the task and keeps what was captured.
      if (!opts.task?.trim()) throw new GraftError("A task is required.");
      open.task = opts.task.trim();
      if (opts.plan?.trim()) open.plan = opts.plan.trim();
      if (opts.ref?.trim()) open.ref = opts.ref.trim();
      open.ref ??= await this.defaultRef();
      if (opts.author) open.author = defaultAuthor(opts.author);
      await this.store.write(open);
      return open;
    }
    if (open && !opts.replace) {
      throw new GraftError(
        `A change is already open (${open.id}: ${open.task}, opened ${age(open.startedAt)} ago). ` +
          "Land it, run `graft abandon`, or pass --replace to drop it.",
      );
    }
    if (!opts.task?.trim()) throw new GraftError("A task is required.");
    if (opts.id !== undefined && !isChangeId(opts.id)) throw new GraftError(`"${opts.id}" is not a change id (20 characters of Crockford base32).`);
    // A replaced change is an abandoned one: keep what it tried.
    if (open) await this.abandon({ reason: "replaced by a new start" });
    const record: ChangeRecord = {
      version: 1,
      id: opts.id ?? newChangeId(),
      task: opts.task.trim(),
      plan: opts.plan?.trim() || undefined,
      ref: opts.ref?.trim() || (await this.defaultRef()),
      ...(opts.reverts ? { reverts: opts.reverts } : {}),
      author: defaultAuthor(opts.author),
      startedAt: new Date().toISOString(),
      evidence: [],
      ...(opts.capturedBy ? { capturedBy: opts.capturedBy } : {}),
    };
    await this.store.write(record);
    return record;
  }

  /**
   * The policy's `ref` template, expanded from the environment, for a change
   * started without an explicit ref. Undefined when the policy has none or a
   * variable it names is unset, so no half-filled URL is ever recorded.
   */
  private async defaultRef(policy?: Policy): Promise<string | undefined> {
    let p = policy;
    if (!p) {
      // A broken policy file is land's to report; opening a change must still work.
      try {
        p = await readPolicy(await this.topLevel());
      } catch {
        return undefined;
      }
    }
    if (!p.ref) return undefined;
    const { value, missing } = expandTemplate(p.ref);
    return missing || !value.trim() ? undefined : value.trim();
  }

  /**
   * Close the open change without landing it. What it tried is kept, as an
   * attempt the next change to land in this worktree carries in its `Tried:`
   * block, unless `discard` is set or there is nothing to keep: a change with
   * no plan, no reason and no evidence tried nothing worth recording.
   */
  async abandon(opts: AbandonOptions = {}): Promise<ChangeRecord | null> {
    const open = await this.store.read();
    if (!open) return null;
    const reason = opts.reason?.trim() || undefined;
    const worthKeeping = Boolean(open.plan || reason || open.evidence.length);
    if (!opts.discard && worthKeeping) {
      const attempt: Attempt = {
        id: open.id,
        task: open.task,
        ...(open.plan ? { plan: open.plan } : {}),
        ...(reason ? { reason } : {}),
        ...(open.ref ? { ref: open.ref } : {}),
        startedAt: open.startedAt,
        abandonedAt: new Date().toISOString(),
        evidence: open.evidence,
      };
      await this.store.addAttempt(attempt);
    }
    await this.store.clear();
    return open;
  }

  /** The abandoned attempts waiting to be folded into the next land. */
  async attempts(): Promise<Attempt[]> {
    return this.store.readAttempts();
  }

  /**
   * Open a change that undoes a landed one: `git revert --no-commit` on its
   * commit, and a record whose task names what is being undone and whose
   * plan is the reason, so the revert is as explained as the change was.
   * Evidence and the land are the author's, as for any change.
   */
  async revert(ref: string, opts: { reason?: string; author?: Partial<ChangeAuthor> } = {}): Promise<RevertResult> {
    const target = await this.show(ref);
    if (!target) throw new GraftError(`No change or commit found for ${ref}.`);
    const open = await this.store.read();
    if (open && !open.capturedBy) {
      throw new GraftError(`A change is already open (${open.id}: ${open.task}). Land or abandon it before reverting.`);
    }
    const what = target.record?.id ?? target.commit;
    try {
      await this.git.run(["revert", "--no-commit", "--no-edit", target.commit]);
    } catch (err) {
      throw new GraftError(`git revert ${target.commit.slice(0, 10)} did not apply cleanly: ${(err as Error).message}. Resolve it, or run git revert --abort.`);
    }
    const task = `Revert "${target.title}" (${what})`;
    const record = await this.start({ task, plan: opts.reason, reverts: what, author: opts.author });
    return { record, commit: target.commit, title: target.title };
  }

  async setPlan(plan: string): Promise<ChangeRecord> {
    const open = await this.requireOpen();
    open.plan = plan.trim();
    await this.store.write(open);
    return open;
  }

  private topLevelCache?: Promise<string>;

  /** The working tree root, asked of git once per Graft instance. */
  private topLevel(): Promise<string> {
    this.topLevelCache ??= this.git.topLevel().catch((err) => {
      this.topLevelCache = undefined;
      throw err;
    });
    return this.topLevelCache;
  }

  /** Run a command, capture its result as evidence. The command runs in the repo root. */
  async evidenceCommand(command: string, label?: string, name?: string): Promise<Evidence> {
    const open = await this.requireOpen();
    const cwd = await this.topLevel();
    const started = Date.now();
    const { exitCode, output } = await runShell(command, cwd);
    const ev: Evidence = {
      kind: "command",
      at: new Date().toISOString(),
      command,
      exitCode,
      durationMs: Date.now() - started,
      output: await this.keepOutput(command, output),
      label,
      ...(name ? { name } : {}),
      ...(await this.treeField()),
    };
    open.evidence.push(ev);
    await this.store.write(open);
    return ev;
  }

  /** The policy's named commands, for `graft evidence <name>` and for showing what a repo expects. */
  async catalog(): Promise<Record<string, string>> {
    return (await readPolicy(await this.git.topLevel())).commands ?? {};
  }

  /**
   * Run a command from the policy catalog by name and record it under that
   * name, or with `attest` record a run of it the author already made.
   */
  async evidenceNamed(name: string, label?: string, attest?: { exitCode: number; output?: string }): Promise<Evidence> {
    const commands = await this.catalog();
    const command = commands[name];
    if (!command) {
      const known = Object.keys(commands);
      throw new GraftError(
        known.length
          ? `No command named "${name}" in ${POLICY_PATH}. Known: ${known.join(", ")}.`
          : `${POLICY_PATH} names no commands, so "${name}" cannot be run by name. Add a "commands" map, or run it with --.`,
      );
    }
    if (attest) return this.evidenceAttested(command, attest.exitCode, attest.output ?? "", label, name);
    return this.evidenceCommand(command, label, name);
  }

  /**
   * Attach a run the author already made through their own tools, so a slow
   * build or test suite is not run twice. Graft did not run it, so the record
   * marks it attested: the exit code and output are the author's claim.
   */
  async evidenceAttested(command: string, exitCode: number, output = "", label?: string, name?: string): Promise<Evidence> {
    const open = await this.requireOpen();
    if (!command.trim()) throw new GraftError("The command you ran is required, so the record says what was attested.");
    if (!Number.isInteger(exitCode)) throw new GraftError("Exit code must be an integer.");
    const ev: Evidence = {
      kind: "command",
      at: new Date().toISOString(),
      command: command.trim(),
      exitCode,
      durationMs: 0,
      output: await this.keepOutput(command, output),
      label,
      ...(name ? { name } : {}),
      attested: true,
      ...(await this.treeField()),
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

  /**
   * Record a command a harness ran and reported through a hook, with the
   * exit code and output the harness itself saw. It is command evidence
   * like any other, marked with `via` so a reader knows who ran it.
   */
  async evidenceCaptured(run: CapturedRun): Promise<Evidence> {
    const open = await this.requireOpen();
    if (!run.command.trim()) throw new GraftError("A command is required.");
    const ev: Evidence = {
      kind: "command",
      at: new Date().toISOString(),
      command: run.command.trim(),
      exitCode: run.exitCode,
      durationMs: run.durationMs ?? 0,
      output: await this.keepOutput(run.command, run.output ?? ""),
      label: run.label,
      ...(run.name ? { name: run.name } : {}),
      via: run.via,
      ...(await this.treeField()),
    };
    open.evidence.push(ev);
    await this.store.write(open);
    return ev;
  }

  /** `{ tree }` for a new evidence entry, or nothing when the tree cannot be hashed. */
  private async treeField(): Promise<{ tree?: string }> {
    const tree = await this.worktreeHash();
    return tree ? { tree } : {};
  }

  /**
   * A hash of the working tree as it stands: tracked and untracked files,
   * ignored ones left out, whatever is or is not staged. Built in an empty
   * scratch index so the real one is untouched and every file is read, not
   * trusted from a stat cache: a file rewritten within the same second at the
   * same size would otherwise hash as its old content. The tree object stays
   * in the object store, unreferenced, long enough for the change to land.
   */
  private async worktreeHash(): Promise<string | undefined> {
    try {
      const gitDir = await this.git.gitDir();
      const dir = join(gitDir, "graft");
      await mkdir(dir, { recursive: true });
      const scratch = join(dir, `index.${process.pid}.${Date.now()}`);
      const env = { GIT_INDEX_FILE: scratch };
      try {
        await this.git.run(["add", "-A"], { env });
        return await this.git.run(["write-tree"], { env });
      } finally {
        await rm(scratch, { force: true });
      }
    } catch {
      return undefined;
    }
  }

  /**
   * The files among `files` whose staged content differs from `tree`, or null
   * when the tree is not in this repository (recorded elsewhere, or pruned).
   */
  private async changedSince(tree: string, files: string[]): Promise<string[] | null> {
    try {
      const out = await this.git.run(["diff", "--cached", "--name-only", "--no-renames", tree, "--", ...files.map((f) => `:(top)${f}`)]);
      return out.split("\n").filter(Boolean);
    } catch {
      return null;
    }
  }

  /**
   * For each rule the staged files hit, the required commands whose every
   * covering run predates an edit to a file the rule covers. A run with no
   * recorded tree, or a tree this clone no longer has, is taken as fresh:
   * staleness is refused only when it is certain. Runs that are stale for a
   * rule are marked so, so the commit message says `stale` where a reader
   * would otherwise see `pass`.
   */
  private async staleRules(policy: Policy, staged: string[], evidence: Evidence[]): Promise<{ name: string; command: string; files: string[] }[]> {
    const commands = policy.commands ?? {};
    const stale = new Map<string, Set<string>>();
    const staleRuns = new Set<CommandEvidence>();
    for (const { rule, files } of rulesHit(policy, staged)) {
      for (const name of rule.require) {
        const command = commands[name];
        if (!command) continue;
        const runs = coveringRuns(evidence, name, command);
        if (!runs.length) continue; // unmet, which the caller reports first
        let fresh = false;
        const changed = new Set<string>();
        for (const run of runs) {
          const diff = run.tree ? await this.changedSince(run.tree, files) : null;
          if (diff === null || diff.length === 0) {
            fresh = true;
            continue;
          }
          staleRuns.add(run);
          for (const f of diff) changed.add(f);
        }
        if (!fresh) stale.set(name, changed);
      }
    }
    // Mark after judging every rule, so a run stale for one rule still counts for another it is fresh for.
    for (const run of staleRuns) run.stale = true;
    return [...stale].map(([name, files]) => ({ name, command: commands[name], files: [...files] }));
  }

  /**
   * The output a record may keep: scrubbed of secret-looking environment
   * values and capped, or withheld entirely when the command names a file
   * that looks like credentials (`cat .env && npm test`), since a captured
   * hook sees the whole transcript and the record outlives the key.
   */
  private async keepOutput(command: string, output: string): Promise<string> {
    const policy = await readPolicy(await this.topLevel());
    const named = secretFilesNamed(command, policy.secretFiles);
    if (named.length) return `[output withheld: the command names ${named.join(", ")}, which looks like a credential file]`;
    return capOutput(redact(output));
  }

  /** The landing gate: policy on evidence, then on staged files. Shared by land and the commit hook. */
  private async assertLandable(
    open: ChangeRecord,
    policy: Policy,
    staged: string[],
    opts: Pick<LandOptions, "allowNoEvidence" | "allowSecrets">,
  ): Promise<void> {
    if (policy.requireEvidence && !opts.allowNoEvidence) {
      if (open.evidence.length === 0) {
        throw new GraftError(
          "No evidence recorded. Run `graft evidence -- <command>` or pass --allow-no-evidence.",
        );
      }
      const passed = open.evidence.some((e) => e.kind === "command" && e.exitCode === 0 && !e.attested);
      if (policy.requireEvidence === "command" && !passed) {
        throw new GraftError(
          "Policy requires a passing command that Graft or a harness ran; notes and attested runs alone do not count. " +
            "Run `graft evidence -- <command>` or pass --allow-no-evidence.",
        );
      }
    }
    if (staged.length === 0) {
      throw new GraftError("Nothing staged to commit. Stage files, name paths, or pass --all.");
    }
    const unmet = opts.allowNoEvidence ? [] : evaluateRules(policy, staged, open.evidence);
    if (unmet.length) {
      const wants = unmet.map((u) => `"${u.name}" (${u.command})`).join(" and ");
      const files = [...new Set(unmet.flatMap((u) => u.files))];
      throw new GraftError(
        `Policy requires a passing run of ${wants} for changes to ${files.join(", ")}. ` +
          `Run graft evidence ${unmet.map((u) => u.name).join(", graft evidence ")}, or pass --allow-no-evidence.`,
      );
    }
    // Marks stale runs as a side effect, so the message is honest even when the gate is bypassed.
    const stale = await this.staleRules(policy, staged, open.evidence);
    if (stale.length && !opts.allowNoEvidence) {
      const wants = stale.map((s) => `"${s.name}" (${s.command})`).join(" and ");
      const files = [...new Set(stale.flatMap((s) => s.files))];
      throw new GraftError(
        `${wants} last passed before ${files.join(", ")} changed, so the run did not check what is being committed. ` +
          `Run graft evidence ${stale.map((s) => s.name).join(", graft evidence ")} again, or pass --allow-no-evidence.`,
      );
    }
    const suspicious = staged.filter((p) => looksLikeSecretFile(p, policy.secretFiles));
    if (suspicious.length > 0 && !opts.allowSecrets) {
      throw new GraftError(
        `Refusing to land: staged files look like credentials: ${suspicious.join(", ")}. ` +
          "Unstage them (git restore --staged <file>) or pass --allow-secrets if they are not.",
      );
    }
  }

  /** Commit the staged changes with the record in trailers and a git note. */
  async land(opts: LandOptions = {}): Promise<LandedChange> {
    const open = await this.requireOpen();
    if (opts.plan) open.plan = opts.plan.trim();
    const policy = await readPolicy(await this.git.topLevel());
    if (opts.paths?.length) await this.git.run(["add", "--", ...opts.paths]);
    if (opts.all) await this.git.run(["add", "-A"]);
    const staged = await this.git.stagedFiles();
    await this.assertLandable(open, policy, staged, opts);

    open.landedAt = new Date().toISOString();
    open.ref ??= await this.defaultRef(policy);
    await this.foldAttempts(open);
    const fromPolicy = expandTrailers(policy.trailers ?? []);
    const explicit = opts.trailers ?? [];
    const trailers = [...fromPolicy.trailers.filter((t) => !explicit.includes(t)), ...explicit];
    const message = buildCommitMessage(open, opts.title, trailers);
    // The git hooks graft init installs step aside while Graft itself commits.
    const previous = process.env.GRAFT_LANDING;
    process.env.GRAFT_LANDING = "1";
    try {
      await this.git.run(["commit", "-q", "-F", "-"], { input: message });
    } finally {
      if (previous === undefined) delete process.env.GRAFT_LANDING;
      else process.env.GRAFT_LANDING = previous;
    }
    const commit = (await this.git.head())!;
    open.commit = commit;

    await this.git.run(["notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", "-", commit], {
      input: JSON.stringify(open, null, 2) + "\n",
    });
    await this.store.clear();
    await this.store.clearAttempts();
    return { record: open, commit, skippedTrailers: fromPolicy.skipped };
  }

  /** Attach the worktree's abandoned attempts to a change about to land. */
  private async foldAttempts(open: ChangeRecord): Promise<void> {
    const waiting = await this.store.readAttempts();
    if (!waiting.length) return;
    const have = new Set((open.attempts ?? []).map((a) => a.id));
    open.attempts = [...(open.attempts ?? []), ...waiting.filter((a) => !have.has(a.id))];
  }

  /**
   * The prepare-commit-msg hook: when a change is open and the message does
   * not already carry a record, run the landing gate and append the record
   * (plan, evidence, trailers) to the message file, so a plain `git commit`
   * lands like `graft land`. Merges, squashes and amends are left alone.
   */
  async prepareCommitMessage(messageFile: string, source?: string): Promise<PrepareResult> {
    if (source === "merge" || source === "squash" || source === "commit") {
      return { applied: false, reason: `${source} commit` };
    }
    const open = await this.store.read();
    if (!open) return { applied: false, reason: "no change is open" };
    const current = await readFile(messageFile, "utf8");
    if (parseTrailers(current)[TRAILER_KEYS.change]) return { applied: false, reason: "message already carries a record" };
    const policy = await readPolicy(await this.git.topLevel());
    const staged = await this.git.stagedFiles();
    try {
      await this.assertLandable(open, policy, staged, {
        allowNoEvidence: Boolean(process.env.GRAFT_ALLOW_NO_EVIDENCE),
        allowSecrets: Boolean(process.env.GRAFT_ALLOW_SECRETS),
      });
    } catch (err) {
      if (!(err instanceof GraftError)) throw err;
      throw new GraftError(
        err.message
          .replace("pass --allow-no-evidence", "set GRAFT_ALLOW_NO_EVIDENCE=1 for this commit")
          .replace("pass --allow-secrets if they are not", "set GRAFT_ALLOW_SECRETS=1 if they are not"),
      );
    }
    open.landedAt = new Date().toISOString();
    open.ref ??= await this.defaultRef(policy);
    await this.foldAttempts(open);
    await this.store.write(open);
    await this.store.clearAttempts();
    const block = recordBlock(open, expandTrailers(policy.trailers ?? []).trailers).join("\n");
    // Keep git's own comment lines (the editor template) after the record.
    const lines = current.split("\n");
    const firstComment = lines.findIndex((l) => l.startsWith("#"));
    const body = (firstComment === -1 ? lines : lines.slice(0, firstComment)).join("\n").replace(/\s+$/, "");
    const comments = firstComment === -1 ? "" : "\n" + lines.slice(firstComment).join("\n");
    const head = body ? body + "\n\n" : "\n\n";
    await writeFile(messageFile, head + block + "\n" + comments);
    return { applied: true, id: open.id };
  }

  /**
   * The post-commit hook: when HEAD carries the open change's id, attach the
   * full record as the note and close the change.
   */
  async finishCommit(): Promise<FinishResult> {
    const open = await this.store.read();
    if (!open) return { attached: false, reason: "no change is open" };
    const commit = await this.git.head();
    if (!commit) return { attached: false, reason: "no commit" };
    const message = await this.git.run(["log", "-1", "--format=%B", commit]);
    if (parseTrailers(message)[TRAILER_KEYS.change] !== open.id) {
      return { attached: false, reason: "HEAD does not carry the open change" };
    }
    open.landedAt ??= new Date().toISOString();
    open.commit = commit;
    await this.git.run(["notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", "-", commit], {
      input: JSON.stringify(open, null, 2) + "\n",
    });
    await this.store.clear();
    return { attached: true, commit, id: open.id };
  }

  /**
   * Prepare a repository: make git carry notes through amend and rebase,
   * fetch the notes ref alongside branches, write a starter policy file, and
   * tell agents how to use Graft in AGENTS.md. Safe to run more than once.
   */
  async init(opts: { remote?: string; force?: boolean; agents?: boolean; hooks?: boolean; ci?: boolean } = {}): Promise<InitResult> {
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
    const agents = opts.agents === false ? undefined : await writeAgentsSection(topLevel);
    const hooks = opts.hooks === false ? undefined : await installHooks(this.git, topLevel);
    const ci = opts.ci ? await writeCiWorkflow(topLevel) : undefined;
    return { topLevel, configured, policyWritten, remote: remote ?? undefined, agents, hooks, ci };
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
  async log(opts: { limit?: number; onlyGraft?: boolean; range?: string; noMerges?: boolean } = {}): Promise<LogEntry[]> {
    if (!(await this.git.head())) return [];
    const limit = opts.limit ?? 20;
    const raw = await this.git.run([
      "log",
      `--max-count=${limit}`,
      ...(opts.noMerges ? ["--no-merges"] : []),
      "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%B%x1e",
      ...(opts.range ? [opts.range] : []),
    ]);
    const entries: LogEntry[] = [];
    for (const chunk of raw.split("\x1e")) {
      if (!chunk.trim()) continue;
      const [commit, title, authorName, authoredAt, body] = chunk.replace(/^\n/, "").split("\x1f");
      const trailers = parseTrailers(body ?? "");
      if (opts.onlyGraft && !trailers[TRAILER_KEYS.change]) continue;
      entries.push({ commit, title, authorName, authoredAt, trailers, ...(await this.readRecord(commit, body ?? "", authoredAt)) });
    }
    return entries;
  }

  /**
   * The history of the files you are about to touch: commits that changed any
   * of `paths` (files or directories, relative to the working directory),
   * newest first, with their records, rendered to fit a prompt. With no paths
   * it covers the whole repository.
   */
  async context(paths: string[], opts: ContextOptions = {}): Promise<ContextResult> {
    const budget = opts.budget ?? DEFAULT_CONTEXT_BUDGET;
    if (!(await this.git.head())) return fitContext(paths, [], 0, budget);
    const raw = await this.git.run([
      "log",
      `--max-count=${opts.limit ?? DEFAULT_CONTEXT_LIMIT}`,
      "--name-only",
      "--format=%x1e%H%x1f%s%x1f%an%x1f%aI%x1f%B%x1d",
      "--",
      ...paths,
    ]);
    const matched: ContextEntry[] = [];
    let unrecorded = 0;
    for (const chunk of raw.split("\x1e")) {
      if (!chunk.trim()) continue;
      const [meta, named = ""] = chunk.split("\x1d");
      const [commit, title, authorName, authoredAt, body] = meta.split("\x1f");
      const files = named.split("\n").map((l) => l.trim()).filter(Boolean);
      const trailers = parseTrailers(body ?? "");
      const read = await this.readRecord(commit, body ?? "", authoredAt);
      if (!read.record) unrecorded++;
      if (!read.record && !opts.all) continue;
      matched.push({ commit, title, authorName, authoredAt, trailers, files, ...read });
    }
    return fitContext(paths, matched, unrecorded, budget);
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
    return { commit: sha, title, authorName, authoredAt, trailers, ...(await this.readRecord(sha, body ?? "", authoredAt)) };
  }

  /** The unified diff a commit introduced against its first parent (empty for a root commit's parent side). */
  async diff(commit: string): Promise<string> {
    return this.git.run(["show", "--format=", "--no-color", "--no-ext-diff", "-M", "--root", commit]);
  }

  /** The note when it is here, else what the commit message alone can reconstruct. */
  private async readRecord(
    commit: string,
    message: string,
    authoredAt: string,
  ): Promise<Pick<LogEntry, "record" | "recordSource">> {
    if (!parseTrailers(message)[TRAILER_KEYS.change]) return { record: null, recordSource: null };
    const note = await this.readNote(commit);
    if (note) return { record: note, recordSource: "note" };
    const record = parseMessageRecord(message, authoredAt);
    return record ? { record, recordSource: "message" } : { record: null, recordSource: null };
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
  lines.push(...recordBlock(record, extraTrailers));
  return lines.join("\n") + "\n";
}

/** The record as message lines: Plan and Evidence blocks, then the trailers. */
export function recordBlock(record: ChangeRecord, extraTrailers: string[] = []): string[] {
  const lines: string[] = [];
  if (record.plan) lines.push("Plan:", indent(record.plan), "");
  if (record.attempts?.length) lines.push(TRIED_HEADER, ...attemptLines(record.attempts), "");
  if (record.evidence.length) lines.push(EVIDENCE_HEADER, ...evidenceLines(record.evidence), "");
  for (const [k, v] of trailersFor(record)) lines.push(`${k}: ${v}`);
  for (const t of extraTrailers) lines.push(checkTrailer(t));
  return lines;
}

const TRAILER = /^([A-Za-z][A-Za-z0-9-]*): (\S.*)$/;

function checkTrailer(t: string): string {
  const m = TRAILER.exec(t.trim());
  if (!m) throw new GraftError(`Bad trailer '${t}': expected 'Key: value'.`);
  if (/^graft-/i.test(m[1])) throw new GraftError(`Trailer '${m[1]}' is reserved; Graft writes its own.`);
  return `${m[1]}: ${m[2]}`;
}

function age(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
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
  const kind = partial?.kind ?? (env.CLAUDECODE || env.GRAFT_AUTHOR ? "agent" : "human");
  return { kind, name };
}

function capOutput(s: string): string {
  if (Buffer.byteLength(s) <= EVIDENCE_OUTPUT_CAP) return s;
  const tail = Buffer.from(s).subarray(-EVIDENCE_OUTPUT_CAP).toString("utf8");
  return "[... truncated ...]\n" + tail;
}

/** Run a shell command from `cwd`, capturing its exit code and combined output. Records nothing. */
export function runShell(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => resolve({ exitCode: 127, output: String(err) }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output: Buffer.concat(chunks).toString("utf8") }));
  });
}
