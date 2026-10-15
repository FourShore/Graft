#!/usr/bin/env node
import { Command } from "commander";
import { Graft, GraftError, type LogEntry } from "./graft.js";
import type { ChangeRecord } from "./record.js";

const program = new Command();
program
  .name("graft")
  .description("Change records for agent-written code, stored in plain git.")
  .option("-C <dir>", "run as if started in <dir>", process.cwd())
  .option("--json", "print machine-readable output");

const graft = () => new Graft(program.opts<{ C: string }>().C);
const json = () => Boolean(program.opts<{ json?: boolean }>().json);

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
  .description("commit the staged changes with the record attached")
  .option("-m, --title <title>", "commit title (default: the task)")
  .option("-a, --all", "stage all changes first")
  .option("--plan <plan>", "final plan")
  .option("--allow-no-evidence", "land even though nothing was verified")
  .action(async (o) => {
    const { record, commit } = await graft().land({
      title: o.title,
      all: o.all,
      plan: o.plan,
      allowNoEvidence: o.allowNoEvidence,
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
