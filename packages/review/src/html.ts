import type { ChangeRecord, Evidence, LogEntry } from "@fourshore/graft-core";
import type { DiffFile } from "./diff.js";
import type { FileGroup, Risk, Triage } from "./triage.js";

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const RISK_LABEL: Record<Risk, string> = {
  read: "Needs reading",
  verified: "Verified",
  mechanical: "Mechanical",
  partial: "Note missing",
  unrecorded: "No record",
};

const RISK_HELP: Record<Risk, string> = {
  read: "Behavior changed and no passing test run is recorded. Read the diff.",
  verified: "Behavior changed and the recorded test run passed. Check the claim, skim the diff.",
  mechanical: "Only tests, docs, lockfiles or generated files changed.",
  partial:
    "The commit carries Graft trailers but its full record is not in this clone, so the evidence cannot be inspected. Run graft sync, then read the diff.",
  unrecorded: "This commit has no change record, so nothing is known about why or whether it was checked.",
};

const GROUP_TITLE: Record<FileGroup, string> = {
  behavior: "Behavior",
  tests: "Tests",
  mechanical: "Mechanical",
};

const CSS = `
:root{--ink:#1a1a1a;--quiet:#6b6b6b;--line:#e3e3e3;--bg:#fff;--panel:#f7f7f7;--read:#b42318;--ok:#1a7f37;--mech:#6b6b6b;--none:#9a6700;--add:#e6ffec;--del:#ffebe9;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--ink:#e6e6e6;--quiet:#9a9a9a;--line:#333;--bg:#121212;--panel:#1c1c1c;--read:#ff7b72;--ok:#56d364;--mech:#9a9a9a;--none:#e3b341;--add:#12261e;--del:#3a1d1d}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:var(--ink);background:var(--bg)}
a{color:inherit}main{max-width:1100px;margin:0 auto;padding:24px 16px}
header.top{display:flex;align-items:baseline;gap:16px;border-bottom:1px solid var(--line);padding:12px 16px}
header.top h1{font-size:16px;margin:0}header.top .repo{color:var(--quiet);font-family:var(--mono);font-size:13px}
.queue{list-style:none;padding:0;margin:0}.queue li{display:grid;grid-template-columns:130px 1fr auto;gap:16px;padding:14px 0;border-bottom:1px solid var(--line);align-items:start}
.queue .task{font-weight:600;text-decoration:none}.queue .meta{color:var(--quiet);font-size:13px;margin-top:2px}.queue .ev{font-size:13px;color:var(--quiet);text-align:right;white-space:nowrap}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.badge.read{color:var(--read)}.badge.verified{color:var(--ok)}.badge.mechanical{color:var(--mech)}.badge.unrecorded{color:var(--none)}.badge.partial{color:var(--none)}
.claim{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 20px;margin:16px 0}
.claim h2{margin:0 0 4px;font-size:20px}.claim .who{color:var(--quiet);font-size:13px;margin-bottom:12px}
.claim .plan{white-space:pre-wrap;margin:8px 0 0}.claim dt{font-weight:600;margin-top:12px}.claim dd{margin:4px 0 0}
.evlist{list-style:none;padding:0;margin:0}.evlist li{padding:6px 0;border-top:1px solid var(--line)}
.evlist .pass{color:var(--ok);font-weight:600}.evlist .fail{color:var(--read);font-weight:600}.evlist .note{color:var(--quiet);font-weight:600}
.evlist code{font-family:var(--mono);font-size:13px}.evlist pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:12px;overflow:auto;max-height:320px;margin:6px 0 0}
.help{color:var(--quiet);font-size:13px}
section.group{margin-top:28px}section.group h3{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--quiet);margin:0 0 8px}
details.file{border:1px solid var(--line);border-radius:8px;margin:8px 0;overflow:hidden}details.file>summary{cursor:pointer;padding:8px 12px;font-family:var(--mono);font-size:13px;background:var(--panel);display:flex;gap:12px}
details.file>summary .stat{margin-left:auto;color:var(--quiet)}details.file>summary .plus{color:var(--ok)}details.file>summary .minus{color:var(--read)}
table.diff{border-collapse:collapse;width:100%;font-family:var(--mono);font-size:12px}table.diff td{padding:0 8px;white-space:pre-wrap;word-break:break-all;vertical-align:top}
table.diff td.n{width:1%;color:var(--quiet);text-align:right;user-select:none;padding-right:10px;white-space:nowrap;word-break:normal}
tr.add td{background:var(--add)}tr.del td{background:var(--del)}tr.hunk td{color:var(--quiet);background:var(--panel);padding:4px 8px}
.empty{color:var(--quiet);padding:40px 0;text-align:center}
footer{color:var(--quiet);font-size:12px;margin:40px 0 0;border-top:1px solid var(--line);padding-top:12px}
`;

