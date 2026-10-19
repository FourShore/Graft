import { spawn } from "node:child_process";
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_CONTEXT_LIMIT, fitContext, type ContextEntry, type ContextOptions, type ContextResult } from "./context.js";
import { Git, invokingGitArgs, splitNul } from "./git.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import {
  type Artifact,
  type Attempt,
  type ChangeAuthor,
  type ChangeRecord,
  type CommandEvidence,
  type Evidence,
  type Override,
  OVERRIDES,
  EVIDENCE_OUTPUT_CAP,
  NOTES_REF,
  TRAILER_KEYS,
  TRIED_HEADER,
  attemptLines,
  isChangeId,
  isSha256,
  newChangeId,
  parseTrailers,
  parseMessageRecord,
  evidenceLines,
  EVIDENCE_HEADER,
  trailersFor,
} from "./record.js";
import { OpenChangeStore } from "./store.js";
import { detectPolicy } from "./detect.js";
import { POLICY_PATH, readPolicy, expandTemplate, expandTrailers, evaluateRules, rulesHit, coveringRuns, type Policy } from "./policy.js";
import { globToRegExp, looksLikeSecretFile, redact, secretFilesNamed } from "./redact.js";
import { writeCiWorkflow, type CiResult } from "./ci.js";
import { writeAgentsSection, type AgentsResult } from "./agents.js";
import { installHooks, type HooksResult } from "./hooks.js";
import { copyFile, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  /** Set by the capture hooks: the harness session that opened it. */
  sessionId?: string;
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
  /** The build files the written policy's commands came from (package.json, go.mod, ...); empty when none were found. */
  policyFrom: string[];
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

export interface ExportEntry extends LogEntry {
  /** The unified diff the commit introduced; omitted when `diff: false`. */
  diff?: string;
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

  /** The last task a capture hook recorded for a harness session, if it was this one. */
  async sessionTask(sessionId: string | undefined): Promise<string | null> {
    if (!sessionId) return null;
    const s = await this.store.readSession();
    return s?.sessionId === sessionId ? s.task : null;
  }

  async rememberSessionTask(sessionId: string | undefined, task: string): Promise<void> {
    if (sessionId) await this.store.writeSession({ sessionId, task: redact(task) });
  }

  async start(opts: StartOptions): Promise<ChangeRecord> {
    const open = await this.store.read();
    if (opts.id !== undefined && !isChangeId(opts.id)) throw new GraftError(`"${opts.id}" is not a change id (20 characters of Crockford base32).`);
    if (open?.capturedBy && !opts.replace) {
      // A hook opened this change from the prompt; an explicit start names the task and keeps what was captured.
      if (!opts.task?.trim()) throw new GraftError("A task is required.");
      if (opts.id !== undefined) open.id = opts.id;
      open.task = redact(opts.task.trim());
      if (opts.plan?.trim()) open.plan = redact(opts.plan.trim());
      if (opts.ref?.trim()) open.ref = opts.ref.trim();
      open.ref ??= await this.defaultRef();
      if (opts.author) {
        const author = defaultAuthor(opts.author);
        // The hook knew the model; keep it while the author is still that agent, not once a human or another tool takes over.
        const same = author.kind === open.author.kind && author.name === open.author.name;
        if (!author.model && same && open.author.model) author.model = open.author.model;
        open.author = author;
      }
      if (opts.reverts) open.reverts = opts.reverts;
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
    // A replaced change is an abandoned one: keep what it tried.
    if (open) await this.abandon({ reason: "replaced by a new start" });
    const record: ChangeRecord = {
      version: 1,
      id: opts.id ?? newChangeId(),
      task: redact(opts.task.trim()),
      plan: opts.plan?.trim() ? redact(opts.plan.trim()) : undefined,
      ref: opts.ref?.trim() || (await this.defaultRef()),
      ...(opts.reverts ? { reverts: opts.reverts } : {}),
      author: defaultAuthor(opts.author),
      startedAt: new Date().toISOString(),
      evidence: [],
      ...(opts.capturedBy ? { capturedBy: opts.capturedBy } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
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
    const reason = opts.reason?.trim() ? redact(opts.reason.trim()) : undefined;
    // Attempts a prepare-commit-msg hook folded into this record, for a commit
    // that then did not happen, belong to earlier changes: they go back to waiting.
    for (const earlier of open.attempts ?? []) await this.store.addAttempt(earlier);
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
    open.plan = redact(plan.trim());
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
    const tree = await this.treeField(); // the tree the run checks, taken before it can change
    const started = Date.now();
    const { exitCode, output } = await runShell(command, cwd);
    const ev: Evidence = {
      kind: "command",
      at: new Date().toISOString(),
      command: redact(command),
      exitCode,
      durationMs: Date.now() - started,
      output: await this.keepOutput(command, output),
      label: label === undefined ? undefined : redact(label),
      ...(name ? { name } : {}),
      ...tree,
    };
    await this.appendEvidence(open, ev);
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
      command: redact(command.trim()),
      exitCode,
      durationMs: 0,
      output: await this.keepOutput(command, output),
      label: label === undefined ? undefined : redact(label),
      ...(name ? { name } : {}),
      attested: true,
      ...(await this.treeField()),
    };
    await this.appendEvidence(open, ev);
    return ev;
  }

  /**
   * Record a file this change produced, by content hash, so a build found in
   * the field (`nova.exe` on an office machine) resolves to the change that
   * made it. Give a path to hash, or the hash and a name when the file is
   * elsewhere.
   */
  async recordArtifact(opts: { path?: string; sha256?: string; name?: string }): Promise<Artifact> {
    const open = await this.requireOpen();
    let sha256 = opts.sha256?.replace(/^sha256:/i, "").toLowerCase();
    if (opts.path) sha256 = await sha256File(opts.path);
    if (!sha256) throw new GraftError("Give a file to hash, or --sha256 and --name for a file that is not here.");
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new GraftError(`"${opts.sha256}" is not a SHA-256 hex digest.`);
    const name = opts.name?.trim() || (opts.path ? basename(opts.path) : "");
    if (!name) throw new GraftError("An artifact needs a name (--name) when it is given by hash.");
    const artifact: Artifact = { name, sha256 };
    open.artifacts = [...(open.artifacts ?? []).filter((a) => a.sha256 !== sha256), artifact];
    await this.store.write(open);
    return artifact;
  }

  /** Record evidence that was produced elsewhere (a manual check, a CI link). */
  async evidenceNote(text: string, label?: string): Promise<Evidence> {
    const open = await this.requireOpen();
    if (!text.trim()) throw new GraftError("Evidence text is required.");
    const ev: Evidence = { kind: "note", at: new Date().toISOString(), text: redact(text.trim()), label };
    await this.appendEvidence(open, ev);
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
      command: redact(run.command.trim()),
      exitCode: run.exitCode,
      durationMs: run.durationMs ?? 0,
      output: await this.keepOutput(run.command, run.output ?? ""),
      label: run.label === undefined ? undefined : redact(run.label),
      ...(run.name ? { name: run.name } : {}),
      via: run.via,
      ...(await this.treeField()),
    };
    await this.appendEvidence(open, ev);
    return ev;
  }

  /**
   * Add evidence to the open change under the store's lock, so runs recorded
   * at the same time (parallel hooks, a note during a long run) all survive.
   */
  private async appendEvidence(open: ChangeRecord, ev: Evidence): Promise<void> {
    if (!(await this.store.appendEvidence(open.id, ev))) {
      throw new GraftError(`Change ${open.id} was landed or abandoned while this ran, so the result was not recorded.`);
    }
    open.evidence.push(ev);
  }

  /** `{ tree }` for a new evidence entry, or nothing when the tree cannot be hashed. */
  private async treeField(): Promise<{ tree?: string }> {
    const tree = await this.worktreeHash();
    return tree ? { tree } : {};
  }

  /**
   * A hash of the working tree as it stands: tracked and untracked files,
   * ignored ones left out, whatever is or is not staged. Built in a scratch
   * index seeded from a copy of the real one (its timestamp kept, so git's
   * racy-entry check still re-reads a file rewritten within the same second),
   * so the real index is untouched and only files whose stat changed are read
   * again. Untracked files over UNTRACKED_HASH_CAP are left out: hashing writes
   * each file into the object store, and a large build output or data file
   * nobody will commit would cost seconds and its size on every run. The tree
   * object stays in the object store, unreferenced, long enough for the change
   * to land.
   */
  private async worktreeHash(): Promise<string | undefined> {
    try {
      const gitDir = await this.git.gitDir();
      const dir = join(gitDir, "graft");
      await mkdir(dir, { recursive: true });
      const scratch = join(dir, `index.${process.pid}.${Date.now()}`);
      const env = { GIT_INDEX_FILE: scratch };
      // Hashing the tree writes every file's content into the object store, so
      // files that look like credentials stay out: land refuses them anyway, and
      // a secret must not reach .git/objects on the way to an evidence record.
      let secretGlobs: string[] = [];
      try {
        secretGlobs = (await readPolicy(await this.topLevel())).secretFiles ?? [];
      } catch {
        // No readable policy: the built-in patterns still apply.
      }
      const top = await this.topLevel();
      const tracked = splitNul(await this.git.run(["ls-files", "-z", "--cached"]));
      const untracked = splitNul(await this.git.run(["ls-files", "-z", "--others", "--exclude-standard"]));
      const large = await filesLargerThan(top, untracked, UNTRACKED_HASH_CAP);
      const excluded = [...new Set([...tracked, ...untracked].filter((f) => looksLikeSecretFile(f, secretGlobs)).concat(large))];
      const pathspec = [".", ...excluded.map((f) => `:(exclude,literal)${f}`)].join("\0") + "\0";
      try {
        const index = resolve(this.git.cwd, await this.git.run(["rev-parse", "--git-path", "index"]));
        try {
          await copyFile(index, scratch);
          const { atime, mtime } = await stat(index);
          await utimes(scratch, atime, mtime);
        } catch (err) {
          // No index yet (nothing staged in a new repository): start empty.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          await rm(scratch, { force: true });
        }
        await this.git.run(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: pathspec });
        return await this.git.run(["write-tree"], { env });
      } finally {
        await rm(scratch, { force: true });
      }
    } catch {
      return undefined;
    }
  }

  /**
   * The paths whose staged (index) content differs from `tree`, or null when
   * the tree is not in this repository (recorded elsewhere, or pruned).
   */
  private async changedSince(tree: string): Promise<string[] | null> {
    try {
      return splitNul(await this.git.run(["diff", "--cached", "--name-only", "-z", "--no-renames", tree]));
    } catch {
      return null;
    }
  }

  /**
   * For each rule the staged files hit, the required commands whose every
   * covering run checked content other than what is being committed: a file
   * the rule covers differs between the run's tree and the index, whether it
   * is staged or not (an unstaged edit the run saw is not in the commit). A
   * run with no recorded tree, or a tree this clone no longer has, is taken
   * as fresh: staleness is refused only when it is certain. Runs that are
   * stale for a rule are marked so, so the commit message says `stale` where
   * a reader would otherwise see `pass`.
   */
  private async staleRules(policy: Policy, staged: string[], evidence: Evidence[]): Promise<{ name: string; command: string; files: string[] }[]> {
    const commands = policy.commands ?? {};
    const stale = new Map<string, Set<string>>();
    const staleRuns = new Set<CommandEvidence>();
    const diffs = new Map<string, string[] | null>();
    const diffFor = async (tree: string) => {
      if (!diffs.has(tree)) diffs.set(tree, await this.changedSince(tree));
      return diffs.get(tree)!;
    };
    // A file that is untracked now is not being committed, and re-running cannot change that it differs:
    // counting it would leave every run stale until the file is added, deleted or ignored.
    let untracked: Set<string> | undefined;
    const isUntracked = async (f: string) => {
      untracked ??= new Set(splitNul(await this.git.run(["ls-files", "--others", "--exclude-standard", "-z"]).catch(() => "")));
      return untracked.has(f);
    };
    for (const { rule } of rulesHit(policy, staged)) {
      const covered = (f: string) =>
        rule.paths.some((g) => globToRegExp(g).test(f)) &&
        // Credential files are never hashed into a run's tree; the secrets check speaks for them.
        !looksLikeSecretFile(f, policy.secretFiles);
      for (const name of rule.require) {
        const command = commands[name];
        if (!command) continue;
        const runs = coveringRuns(evidence, name, command, { labelIsName: false });
        if (!runs.length) continue; // unmet, which the caller reports first
        let fresh = false;
        const changed = new Set<string>();
        for (const run of runs) {
          const all = run.tree ? await diffFor(run.tree) : null;
          let diff = all?.filter(covered) ?? null;
          if (diff) diff = (await Promise.all(diff.map(async (f) => ((await isUntracked(f)) ? null : f)))).filter((f): f is string => f !== null);
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

  /**
   * The landing gate: policy on evidence, then on staged files. Shared by land
   * and the commit hook. Returns the overrides that let through a change the
   * gate would otherwise have refused, so the commit can say so.
   */
  private async assertLandable(
    open: ChangeRecord,
    policy: Policy,
    staged: string[],
    opts: Pick<LandOptions, "allowNoEvidence" | "allowSecrets">,
  ): Promise<Override[]> {
    const used = new Set<Override>();
    // A refusal the caller overrode is recorded instead of thrown.
    const refuse = (override: Override, message: string) => {
      if (override === "no-evidence" ? opts.allowNoEvidence : opts.allowSecrets) used.add(override);
      else throw new GraftError(message);
    };
    if (policy.requireEvidence) {
      if (open.evidence.length === 0) {
        refuse("no-evidence", "No evidence recorded. Run `graft evidence -- <command>` or pass --allow-no-evidence.");
      } else {
        const passed = open.evidence.some((e) => e.kind === "command" && e.exitCode === 0 && !e.attested);
        if (policy.requireEvidence === "command" && !passed) {
          refuse(
            "no-evidence",
            "Policy requires a passing command that Graft or a harness ran; notes and attested runs alone do not count. " +
              "Run `graft evidence -- <command>` or pass --allow-no-evidence.",
          );
        }
      }
    }
    if (staged.length === 0) {
      throw new GraftError("Nothing staged to commit. Stage files, name paths, or pass --all.");
    }
    const unmet = evaluateRules(policy, staged, open.evidence, { labelIsName: false });
    if (unmet.length) {
      const wants = unmet.map((u) => `"${u.name}" (${u.command})`).join(" and ");
      const files = [...new Set(unmet.flatMap((u) => u.files))];
      refuse(
        "no-evidence",
        `Policy requires a passing run of ${wants} for changes to ${files.join(", ")}. ` +
          `Run graft evidence ${unmet.map((u) => u.name).join(", graft evidence ")}, or pass --allow-no-evidence.`,
      );
    }
    // Marks stale runs as a side effect, so the message is honest even when the gate is bypassed.
    const stale = await this.staleRules(policy, staged, open.evidence);
    if (stale.length) {
      const wants = stale.map((s) => `"${s.name}" (${s.command})`).join(" and ");
      const files = [...new Set(stale.flatMap((s) => s.files))];
      const unstaged = files.some((f) => !staged.includes(f)) ? " with the edits you are not committing staged or stashed" : "";
      refuse(
        "no-evidence",
        `${wants} last passed before ${files.join(", ")} changed, so the run did not check what is being committed. ` +
          `Run graft evidence ${stale.map((s) => s.name).join(", graft evidence ")} again${unstaged}, or pass --allow-no-evidence.`,
      );
    }
    const suspicious = staged.filter((p) => looksLikeSecretFile(p, policy.secretFiles));
    if (suspicious.length > 0) {
      refuse(
        "secrets",
        `Refusing to land: staged files look like credentials: ${suspicious.join(", ")}. ` +
          "Unstage them (git restore --staged <file>) or pass --allow-secrets if they are not.",
      );
    }
    return OVERRIDES.filter((o) => used.has(o));
  }

  /** Commit the staged changes with the record in trailers and a git note. */
  async land(opts: LandOptions = {}): Promise<LandedChange> {
    const open = await this.requireOpen();
    if (opts.plan) open.plan = redact(opts.plan.trim());
    const policy = await readPolicy(await this.git.topLevel());
    if (opts.paths?.length) await this.git.run(["add", "--", ...opts.paths]);
    if (opts.all) await this.git.run(["add", "-A"]);
    const staged = await this.git.stagedFiles();
    const overrides = await this.assertLandable(open, policy, staged, opts);

    if (overrides.length) open.overrides = overrides;
    else delete open.overrides;
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
   * lands like `graft land`. Merges, squashes and amends are left alone, and
   * so are the commits git makes for a rebase, cherry-pick or revert: they
   * copy commits that already exist, not the work of the open change.
   */
  async prepareCommitMessage(messageFile: string, source?: string): Promise<PrepareResult> {
    if (source === "merge" || source === "squash" || source === "commit") {
      return { applied: false, reason: `${source} commit` };
    }
    const open = await this.store.read();
    if (!open) return { applied: false, reason: "no change is open" };
    const current = await readFile(messageFile, "utf8");
    const sequencer = await this.sequencerRunning(open, current);
    if (sequencer) return { applied: false, reason: `${sequencer} in progress` };
    if (parseTrailers(current)[TRAILER_KEYS.change]) return { applied: false, reason: "message already carries a record" };
    const head = await this.git.head();
    if (head && parseTrailers(await this.git.run(["log", "-1", "--format=%B", head]))[TRAILER_KEYS.change] && (await this.amending(head))) {
      return { applied: false, reason: "amending a commit that already carries a record" };
    }
    const policy = await readPolicy(await this.git.topLevel());
    const staged = await this.git.stagedFiles();
    let overrides: Override[];
    try {
      overrides = await this.assertLandable(open, policy, staged, {
        allowNoEvidence: envFlag("GRAFT_ALLOW_NO_EVIDENCE"),
        allowSecrets: envFlag("GRAFT_ALLOW_SECRETS"),
      });
    } catch (err) {
      if (!(err instanceof GraftError)) throw err;
      throw new GraftError(
        err.message
          .replace("pass --allow-no-evidence", "set GRAFT_ALLOW_NO_EVIDENCE=1 for this commit")
          .replace("pass --allow-secrets if they are not", "set GRAFT_ALLOW_SECRETS=1 if they are not"),
      );
    }
    if (overrides.length) open.overrides = overrides;
    else delete open.overrides;
    open.landedAt = new Date().toISOString();
    open.ref ??= await this.defaultRef(policy);
    await this.foldAttempts(open);
    await this.store.write(open);
    await this.store.clearAttempts();
    const block = recordBlock(open, expandTrailers(policy.trailers ?? []).trailers).join("\n");
    // In the editor flow git strips its comment lines (the status template)
    // after this hook; keep them after the record. A message given with -m or
    // -F is kept as written, so a subject like "#42 fix the crash" is the
    // subject, not a comment.
    const lines = current.split("\n");
    const comment = source === "message" ? null : await this.commentPrefix();
    const firstComment = comment === null ? -1 : lines.findIndex((l) => l.startsWith(comment));
    const body = (firstComment === -1 ? lines : lines.slice(0, firstComment)).join("\n").replace(/\s+$/, "");
    const comments = firstComment === -1 ? "" : "\n" + lines.slice(firstComment).join("\n");
    const prefix = body ? body + "\n\n" : "\n\n";
    await writeFile(messageFile, prefix + block + "\n" + comments);
    return { applied: true, id: open.id };
  }

  /**
   * The git operation that is making this commit on the user's behalf, when
   * one is: a rebase (or `git am`), cherry-pick or revert. Their commits copy
   * existing ones, so the open change does not belong on them. A revert the
   * open change itself is about (opened by `graft revert`) is not one.
   */
  private async sequencerRunning(open: ChangeRecord, message: string): Promise<string | null> {
    const action = process.env.GIT_REFLOG_ACTION ?? "";
    for (const op of ["rebase", "cherry-pick", "revert"]) if (action.startsWith(op)) return op;
    const exists = async (name: string) => {
      try {
        await stat(resolve(this.git.cwd, await this.git.run(["rev-parse", "--git-path", name])));
        return true;
      } catch {
        return false;
      }
    };
    if ((await exists("rebase-merge")) || (await exists("rebase-apply"))) return "rebase";
    if (await exists("CHERRY_PICK_HEAD")) return "cherry-pick";
    if (!open.reverts) {
      if (await exists("REVERT_HEAD")) return "revert";
      // A revert that applies cleanly leaves no REVERT_HEAD; its message is git's own template.
      if (/^This reverts commit [0-9a-f]{40,64}\.$/m.test(message)) return "revert";
    }
    return null;
  }

  /**
   * Whether the commit being prepared amends `head`. Git tells a hook only
   * the message source, and `--amend -m` reports "message" like any commit,
   * so this asks the git process that ran the hook for its arguments, and
   * where that cannot be told (Windows, an alias) takes an author date equal
   * to HEAD's, which git reuses on amend, as the sign.
   */
  private async amending(head: string): Promise<boolean> {
    if (/amend/.test(process.env.GIT_REFLOG_ACTION ?? "")) return true;
    const argv = await invokingGitArgs();
    const sub = argv ? gitSubcommand(argv) : null;
    if (argv && sub === "commit") return argv.some((a) => /^--am(e(nd?)?)?$/.test(a));
    const date = /^@?(\d+) ([+-]\d{4})$/.exec(process.env.GIT_AUTHOR_DATE ?? "");
    if (!date) return false;
    const headDate = await this.git.run(["log", "-1", "--format=%ad", "--date=raw", head]);
    // A commit made in the same second as HEAD would match too; only an older date is a sign.
    return headDate === `${date[1]} ${date[2]}` && Date.now() / 1000 - Number(date[1]) > 2;
  }

  /** The prefix git strips as a comment in the editor flow: core.commentChar (or commentString), `#` by default and for `auto`. */
  private async commentPrefix(): Promise<string> {
    const configured = (await this.configGet("core.commentString")) ?? (await this.configGet("core.commentChar"));
    return !configured || configured === "auto" ? "#" : configured;
  }

  /**
   * The post-commit hook: when HEAD carries the open change's id, attach the
   * full record as the note and close the change. A note already on HEAD for
   * another change the message names is never replaced.
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
    if (changeIds(message).some((id) => id !== open.id)) {
      const existing = await this.rawNote(commit);
      if (existing !== null && parseRecord(existing)?.id !== open.id) {
        return { attached: false, reason: "HEAD already has a note for another change its message names" };
      }
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
   * write a starter policy file, and
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

    // Graft no longer adds the notes ref to the remote's fetch refspec: an exact
    // refspec makes every `git fetch` fail while the remote has no notes, and a
    // forced one overwrites notes this clone has not pushed. `graft sync` fetches
    // and merges them on purpose. Remove the one earlier versions wrote; any
    // other notes refspec (a wildcard the repo chose) is the repo's to keep.
    const remote = opts.remote ?? (await this.defaultRemote());
    if (remote) {
      const ours = `+${NOTES_REF}:${NOTES_REF}`;
      if ((await this.configGetAll(`remote.${remote}.fetch`)).includes(ours)) {
        // A value pattern rather than --fixed-value, which needs git 2.30.
        await this.git.run(["config", "--unset-all", `remote.${remote}.fetch`, `^${ours.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`]);
        configured.push(`remote.${remote}.fetch (removed ${ours}; graft sync fetches notes)`);
      }
    }

    let policyWritten = false;
    let policyFrom: string[] = [];
    const policyFile = join(topLevel, POLICY_PATH);
    try {
      await readFile(policyFile, "utf8");
      if (opts.force) throw Object.assign(new Error("force"), { code: "ENOENT" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await mkdir(join(topLevel, ".graft"), { recursive: true });
      const detected = await detectPolicy(topLevel);
      await writeFile(policyFile, JSON.stringify(detected.policy, null, 2) + "\n");
      policyWritten = true;
      policyFrom = detected.from;
    }
    const agents = opts.agents === false ? undefined : await writeAgentsSection(topLevel);
    const hooks = opts.hooks === false ? undefined : await installHooks(this.git, topLevel);
    const ci = opts.ci ? await writeCiWorkflow(topLevel) : undefined;
    return { topLevel, configured, policyWritten, policyFrom, remote: remote ?? undefined, agents, hooks, ci };
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
        await this.mergeNotes(theirs);
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

  /**
   * Merge another clone's notes into ours, leaving one record per commit.
   * Git's own strategies either pick a side blindly or concatenate the two
   * JSON documents into a note nothing can parse, so conflicts are resolved
   * here: the record with more evidence wins, then the later landing, then
   * ours. A note that is not a record loses to one that is.
   */
  private async mergeNotes(theirs: string): Promise<void> {
    try {
      await this.git.run(["notes", `--ref=${NOTES_REF}`, "merge", "-q", "-s", "manual", theirs]);
      return;
    } catch (err) {
      const worktree = resolve(this.git.cwd, await this.git.run(["rev-parse", "--git-path", "NOTES_MERGE_WORKTREE"]));
      let conflicts: string[];
      try {
        conflicts = (await readdir(worktree)).filter((f) => /^[0-9a-f]{40,64}$/.test(f));
      } catch {
        throw err; // not a conflict: the merge itself failed
      }
      try {
        for (const commit of conflicts) {
          const ours = await this.rawNote(commit, NOTES_REF);
          const other = await this.rawNote(commit, theirs);
          const keep = betterNote(ours, other);
          if (keep === null) await rm(join(worktree, commit), { force: true });
          else await writeFile(join(worktree, commit), keep.endsWith("\n") ? keep : keep + "\n");
        }
        await this.git.run(["notes", `--ref=${NOTES_REF}`, "merge", "--commit", "-q"]);
      } catch (inner) {
        await this.git.run(["notes", `--ref=${NOTES_REF}`, "merge", "--abort"]).catch(() => undefined);
        throw inner;
      }
    }
  }

  /** History as changes. Commits without a Graft record are included with record: null. */
  async log(opts: { limit?: number; onlyGraft?: boolean; range?: string; noMerges?: boolean } = {}): Promise<LogEntry[]> {
    if (!(await this.git.head())) return [];
    const limit = opts.limit ?? 20;
    const raw = await this.git.run([
      "log",
      ...(Number.isFinite(limit) ? [`--max-count=${limit}`] : []),
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
      "-z",
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
      // With -z the names follow the format as NUL-terminated paths, never C-quoted.
      const files = splitNul(named.replace(/^\0?\n/, ""));
      const trailers = parseTrailers(body ?? "");
      const read = await this.readRecord(commit, body ?? "", authoredAt);
      if (!read.record) unrecorded++;
      if (!read.record && !opts.all) continue;
      matched.push({ commit, title, authorName, authoredAt, trailers, files, ...read });
    }
    return fitContext(paths, matched, unrecorded, budget);
  }

  /**
   * Every recorded change with its diff, newest first, as rows a model or a
   * script can consume: the (task, diff, evidence) triples a repository has
   * accumulated. `all` adds commits without a record; `limit` bounds them.
   */
  async export(opts: { limit?: number; all?: boolean; diff?: boolean } = {}): Promise<ExportEntry[]> {
    const entries = await this.log({ limit: opts.limit ?? Infinity, onlyGraft: !opts.all });
    if (opts.diff === false) return entries;
    const out: ExportEntry[] = [];
    for (const e of entries) {
      try {
        out.push({ ...e, diff: await this.diff(e.commit) });
      } catch (err) {
        throw new GraftError(`Could not export the diff of ${e.commit.slice(0, 10)}: ${(err as Error).message || "git gave no reason"}`);
      }
    }
    return out;
  }

  /** Look up one change by id, commit SHA, or the SHA-256 of an artifact it recorded. */
  async show(ref: string): Promise<LogEntry | null> {
    if (isChangeId(ref)) {
      const raw = await this.git.run(["log", "--all", `--grep=^${TRAILER_KEYS.change}: ${ref}$`, "--format=%H"]);
      const commit = raw.split("\n")[0];
      if (!commit) return null;
      ref = commit;
    } else if (isSha256(ref)) {
      // An artifact hash; when no change recorded it, the string may still name
      // a commit (in a repository using the sha256 object format), so fall through.
      const hex = ref.replace(/^sha256:/i, "").toLowerCase();
      const raw = await this.git.run(["log", "--all", `--grep=^${TRAILER_KEYS.artifact}: sha256:${hex} `, "--format=%H"]);
      const commit = raw.split("\n")[0];
      if (commit) ref = commit;
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

  /**
   * The unified diff a commit introduced against its first parent (empty for a
   * root commit's parent side). Paths are left unescaped where git allows
   * (core.quotePath=false) and always carry the a/ and b/ prefixes, whatever
   * diff.noprefix or diff.mnemonicPrefix say, so a parser can read them. With
   * `remerge`, a merge commit's diff is against git's own re-merge of its
   * parents (git 2.36 or newer): what the merge changed beyond merging.
   */
  async diff(commit: string, opts: { remerge?: boolean } = {}): Promise<string> {
    // A generated file or a vendored dependency can make one diff far larger than git's usual output.
    return this.git.run(
      [
        "-c",
        "core.quotePath=false",
        "show",
        "--format=",
        "--no-color",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-M",
        ...(opts.remerge ? ["--remerge-diff"] : ["--root"]),
        commit,
      ],
      { maxBuffer: DIFF_MAX_BUFFER },
    );
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

  private warnedBadNote = false;

  /**
   * The record in the commit's note, or null when there is none. A note that
   * does not parse (two records concatenated by an old `graft sync`, or a
   * hand edit) is reported once on stderr, and readers fall back to the
   * commit message rather than showing nothing.
   */
  private async readNote(commit: string): Promise<ChangeRecord | null> {
    const raw = await this.rawNote(commit);
    if (raw === null) return null;
    const record = parseRecord(raw);
    if (!record && !this.warnedBadNote) {
      this.warnedBadNote = true;
      process.stderr.write(
        `graft: the note on ${commit.slice(0, 10)} in ${NOTES_REF} is not a valid change record; reading the commit message instead. ` +
          `Replace or remove it with git notes --ref=${NOTES_REF} edit/remove ${commit.slice(0, 10)}.\n`,
      );
    }
    return record;
  }

  /** The note's text on `commit` under `ref`, or null when it has none. */
  private async rawNote(commit: string, ref: string = NOTES_REF): Promise<string | null> {
    try {
      return await this.git.run(["notes", `--ref=${ref}`, "show", commit]);
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
  const model = (partial?.model ?? env.GRAFT_AUTHOR_MODEL)?.trim();
  return { kind, name, ...(model ? { model } : {}) };
}

function capOutput(s: string): string {
  if (Buffer.byteLength(s) <= EVIDENCE_OUTPUT_CAP) return s;
  return "[... truncated ...]\n" + utf8Tail(Buffer.from(s), EVIDENCE_OUTPUT_CAP);
}

/** The last `max` bytes of `buf` as text, starting on a character boundary rather than mid-character. */
function utf8Tail(buf: Buffer, max: number): string {
  let start = Math.max(0, buf.length - max);
  // Continuation bytes are 10xxxxxx; step past them to the next character's first byte.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", (err) => reject(new GraftError(`Cannot read ${path}: ${err.message}`)))
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** How much of a command's combined output runShell keeps: the tail, since that is where a failure is reported. */
export const SHELL_OUTPUT_KEEP = 64 * 1024;

/**
 * Run a shell command from `cwd`, capturing its exit code and the last
 * SHELL_OUTPUT_KEEP bytes of combined output (cut on a character boundary,
 * marked when cut), so a command that prints gigabytes does not hold them
 * all in memory. Records nothing.
 */
export function runShell(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let held = 0;
    let dropped = false;
    const keep = (c: Buffer) => {
      chunks.push(c);
      held += c.length;
      // Drop whole chunks from the front while what remains still covers the tail.
      while (chunks.length > 1 && held - chunks[0].length >= SHELL_OUTPUT_KEEP) {
        held -= chunks.shift()!.length;
        dropped = true;
      }
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (err) => resolve({ exitCode: 127, output: String(err) }));
    child.on("close", (code) => {
      const all = Buffer.concat(chunks);
      const output = dropped || all.length > SHELL_OUTPUT_KEEP ? "[... truncated ...]\n" + utf8Tail(all, SHELL_OUTPUT_KEEP) : all.toString("utf8");
      resolve({ exitCode: code ?? 1, output });
    });
  });
}

/** Untracked files bigger than this are left out of the tree hashed for each evidence run. */
export const UNTRACKED_HASH_CAP = 1024 * 1024;
/** Output allowed for one commit's diff in `export`. */
const DIFF_MAX_BUFFER = 1024 * 1024 * 1024;

/** The paths among `files` (relative to `root`) larger than `cap` bytes; ones that cannot be read are skipped. */
async function filesLargerThan(root: string, files: string[], cap: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < files.length; i += 64) {
    const batch = files.slice(i, i + 64);
    const sizes = await Promise.all(batch.map((f) => stat(join(root, f)).then((st) => st.size, () => 0)));
    batch.forEach((f, j) => {
      if (sizes[j] > cap) out.push(f);
    });
  }
  return out;
}

/** True when an environment flag is set to 1, true or yes; "0", "false" or empty leave it off. */
export function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test((env[name] ?? "").trim());
}

/** Every Graft-Change id a message names, in order. */
function changeIds(message: string): string[] {
  return [...message.matchAll(/^Graft-Change:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

/** A note's text as a change record, or null when it is not one. */
function parseRecord(raw: string): ChangeRecord | null {
  try {
    const parsed = JSON.parse(raw) as ChangeRecord;
    return parsed && typeof parsed === "object" && typeof parsed.id === "string" && Array.isArray(parsed.evidence) ? parsed : null;
  } catch {
    return null;
  }
}

/** Of two notes for one commit, the one to keep: a record over a non-record, more evidence, a later landing, then ours. */
function betterNote(ours: string | null, theirs: string | null): string | null {
  if (theirs === null) return ours;
  if (ours === null) return theirs;
  const a = parseRecord(ours);
  const b = parseRecord(theirs);
  if (!a || !b) return a || !b ? ours : theirs;
  if (a.evidence.length !== b.evidence.length) return a.evidence.length > b.evidence.length ? ours : theirs;
  return (b.landedAt ?? "") > (a.landedAt ?? "") ? theirs : ours;
}

/** The git subcommand in a git process's argv, past global options such as -C and -c. */
function gitSubcommand(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}
