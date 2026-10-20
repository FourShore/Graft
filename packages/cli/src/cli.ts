#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { AGENT_INFO, CAPTURE_AGENTS, DEFAULT_REVIEW_MODEL, Graft, GraftError, HOOK_SPECS, attemptLines, gitHooksInstalled, handleCaptureEvent, hasAgentHooks, isCaptureAgent, normalizeAgentEvent, replyFor, shellJoin, type CaptureAgent, type LogEntry } from "@fourshore/graft-core";
import type { ChangeRecord, ReviewEvidence } from "@fourshore/graft-core";
import { renderCheckGithub, renderCheckText, runCheck } from "@fourshore/graft-review";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// A reader that closes early (`graft export | head`) is not an error worth a stack trace.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const program = new Command();
program
  .name("graft")
  .description("Change records for agent-written code, stored in plain git.")
  .version(version)
  .option("-C <dir>", "run as if started in <dir>", process.cwd())
  .option("--json", "print machine-readable output");

const graft = () => new Graft(program.opts<{ C: string }>().C);
const json = () => Boolean(program.opts<{ json?: boolean }>().json);

program
  .command("init")
  .description(
    "prepare this repo: write .graft/policy.json, install the capture and git hooks, carry notes through rebases, tell agents how to use Graft in AGENTS.md",
  )
  .option("--remote <name>", "remote to configure (default: origin)")
  .option("--force", "overwrite an existing policy file")
  .option("--no-agents", "leave AGENTS.md alone")
  .option("--no-hooks", "do not install the capture hooks (agent and git)")
  .option(
    "--capture <agents>",
    `which agents get capture hooks: auto (the ones this repo or machine uses; Claude Code always), all, or a list from ${CAPTURE_AGENTS.join(", ")}`,
    "auto",
  )
  .option("--ci", "write a GitHub Actions workflow that runs graft check on every pull request")
  .action(async (o) => {
    const r = await graft().init({ remote: o.remote, force: o.force, agents: o.agents, hooks: o.hooks, ci: o.ci, capture: parseCapture(o.capture) });
    const lines = [
      r.configured.length ? `Set ${r.configured.join(", ")}` : "Git config already set",
      r.policyWritten
        ? r.policyFrom.length
          ? `Wrote .graft/policy.json with the commands ${r.policyFrom.join(" and ")} define${r.policyFrom.length === 1 ? "s" : ""}; review it and commit it`
          : "Wrote .graft/policy.json; add your test command to its commands and rules (see the README)"
        : ".graft/policy.json already exists",
    ];
    if (r.agents) {
      lines.push(r.agents.written ? "Added a Version control section to AGENTS.md; commit it" : `${r.agents.coveredBy} already covers Graft`);
      if (r.agents.claudeHint) lines.push("Claude Code reads CLAUDE.md, not AGENTS.md: add a line `@AGENTS.md` to CLAUDE.md.");
    }
    if (r.hooks) {
      const h = r.hooks;
      for (const agent of CAPTURE_AGENTS) {
        const state = h.agents[agent];
        if (!state) continue;
        const file = HOOK_SPECS[agent].file;
        const title = AGENT_INFO[agent].title;
        lines.push(
          state === "written"
            ? `Added ${title} capture hooks to ${file} (prompt opens a change, test/build/lint runs become evidence); commit it`
            : state === "present"
              ? `${file} already has the ${title} capture hooks`
              : `${file} is not valid JSON; ${title} capture hooks not added`,
        );
      }
      const skipped = CAPTURE_AGENTS.filter((a) => !h.agents[a]);
      if (skipped.length) lines.push(`No hooks written for ${skipped.map((a) => AGENT_INFO[a].title).join(", ")}; pass --capture all or --capture ${skipped[0]} to add them.`);
      const gitHooks = Object.entries(h.git);
      const foreign = gitHooks.filter(([, state]) => state === "foreign").map(([name]) => name);
      const written = gitHooks.filter(([, state]) => state === "written").map(([name]) => name);
      // Only prepare-commit-msg puts the record on a plain commit; with it foreign, the other hooks alone do not.
      const carries = h.git["prepare-commit-msg"] !== "foreign";
      if (written.length) lines.push(`Installed git hooks ${written.join(", ")} in ${h.hooksDir}${carries ? ", so a plain git commit carries the record" : ""}`);
      else if (!foreign.length) lines.push("Git hooks already installed");
      if (foreign.length) {
        lines.push(
          `Left ${foreign.join(" and ")} alone in ${h.hooksDir}: another hook is there. Add \`graft hook <name> "$@"\` to it yourself` +
            (carries ? "." : ", or a plain git commit carries no record."),
        );
      }
      lines.push("The hooks run `graft`, so it must be on PATH for the agent and for git.");
    }
    if (r.ci) {
      lines.push(
        r.ci.state === "written"
          ? `Wrote ${r.ci.path}; add your install step to it and commit it`
          : `${r.ci.path} already exists; left alone`,
      );
    }
    if (!r.remote) lines.push("No remote yet; run `graft init` again after `git remote add`.");
    out(r, lines.join("\n"));
  });