function page(title: string, repo: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><header class="top"><h1><a href="/" style="text-decoration:none">Graft review</a></h1><span class="repo">${esc(repo)}</span></header><main>${body}<footer>Risk and grouping are heuristics on paths and recorded evidence, not a verdict. Read anything that matters.</footer></main></body></html>`;
}

export interface QueueItem {
  entry: LogEntry;
  triage: Triage;
}

export function renderQueue(repo: string, items: QueueItem[]): string {
  if (items.length === 0) {
    return page("Graft review", repo, `<p class="empty">No changes yet. Land one with <code>graft land</code>.</p>`);
  }
  const rows = items
    .map(({ entry, triage }) => {
      const r = entry.record;
      const t = entry.trailers;
      const task = r?.task ?? t["Graft-Task"] ?? entry.title;
      const who = r ? `${r.author.kind}:${r.author.name}` : (t["Graft-Author"] ?? entry.authorName);
      const files = Object.values(triage.groups).reduce((n, g) => n + g.length, 0);
      const ev = r
        ? `${triage.verdict.testRuns.length ? (triage.verdict.testsPassed ? "tests passed" : "tests failed") : "no test run"} · ${r.evidence.length} evidence`
        : t["Graft-Evidence"]
          ? `${t["Graft-Evidence"]} (summary only)`
          : "no evidence";
      return `<li><span class="badge ${triage.risk}" title="${esc(RISK_HELP[triage.risk])}">${RISK_LABEL[triage.risk]}</span><div><a class="task" href="/change/${entry.commit}">${esc(task)}</a><div class="meta">${esc(who)} · ${esc(age(entry.authoredAt))} · ${files} file${files === 1 ? "" : "s"} · <span style="font-family:var(--mono)">${entry.commit.slice(0, 10)}</span></div></div><div class="ev">${esc(ev)}</div></li>`;
    })
    .join("");
  return page("Graft review", repo, `<ul class="queue">${rows}</ul>`);
}

export function renderChange(repo: string, entry: LogEntry, triage: Triage): string {
  const r = entry.record;
  const claim = r ? renderClaim(r, triage) : renderNoRecord(entry);
  const groups = (["behavior", "tests", "mechanical"] as FileGroup[])
    .filter((g) => triage.groups[g].length)
    .map((g) => {
      const open = g === "behavior";
      const files = triage.groups[g].map((f) => renderFile(f, open)).join("");
      return `<section class="group"><h3>${GROUP_TITLE[g]} · ${triage.groups[g].length}</h3>${files}</section>`;
    })
    .join("");
  const head = `<p><a href="/">&larr; queue</a> &nbsp; <span class="badge ${triage.risk}">${RISK_LABEL[triage.risk]}</span> <span class="help">${esc(RISK_HELP[triage.risk])}</span></p>`;
  return page(r?.task ?? entry.trailers["Graft-Task"] ?? entry.title, repo, head + claim + groups);
}

function renderClaim(r: ChangeRecord, t: Triage): string {
  const ev = r.evidence.length
    ? `<ul class="evlist">${r.evidence.map(renderEvidence).join("")}</ul>`
    : `<p class="help">None recorded.</p>`;
  const summary = t.verdict.testRuns.length
    ? t.verdict.testsPassed
      ? "A test run passed."
      : "The last test run failed."
    : "No command looks like a test run.";
  return `<div class="claim"><h2>${esc(r.task)}</h2><div class="who">${esc(r.author.kind)}:${esc(r.author.name)}${r.author.model ? ` · ${esc(r.author.model)}` : ""} · started ${esc(r.startedAt.slice(0, 16).replace("T", " "))}${r.landedAt ? `, landed ${esc(r.landedAt.slice(0, 16).replace("T", " "))}` : ""} · <span style="font-family:var(--mono)">${esc(r.id)}</span></div><dl><dt>Plan</dt><dd>${r.plan ? `<p class="plan">${esc(r.plan)}</p>` : `<span class="help">None recorded.</span>`}</dd><dt>Evidence <span class="help" style="font-weight:400">· ${esc(summary)}</span></dt><dd>${ev}</dd></dl></div>`;
}

function renderNoRecord(e: LogEntry): string {
  const t = e.trailers;
  const when = esc(e.authoredAt.slice(0, 16).replace("T", " "));
  if (t["Graft-Change"]) {
    return `<div class="claim"><h2>${esc(t["Graft-Task"] ?? e.title)}</h2><div class="who">${esc(t["Graft-Author"] ?? e.authorName)}${t["Graft-Model"] ? ` · ${esc(t["Graft-Model"])}` : ""} · ${when} · <span style="font-family:var(--mono)">${esc(t["Graft-Change"])}</span></div><dl><dt>Evidence <span class="help" style="font-weight:400">· ${esc(t["Graft-Evidence"] ?? "none")}</span></dt><dd><p class="help">Summary from the commit trailers. The full record, with the plan and each command's output, lives on <code>refs/notes/graft</code> and is not in this clone. Run <code>graft sync</code>.</p></dd></dl></div>`;
  }
  return `<div class="claim"><h2>${esc(e.title)}</h2><div class="who">${esc(e.authorName)} · ${when} · <span style="font-family:var(--mono)">${e.commit.slice(0, 10)}</span></div><p class="help">No Graft record on this commit. The task, plan and evidence are unknown.</p></div>`;
}

