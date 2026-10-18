#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { Graft, GraftError, attemptLines, gitHooksInstalled, handleClaudeCodeEvent, shellJoin, type ClaudeCodeEvent, type LogEntry } from "@fourshore/graft-core";
import type { ChangeRecord } from "@fourshore/graft-core";
import { renderCheckGithub, renderCheckText, runCheck } from "@fourshore/graft-review";
import { createRequire } from "node:module";
import { appendFile } from "node:fs/promises";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

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
    "prepare this repo: carry notes through rebases, fetch them from the remote, write .graft/policy.json, tell agents how to use Graft in AGENTS.md",
  )
  .option("--remote <name>", "remote to configure (default: origin)")
  .option("--force", "overwrite an existing policy file")
  .option("--no-agents", "leave AGENTS.md alone")
  .option("--no-hooks", "do not install the Claude Code and git capture hooks")
  .option("--ci", "write a GitHub Actions workflow that runs graft check on every pull request")
  .action(async (o) => {
    const r = await graft().init({ remote: o.remote, force: o.force, agents: o.agents, hooks: o.hooks, ci: o.ci });
    const lines = [
      r.configured.length ? `Set ${r.configured.join(", ")}` : "Git config already set",
      r.policyWritten ? `Wrote .graft/policy.json` : ".graft/policy.json already exists",
    ];
    if (r.agents) {
      lines.push(r.agents.written ? "Added a Version control section to AGENTS.md; commit it" : `${r.agents.coveredBy} already covers Graft`);
      if (r.agents.claudeHint) lines.push("Claude Code reads CLAUDE.md, not AGENTS.md: add a line `@AGENTS.md` to CLAUDE.md.");
    }
    if (r.hooks) {
      const h = r.hooks;
      lines.push(
        h.claudeCode === "written"
          ? "Added capture hooks to .claude/settings.json (prompt opens a change, test/build/lint runs become evidence); commit it"
          : h.claudeCode === "present"
            ? ".claude/settings.json already has the capture hooks"
            : ".claude/settings.json is not valid JSON; capture hooks not added",
      );
      const gitHooks = Object.entries(h.git);
      const foreign = gitHooks.filter(([, state]) => state === "foreign").map(([name]) => name);
      const written = gitHooks.filter(([, state]) => state === "written").map(([name]) => name);
      if (written.length) lines.push(`Installed git hooks ${written.join(", ")} in ${h.hooksDir}, so a plain git commit carries the record`);
      else if (!foreign.length) lines.push("Git hooks already installed");
      if (foreign.length) lines.push(`Left ${foreign.join(" and ")} alone in ${h.hooksDir}: another hook is there. Add \`graft hook <name> "$@"\` to it yourself.`);
      lines.push("The hooks run `graft`, so it must be on PATH for Claude Code and git.");
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
  .description("run a command (or a policy command by name) and record its result, attach a run you already made, or record a note")
  .option("--label <label>", "what this evidence shows, e.g. 'unit tests'")
  .option("--note <text>", "record a note instead of running a command")
  .option("--attach", "do not run the command; record it as a run you already made, marked attested")
  .option("--exit <code>", "with --attach: the exit code of your run (default 0)")
  .option("--output-file <path>", "with --attach: a file holding your run's output (last 4 KB kept)")
  .argument("[command...]", "a name from the policy's commands, or a command to run (put -- before it)")
  .action(async (command: string[], o) => {
    const g = graft();
    if (o.note) {
      const ev = await g.evidenceNote(o.note, o.label);
      out(ev, `Recorded note${o.label ? ` (${o.label})` : ""}`);
      return;
    }
    if (!command.length) {
      const names = Object.entries(await g.catalog());
      throw new GraftError(
        names.length
          ? `Give a policy command by name (${names.map(([n]) => n).join(", ")}), a command after --, or use --note.`
          : "Give a command after --, or use --note.",
      );
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
  .description("entry points for the hooks graft init installs: claude-code (stdin JSON), prepare-commit-msg <file> [source], post-commit")
  .argument("<kind>", "claude-code | prepare-commit-msg | post-commit")
  .argument("[args...]", "what git passes the hook")
  .action(async (kind: string, args: string[]) => {
    if (kind === "claude-code") {
      // Never break the agent's session: swallow everything, exit 0.
      try {
        const raw = await readStdin();
        const event = JSON.parse(raw) as ClaudeCodeEvent;
        const outcome = await handleClaudeCodeEvent(graft(), event);
        if (json()) console.log(JSON.stringify(outcome));
      } catch (err) {
        process.stderr.write(`graft hook: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return;
    }
    if (kind === "prepare-commit-msg") {
      const [file, source] = args;
      if (!file) throw new GraftError("prepare-commit-msg needs the message file git passes it.");
      const r = await graft().prepareCommitMessage(file, source);
      if (r.applied) process.stderr.write(`graft: added change ${r.id} to the commit message\n`);
      return;
    }
    if (kind === "post-commit") {
      const r = await graft().finishCommit();
      if (r.attached) console.log(`graft: recorded change ${r.id} on ${r.commit?.slice(0, 10)}`);
      return;
    }
    throw new GraftError(`Unknown hook '${kind}'. Expected claude-code, prepare-commit-msg or post-commit.`);
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
    const waiting = await g.attempts();
    const attempts = waiting.length ? `\nattempts waiting for the next land: ${waiting.map((a) => `${a.id} (${a.reason ?? a.task})`).join(", ")}` : "";
    const gitHooks = await gitHooksInstalled(g.git);
    const hooks = gitHooks
      ? "\ngit hooks: installed, so a plain git commit carries the record"
      : "\ngit hooks: not installed in this clone; commit with graft land, or run graft init to install them";
    out({ open: record, commands: await g.catalog(), attempts: waiting, gitHooks }, (record ? formatRecord(record) : "No change is open.") + commands + attempts + hooks);
  });

program
  .command("log")
  .description("history as changes: intent and evidence, not just diffs")
  .option("-n, --limit <n>", "number of commits", "20")
  .option("--all", "include commits without a change record")
  .action(async (o) => {
    const entries = await graft().log({ limit: Number(o.limit), onlyGraft: !o.all });
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
    const result = await graft().context(paths, { limit: Number(o.limit), budget: Number(o.budget), all: Boolean(o.all) });
    out(result, result.text);
  });

program
  .command("check")
  .description("verify a branch's records like a reviewer at merge time: every behavior change needs evidence that meets the policy; --rerun runs the recorded commands again here")
  .option("--base <ref>", "commits in <ref>..HEAD are checked (default: origin/main, or the upstream of HEAD)")
  .option("--rerun", "re-run every recorded passing command once on this checkout and fail if any fails")
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
      console.log(renderCheckText(r));
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
  for (const candidate of ["origin/main", "origin/master", "@{upstream}"]) {
    try {
      await g.git.run(["rev-parse", "--verify", "-q", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new GraftError("No base found: pass --base <ref> (the branch this one will merge into).");
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
        : `  note  ${ev.text}${ev.label ? `  [${ev.label}]` : ""}`,
    );
  }
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