program
  .command("sync")
  .description("fetch, merge and push change records (refs/notes/graft) with the remote")
  .option("--remote <name>", "remote to sync with (default: origin)")
  .option("--no-push", "fetch and merge only")
  .action(async (o) => {
    const r = await graft().sync({ remote: o.remote, push: o.push });
    if (r.pushError) {
      console.error(`warning: could not push ${"refs/notes/graft"} to ${r.remote}; records stay local until a sync from a clone that can push.\n  ${r.pushError}`);
    }
    out(
      r,
      `${r.remote}: ${r.fetched ? "fetched" : "nothing to fetch"}${r.merged ? ", merged" : ""}${r.pushed ? ", pushed" : r.pushError ? ", push refused" : ""}`,
    );
  });

program
  .command("start")
  .description("open a change: record what you were asked to do")
  .argument("<task...>", "the task, in your own words")
  .option("--plan <plan>", "how you intend to do it")
  .option("--ref <ref>", "where the task came from: the thread, issue or ticket URL (default: the policy's ref template)")
  .option("--id <id>", "reuse an existing change id, so one change lands in several repositories")
  .option("--author <name>", "who is doing the work (default: from environment)")
  .option("--human", "mark the author as a human rather than an agent")
  .option("--replace", "abandon a change another session left open (its attempt is kept), then start this one")
  .action(async (task: string[], o) => {
    const record = await graft().start({
      task: task.join(" "),
      plan: o.plan,
      ref: o.ref,
      id: o.id,
      author: { name: o.author, kind: o.human ? "human" : undefined },
      replace: o.replace,
    });
    out(record, `Opened change ${record.id}\n  task: ${record.task}`);
  });

program
  .command("plan")
  .description("set or replace the plan for the open change")
  .argument("<plan...>")
  .action(async (plan: string[]) => {
    const record = await graft().setPlan(plan.join(" "));
    out(record, `Plan recorded for ${record.id}`);
  });