function renderEvidence(ev: Evidence): string {
  if (ev.kind === "note") {
    return `<li><span class="note">note</span> ${esc(ev.text)}${ev.label ? ` <span class="help">[${esc(ev.label)}]</span>` : ""}</li>`;
  }
  const cls = ev.exitCode === 0 ? "pass" : "fail";
  const word = ev.exitCode === 0 ? "pass" : `exit ${ev.exitCode}`;
  const out = ev.output.trim()
    ? `<details><summary class="help">output · ${(ev.durationMs / 1000).toFixed(1)}s</summary><pre>${esc(ev.output)}</pre></details>`
    : `<span class="help"> · ${(ev.durationMs / 1000).toFixed(1)}s, no output</span>`;
  return `<li><span class="${cls}">${word}</span> <code>${esc(ev.command)}</code>${ev.label ? ` <span class="help">[${esc(ev.label)}]</span>` : ""}${out}</li>`;
}

function renderFile(f: DiffFile, open: boolean): string {
  const name = f.oldPath ? `${esc(f.oldPath)} &rarr; ${esc(f.path)}` : esc(f.path);
  const stat = `<span class="stat"><span class="plus">+${f.additions}</span> <span class="minus">-${f.deletions}</span></span>`;
  const body =
    f.status === "binary"
      ? `<p class="help" style="padding:8px 12px">Binary file.</p>`
      : `<table class="diff">${f.hunks.map(renderHunk).join("")}</table>`;
  return `<details class="file"${open ? " open" : ""}><summary><span>${name}</span><span class="help">${f.status}</span>${stat}</summary>${body}</details>`;
}

function renderHunk(h: DiffFile["hunks"][number]): string {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(h.header);
  let o = m ? Number(m[1]) : 0;
  let n = m ? Number(m[2]) : 0;
  const rows = [`<tr class="hunk"><td class="n"></td><td class="n"></td><td>${esc(h.header)}</td></tr>`];
  for (const l of h.lines) {
    if (l.kind === "add") rows.push(`<tr class="add"><td class="n"></td><td class="n">${n++}</td><td>+${esc(l.text)}</td></tr>`);
    else if (l.kind === "del") rows.push(`<tr class="del"><td class="n">${o++}</td><td class="n"></td><td>-${esc(l.text)}</td></tr>`);
    else if (l.kind === "meta") rows.push(`<tr class="hunk"><td class="n"></td><td class="n"></td><td>${esc(l.text)}</td></tr>`);
    else rows.push(`<tr><td class="n">${o++}</td><td class="n">${n++}</td><td> ${esc(l.text)}</td></tr>`);
  }
  return rows.join("");
}

function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
