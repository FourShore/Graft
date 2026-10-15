#!/usr/bin/env node
import { Command } from "commander";
import { Graft, GraftError, type LogEntry } from "@fourshore/graft-core";
import type { ChangeRecord } from "@fourshore/graft-core";
import { createReviewServer } from "@fourshore/graft-review";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

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
  .description("prepare this repo: carry notes through rebases, fetch them from the remote, write .graft/policy.json")
  .option("--remote <name>", "remote to configure (default: origin)")
  .option("--force", "overwrite an existing policy file")
  .action(async (o) => {
    const r = await graft().init({ remote: o.remote, force: o.force });
    const lines = [
      r.configured.length ? `Set ${r.configured.join(", ")}` : "Git config already set",
      r.policyWritten ? `Wrote .graft/policy.json` : ".graft/policy.json already exists",
    ];
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
    out(
      r,
      `${r.remote}: ${r.fetched ? "fetched" : "nothing to fetch"}${r.merged ? ", merged" : ""}${r.pushed ? ", pushed" : ""}`,
    );
  });

program
  .command("start")
  .description("open a change: record what you were asked to do")
  .argument("<task...>", "the task, in your own words")
  .option("--plan <plan>", "how you intend to do it")
  .option("--author <name>", "who is doing the work (default: from environment)")
  .option("--model <model>", "model id, when the author is an agent")
  .option("--human", "mark the author as a human rather than an agent")
  .action(async (task: string[], o) => {
    const record = await graft().start({
      task: task.join(" "),
      plan: o.plan,
      author: { name: o.author, model: o.model, kind: o.human ? "human" : undefined },
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
  .description("run a command and record its result, or record a note")
  .option("--label <label>", "what this evidence shows, e.g. 'unit tests'")
  .option("--note <text>", "record a note instead of running a command")
  .argument("[command...]", "command to run (put -- before it)")
  .action(async (command: string[], o) => {
    const g = graft();
    if (o.note) {
      const ev = await g.evidenceNote(o.note, o.label);
      out(ev, `Recorded note${o.label ? ` (${o.label})` : ""}`);
      return;
    }
    if (!command.length) throw new GraftError("Give a command after --, or use --note.");
    const cmd = command.join(" ");
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
  .option("--allow-no-evidence", "land even though nothing was verified")
  .option("--allow-secrets", "land even though a staged file looks like a credential")
  .action(async (paths: string[], o) => {
    const { record, commit } = await graft().land({
      title: o.title,
      all: o.all,
      paths,
      plan: o.plan,
      allowNoEvidence: o.allowNoEvidence,
      allowSecrets: o.allowSecrets,
    });
    out({ record, commit }, `Landed ${record.id} as ${commit.slice(0, 10)}`);
  });

program
  .command("abandon")
  .description("drop the open change without committing")
  .action(async () => {
    const record = await graft().abandon();
    out(record, record ? `Abandoned ${record.id}` : "No change was open.");
  });

program
  .command("status")
  .description("show the open change")
  .action(async () => {
    const record = await graft().status();
    out(record, record ? formatRecord(record) : "No change is open.");
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
  .command("review")
  .description("open a local web view: changes ranked by risk, claim first, then the diff")
  .option("-p, --port <port>", "port to listen on (default: 7777, 0 for any)", "7777")
  .option("-n, --limit <n>", "number of commits to show", "50")
  .option("--only-recorded", "hide commits that have no change record")
  .action(async (o) => {
    const repo = program.opts<{ C: string }>().C;
    const server = createReviewServer({ repo, limit: Number(o.limit), includeUnrecorded: !o.onlyRecorded });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(o.port), "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    console.log(`Graft review: http://127.0.0.1:${port}/  (Ctrl-C to stop)`);
    await new Promise<void>((resolve) => {
      const stop = () => server.close(() => resolve());
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  });

program
  .command("show")
  .description("show one change by id or commit")
  .argument("<ref>")
  .action(async (ref: string) => {
    const entry = await graft().show(ref);
    if (!entry) throw new GraftError(`No change found for ${ref}.`);
    out(entry, entry.record ? formatRecord(entry.record) : formatEntry(entry));
  });

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
  return `${head}\n${indent(formatRecord(e.record))}`;
}

function formatRecord(r: ChangeRecord): string {
  const lines = [
    `change: ${r.id}`,
    `task:   ${r.task}`,
    `author: ${r.author.kind}:${r.author.name}${r.author.model ? ` (${r.author.model})` : ""}`,
  ];
  if (r.plan) lines.push(`plan:   ${r.plan.split("\n").join("\n        ")}`);
  lines.push(`evidence: ${r.evidence.length ? "" : "none"}`);
  for (const ev of r.evidence) {
    lines.push(
      ev.kind === "command"
        ? `  ${ev.exitCode === 0 ? "pass" : "FAIL"}  ${ev.command}${ev.label ? `  [${ev.label}]` : ""}`
        : `  note  ${ev.text}${ev.label ? `  [${ev.label}]` : ""}`,
    );
  }
  return lines.join("\n");
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