program
  .command("evidence")
  .description("run a command (or a policy command or review by name) and record its result, attach a run you already made, or record a note")
  .option("--label <label>", "what this evidence shows, e.g. 'unit tests'")
  .option("--note <text>", "record a note instead of running a command")
  .option("--attach", "do not run the command; record it as a run you already made, marked attested")
  .option("--exit <code>", "with --attach: the exit code of your run (default 0)")
  .option("--output-file <path>", "with --attach: a file holding your run's output (last 4 KB kept)")
  .argument("[command...]", "a name from the policy's commands or reviews, or a command to run (put -- before it)")
  .action(async (command: string[], o) => {
    const g = graft();
    if (o.note) {
      const ev = await g.evidenceNote(o.note, o.label);
      out(ev, `Recorded note${o.label ? ` (${o.label})` : ""}`);
      return;
    }
    if (!command.length) {
      const names = [...Object.keys(await g.catalog()), ...Object.keys(await g.reviews())];
      throw new GraftError(
        names.length
          ? `Give a policy command or review by name (${names.join(", ")}), a command after --, or use --note.`
          : "Give a command after --, or use --note.",
      );
    }
    if (command.length === 1 && (await g.reviews())[command[0]]) {
      if (o.attach) throw new GraftError(`"${command[0]}" is a review, which Graft runs itself; it cannot be attached as a run you made.`);
      const ev = await g.evidenceReview(command[0], o.label);
      out(ev, formatReview(ev));
      if (ev.verdict !== "approve") process.exitCode = 1;
      return;
    }
    if (command.length === 1 && (await g.catalog())[command[0]]) {
      if (o.attach) {
        const exitCode = o.exit === undefined ? 0 : Number(o.exit);
        if (!Number.isInteger(exitCode)) throw new GraftError(`--exit must be an integer, got ${o.exit}.`);
        const output = o.outputFile ? await readFile(o.outputFile, "utf8") : "";
        const ev = await g.evidenceNamed(command[0], o.label, { exitCode, output });
        if (ev.kind === "command") out(ev, `Recorded ${command[0]} as attested: ${ev.command} -> exit ${exitCode}`);
        return;
      }
      const ev = await g.evidenceNamed(command[0], o.label);
      if (ev.kind === "command") {
        process.stdout.write(ev.output);
        if (ev.output && !ev.output.endsWith("\n")) process.stdout.write("\n");
        out(ev, `Recorded ${command[0]}: ${ev.command} -> exit ${ev.exitCode} (${ev.durationMs} ms)`, true);
        if (ev.exitCode !== 0) process.exitCode = ev.exitCode;
      }
      return;
    }
    // One bare word is meant as a policy name far more often than as a program (a typo such as `graft evidence tset` should not run tset).
    if (command.length === 1 && /^[\w:.-]+$/.test(command[0]) && !process.argv.includes("--")) {
      const names = [...Object.keys(await g.catalog()), ...Object.keys(await g.reviews())];
      throw new GraftError(
        `No policy command or review is named ${command[0]}${names.length ? ` (the policy names ${names.join(", ")})` : ""}. ` +
          `To run ${command[0]} as a command, put -- before it: graft evidence -- ${command[0]}`,
      );
    }
    const cmd = shellJoin(command);
    if (o.attach) {
      const exitCode = o.exit === undefined ? 0 : Number(o.exit);
      if (!Number.isInteger(exitCode)) throw new GraftError(`--exit must be an integer, got ${o.exit}.`);
      const output = o.outputFile ? await readFile(o.outputFile, "utf8") : "";
      const ev = await g.evidenceAttested(cmd, exitCode, output, o.label);
      out(ev, `Recorded as attested: ${cmd} -> exit ${exitCode}`);
      return;
    }
    if (o.exit !== undefined || o.outputFile) throw new GraftError("--exit and --output-file go with --attach.");
    const ev = await g.evidenceCommand(cmd, o.label);
    if (ev.kind === "command") {
      process.stdout.write(ev.output);
      if (ev.output && !ev.output.endsWith("\n")) process.stdout.write("\n");
      out(ev, `Recorded: ${cmd} -> exit ${ev.exitCode} (${ev.durationMs} ms)`, true);
      if (ev.exitCode !== 0) process.exitCode = ev.exitCode;
    }
  });

program
  .command("land")
  .description("commit the staged changes (or the named paths) with the record attached")
  .argument("[paths...]", "files to stage before committing")
  .option("-m, --title <title>", "commit title (default: the task)")
  .option("-a, --all", "stage all changes first")
  .option("--plan <plan>", "final plan")
  .option("--allow-no-evidence", "land even though the evidence the policy asks for is missing (recorded as Graft-Override)")
  .option("--allow-secrets", "land even though a staged file looks like a credential")
  .option("--trailer <trailer>", "extra commit trailer 'Key: value' (repeatable)", (v: string, all: string[]) => [...all, v], [])
  .action(async (paths: string[], o) => {
    const { record, commit, skippedTrailers } = await graft().land({
      title: o.title,
      all: o.all,
      paths,
      plan: o.plan,
      allowNoEvidence: o.allowNoEvidence,
      allowSecrets: o.allowSecrets,
      trailers: o.trailer,
    });
    const skipped = skippedTrailers.map((t) => `\nLeft out policy trailer '${t.trailer}': $${t.missing} is not set.`).join("");
    const overrides = record.overrides?.length ? `\nRecorded Graft-Override: ${record.overrides.join(", ")}; graft check shows it on the pull request.` : "";
    out({ record, commit, skippedTrailers }, `Landed ${record.id} as ${commit.slice(0, 10)}${skipped}${overrides}`);
  });

program
  .command("hook")
  .description(`entry points for the hooks graft init installs: an agent's hook (${CAPTURE_AGENTS.join(", ")}; stdin JSON), prepare-commit-msg <file> [source], commit-msg <file>, post-commit`)
  .argument("<kind>", `${CAPTURE_AGENTS.join(" | ")} | prepare-commit-msg | commit-msg | post-commit`)
  .argument("[args...]", "what git passes the hook")
  .option("--plugin", "the hook is the Claude Code plugin's: step aside when the repo's own hook file already runs graft")
  .action(async (kind: string, args: string[], o: { plugin?: boolean }) => {
    if (isCaptureAgent(kind)) {
      // Never break the agent's session: swallow everything, exit 0.
      let payload: unknown;
      try {
        payload = JSON.parse(await readStdin());
        const g = graft();
        if (o.plugin) {
          // The plugin follows the user into every repo. One that is not set up for Graft has no gate to land what the hook
          // would record, so the change would sit open for good, with the prompt in .git; and where the repo's own hooks
          // run graft, the plugin's copy would record every run twice. In both the repo's state wins.
          const top = await g.git.topLevel();
          const reason = (await hasAgentHooks(top, kind))
            ? "the repo's own hooks run graft"
            : !(await g.isSetUp())
              ? "this repo is not set up for Graft (no .graft/policy.json and no git hooks); run graft init"
              : null;
          if (reason) {
            const outcome = { action: "ignored" as const, reason };
            if (json()) console.log(JSON.stringify(outcome));
            else {
              const reply = replyFor(kind, payload, outcome);
              if (reply) console.log(reply);
            }
            return;
          }
        }
        const outcome = await handleCaptureEvent(g, kind, normalizeAgentEvent(kind, payload));
        if (json()) console.log(JSON.stringify(outcome));
        else {
          // The agent reads this from stdout: a note for its context, or the answer its prompt hook must give.
          const reply = replyFor(kind, payload, outcome);
          if (reply) console.log(reply);
        }
      } catch (err) {
        process.stderr.write(`graft hook: ${err instanceof Error ? err.message : String(err)}\n`);
        const reply = replyFor(kind, payload, { action: "ignored", reason: "error" });
        if (reply && !json()) console.log(reply);
      }
      return;
    }
    if (kind === "prepare-commit-msg") {
      const [file, source] = args;
      if (!file) throw new GraftError("prepare-commit-msg needs the message file git passes it.");
      const r = await graft().prepareCommitMessage(file, source);
      if (r.applied) process.stderr.write(`graft: added change ${r.id} to the commit message\n`);
      else if (r.reason === "no change is open") {
        process.stderr.write('graft: no change is open, so this commit carries no record (graft check fails a behavior change without one). Run graft start "<task>" first.\n');
      }
      return;
    }
    if (kind === "commit-msg") {
      const [file] = args;
      if (!file) throw new GraftError("commit-msg needs the message file git passes it.");
      await graft().checkCommitMessage(file);
      return;
    }
    if (kind === "post-commit") {
      const r = await graft().finishCommit();
      if (r.attached) console.log(`graft: recorded change ${r.id} on ${r.commit?.slice(0, 10)}`);
      return;
    }
    throw new GraftError(`Unknown hook '${kind}'. Expected ${CAPTURE_AGENTS.join(", ")}, prepare-commit-msg, commit-msg or post-commit.`);
  });

program
  .command("abandon")
  .description("close the open change without committing; what it tried is kept and lands with the next change as a Tried: block")
  .option("--reason <why>", "why it is being abandoned, kept with the attempt")
  .option("--discard", "keep nothing: the attempt is not carried into the next land")
  .action(async (o) => {
    const g = graft();
    const record = await g.abandon({ reason: o.reason, discard: o.discard });
    if (!record) {
      out(record, "No change was open.");
      return;
    }
    const kept = (await g.attempts()).some((a) => a.id === record.id);
    out(record, `Abandoned ${record.id}${kept ? "; kept as an attempt for the next land" : o.discard ? "" : " (nothing to keep: no plan, reason or evidence)"}`);
  });

program
  .command("revert")
  .description("open a change that undoes a landed one: git revert --no-commit, with a record naming what it reverts and why; then record evidence and land")
  .argument("<ref>", "a change id or commit")
  .option("--reason <why>", "why it is being reverted; becomes the plan")
  .option("--author <name>", "who is doing the work (default: from environment)")
  .option("--human", "mark the author as a human rather than an agent")
  .action(async (ref: string, o) => {
    const r = await graft().revert(ref, { reason: o.reason, author: { name: o.author, kind: o.human ? "human" : undefined } });
    out(r, `Reverted ${r.commit.slice(0, 10)} "${r.title}" in the working tree and opened change ${r.record.id}.\nRecord evidence, then graft land -a.`);
  });

program
  .command("status")
  .description("show the open change")
  .action(async () => {
    const g = graft();
    const record = await g.status();
    const names = Object.entries(await g.catalog());
    const commands = names.length ? `\ncommands: ${names.map(([n, c]) => `${n} (${c})`).join(", ")}` : "";
    const reviewNames = Object.entries(await g.reviews());
    const reviews = reviewNames.length ? `\nreviews: ${reviewNames.map(([n, s]) => `${n} (${s.command ? "command" : (s.model ?? DEFAULT_REVIEW_MODEL)}${s.differentModel ? ", not the author's model" : ""})`).join(", ")}` : "";
    const waiting = await g.attempts();
    const attempts = waiting.length ? `\nattempts waiting for the next land: ${waiting.map((a) => `${a.id} (${a.reason ?? a.task})`).join(", ")}` : "";
    const gitHooks = await gitHooksInstalled(g.git);
    const hooks = gitHooks
      ? "\ngit hooks: installed, so a plain git commit carries the record"
      : "\ngit hooks: not installed in this clone; commit with graft land, or run graft init to install them";
    out({ open: record, commands: await g.catalog(), reviews: await g.reviews(), attempts: waiting, gitHooks }, (record ? formatRecord(record) : "No change is open.") + commands + reviews + attempts + hooks);
  });

program
  .command("log")
  .description("history as changes: intent and evidence, not just diffs")
  .option("-n, --limit <n>", "number of commits", "20")
  .option("--all", "include commits without a change record")
  .action(async (o) => {
    const entries = await graft().log({ limit: positiveInt(o.limit, "--limit"), onlyGraft: !o.all });
    out(entries, entries.map(formatEntry).join("\n\n") || "No changes yet.");
  });

program
  .command("context")
  .description("what you should know before editing these paths: the changes that touched them, trimmed to fit a prompt")
  .argument("[paths...]", "files or directories (default: the whole repository)")
  .option("-n, --limit <n>", "number of commits to scan", "50")
  .option("--budget <chars>", "characters of text to stay within", "8000")
  .option("--all", "include commits without a change record")
  .action(async (paths: string[], o) => {
    const result = await graft().context(paths, { limit: positiveInt(o.limit, "--limit"), budget: positiveInt(o.budget, "--budget"), all: Boolean(o.all) });
    out(result, result.text);
  });

program
  .command("check")
  .description("verify a branch's records like a reviewer at merge time: every behavior change needs evidence that meets the policy; --rerun runs the recorded commands again here")
  .option("--base <ref>", "commits in <ref>..HEAD are checked (default: origin/main, else origin/master)")
  .option("--rerun", "re-run the recorded passing commands the policy allows once on this checkout and fail if any fails")
  .option("--format <fmt>", "text | github (annotations and a step summary)", "text")
  .option("--summary-file <path>", "with --format github, also write the Markdown summary to this file (the action posts it as a PR comment)")
  .option("-n, --limit <n>", "most commits to examine", "200")
  .action(async (o) => {
    const repo = program.opts<{ C: string }>().C;
    const base = o.base ?? (await defaultBase(repo));
    const r = await runCheck({ repo, base, rerun: Boolean(o.rerun), limit: Number(o.limit) });
    if (o.format === "github") {
      const gh = renderCheckGithub(r);
      for (const a of gh.annotations) console.log(a);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, gh.summary);
      if (o.summaryFile) await writeFile(o.summaryFile, gh.summary);
      // The text carries re-run output and commit titles, which are not ours: stop the runner reading workflow commands in it.
      const token = randomBytes(16).toString("hex");
      console.log(`::stop-commands::${token}`);
      console.log(renderCheckText(r));
      console.log(`::${token}::`);
    } else {
      out(r, renderCheckText(r));
    }
    if (!r.ok) process.exitCode = 1;
  });

program
  .command("artifact")
  .description("record a file this change produced, by SHA-256, so a build found in the field resolves to its change (graft show <sha256>)")
  .argument("[path]", "the file to hash")
  .option("--sha256 <hex>", "the hash, for a file that is not here (with --name)")
  .option("--name <name>", "the file name to record (default: the path's base name)")
  .action(async (path: string | undefined, o) => {
    const a = await graft().recordArtifact({ path, sha256: o.sha256, name: o.name });
    out(a, `Recorded artifact ${a.name} sha256:${a.sha256}`);
  });

program
  .command("export")
  .description("every recorded change with its diff, newest first, as JSON lines: the (task, diff, evidence) rows this repository has accumulated")
  .option("-n, --limit <n>", "most commits to export (default: all)")
  .option("--all", "include commits without a change record")
  .option("--no-diff", "leave the diff out")
  .action(async (o) => {
    const limit = o.limit === undefined ? Infinity : Number(o.limit);
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new GraftError(`--limit must be a positive integer, got ${o.limit}.`);
    const rows = await graft().export({ limit, all: Boolean(o.all), diff: o.diff });
    for (const row of rows) process.stdout.write(JSON.stringify(row) + "\n");
  });

program
  .command("show")
  .description("show one change by id, commit, or the SHA-256 of an artifact it recorded")
  .argument("<ref>")
  .action(async (ref: string) => {
    const entry = await graft().show(ref);
    if (!entry) throw new GraftError(`No change found for ${ref}.`);
    out(entry, entry.record && entry.recordSource === "note" ? formatRecord(entry.record) : formatEntry(entry));
  });

async function defaultBase(repo: string): Promise<string> {
  const g = new Graft(repo);
  // Not @{upstream}: for a pushed feature branch that is the branch itself, and the check would see no commits.
  for (const candidate of ["origin/main", "origin/master"]) {
    try {
      await g.git.run(["rev-parse", "--verify", "-q", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new GraftError("No base found (neither origin/main nor origin/master exists): pass --base <ref>, the branch this one will merge into.");
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new GraftError(`${flag} must be a positive integer, got ${value}.`);
  return n;
}

function out(data: unknown, text: string, textAlways = false): void {
  if (json()) console.log(JSON.stringify(data, null, 2));
  if (!json() || textAlways) console.log(text);
}

function formatEntry(e: LogEntry): string {
  const head = `${e.commit.slice(0, 10)}  ${e.title}`;
  if (!e.record) {
    const t = e.trailers;
    return t["Graft-Change"]
      ? `${head}\n  change: ${t["Graft-Change"]} (note missing)\n  author: ${t["Graft-Author"] ?? "?"}\n  evidence: ${t["Graft-Evidence"] ?? "?"}`
      : `${head}\n  (no change record)`;
  }
  const from = e.recordSource === "message" ? "\n  (note missing; rebuilt from the commit message, output not available)" : "";
  return `${head}\n${indent(formatRecord(e.record))}${from}`;
}

function formatRecord(r: ChangeRecord): string {
  const lines = [
    `change: ${r.id}`,
    `task:   ${r.task}`,
    ...(r.ref ? [`ref:    ${r.ref}`] : []),
    ...(r.reverts ? [`reverts: ${r.reverts}`] : []),
    ...(r.artifacts ?? []).map((a) => `artifact: ${a.name} sha256:${a.sha256}`),
    `author: ${r.author.kind}:${r.author.name}${r.author.model ? ` (${r.author.model})` : ""}`,
    ...(r.overrides?.length ? [`override: ${r.overrides.join(", ")} (landed past the gate)`] : []),
  ];
  if (r.plan) lines.push(`plan:   ${r.plan.split("\n").join("\n        ")}`);
  if (r.attempts?.length) lines.push(`tried:  ${attemptLines(r.attempts).map((l) => l.trim()).join("\n        ")}`);
  lines.push(`evidence: ${r.evidence.length ? "" : "none"}`);
  for (const ev of r.evidence) {
    lines.push(
      ev.kind === "command"
        ? `  ${ev.attested ? (ev.exitCode === 0 ? "attested" : `ATTESTED FAIL ${ev.exitCode}`) : ev.exitCode !== 0 ? "FAIL" : ev.stale ? "stale" : "pass"}  ${ev.command}${tag(ev.name, ev.label)}`
        : ev.kind === "review"
          ? `  ${ev.stale ? "stale review" : ev.verdict === "approve" ? "approved" : "CHANGES REQUESTED"}  ${ev.model}${tag(ev.name, ev.label)} (prompt ${ev.promptSha256.slice(0, 8)}; ${ev.findings.length} finding${ev.findings.length === 1 ? "" : "s"})${ev.summary ? `\n        ${ev.summary}` : ""}`
          : `  note  ${ev.text}${ev.label ? `  [${ev.label}]` : ""}`,
    );
  }
  return lines.join("\n");
}

/** A review as `graft evidence <name>` prints it: the verdict, the summary and every finding. */
function formatReview(ev: ReviewEvidence): string {
  const lines = [`${ev.verdict === "approve" ? "Approved" : "Changes requested"} by ${ev.model} (review ${ev.name ?? ""}, prompt ${ev.promptSha256.slice(0, 8)}, ${(ev.durationMs / 1000).toFixed(1)}s)`];
  if (ev.summary) lines.push(`  ${ev.summary}`);
  for (const f of ev.findings) lines.push(`  ${f.severity}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f.text}`);
  return lines.join("\n");
}

function tag(name?: string, label?: string): string {
  const shown = name && label && label !== name ? `${name}: ${label}` : (name ?? label);
  return shown ? `  [${shown}]` : "";
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`graft: ${msg}`);
  process.exit(1);
});

/** `--capture auto|all|<agent,...>` as init takes it. */
function parseCapture(value: string): CaptureAgent[] | "auto" | "all" {
  const v = value.trim().toLowerCase();
  if (v === "auto" || v === "all") return v;
  const agents = v.split(/[,\s]+/).filter(Boolean);
  const bad = agents.filter((a) => !isCaptureAgent(a));
  if (bad.length) throw new GraftError(`Unknown agent${bad.length > 1 ? "s" : ""} for --capture: ${bad.join(", ")}. Expected auto, all, or any of ${CAPTURE_AGENTS.join(", ")}.`);
  return agents as CaptureAgent[];
}
