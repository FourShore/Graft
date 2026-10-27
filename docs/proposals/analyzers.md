# Proposal: analyzer evidence and a capability-diff analyzer

Status: proposal, not started. Written for a reviewer (person or agent) to
judge on its merits and either pick up, cut down, or close. Nothing here is
decided. Written 2026-10-27 against `12ac6b5`, Graft 0.2.0.

## The claim

Graft answers "what was asked, and what was run to check it." It does not
answer "what can this change now do that it could not before." A commit that
adds an outbound HTTP call to `billing/`, or a `child_process` import to a
build script, carries the same `[pass test]` line as one that renames a
variable, and the model review may or may not notice. For code written mostly
by agents, that second question is the one a human merging at speed most
needs answered, and it is one a deterministic tool can answer better than a
model can: the model guesses from the diff, the tool resolves the imports.

This proposal is for Graft to be able to carry that answer as evidence,
without Graft owning the analysis. Three parts, in the order they should
happen:

1. A way for a deterministic analyzer to put its findings in the record and
   have `graft check` re-run it, using what exists today (Option A) or a small
   extension (Option B).
2. A first analyzer, a capability diff for Node, as a sibling package.
3. A formatting rule, which needs no code.

## Where Graft is today (what this builds on)

Read these before judging the proposal; file references are to the source
at the commit above.

- Evidence is one of three kinds, `packages/core/src/record.ts`:
  `CommandEvidence`, `NoteEvidence`, `ReviewEvidence`. A rule in the policy
  (`CoverageRule` in `packages/core/src/policy.ts`) names commands and reviews
  that files matching its paths must carry; `UnmetRule.kind` is
  `"command" | "review"`.
- A review is the one evidence kind that is not the author's own run. The
  policy names it under `reviews`, and `ReviewSpec` (`packages/core/src/review.ts`)
  has a `command` escape hatch: a program that reads a `ReviewRequest`
  (`name`, `task`, `diff`, `instructions`) as JSON on stdin and prints a
  `ReviewResult` (`verdict`, `summary`, `findings`, `model`) on stdout.
  `parseReviewResult` forces the verdict to agree with the findings: a
  blocker means `request-changes`.
- `graft check --rerun` (`packages/review/src/check.ts`) runs every review a
  rule asks for again, on each commit's own diff, and that verdict is the one
  that counts. A re-run review that approves satisfies the rule whatever the
  author recorded; one that requests changes fails the commit with the
  findings. A review it cannot run is listed as `review-skipped`, which does
  not fail the check.
- Triage (`packages/review/src/triage.ts`) sorts a commit's files into
  behavior, tests and mechanical by path and content heuristics. It is the
  only semantic reading Graft does of a diff, and it is at the file level.
- The repo's own policy is in `.graft/policy.json`: `build` and `test` for
  `packages/*/src/**`.

The important observation: **the reviewer `command` interface is already a
general analyzer contract.** Everything below is about whether to use it as
is or to give it its own name.

## Part 1: analyzer evidence

### Option A: no change to core

Write the capability analyzer as a reviewer command and name it in the
policy like any review:

```json
{
  "reviews": {
    "code": { "differentModel": true },
    "capabilities": { "command": "npx @fourshore/graft-capdiff" }
  },
  "rules": [{ "paths": ["src/**"], "require": ["test", "code", "capabilities"] }]
}
```

It reads the request on stdin, prints findings, and `graft evidence
capabilities` records them; `graft check --rerun` runs it again in CI with no
API key, since `command` reviews do not need one. The commit message line
reads `[review approve capabilities] capdiff/0.1.0 (prompt 9a1f…; 2 findings)`
with the tool's name where the model goes.

What this costs: the record calls a deterministic tool a review, with a
`model` field and a `promptSha256` of instructions it never read.
`differentModel` is meaningless for it. `graft show` and the step summary
will say "review" where a reader should see "analysis". None of this is
wrong, only misleading, and it is the cheapest possible way to find out
whether the analyzer is worth anything.

**Recommendation: do Option A first.** Build the analyzer, run it on this
repo under the existing contract, and only then decide whether it earns
Option B. The core has one job and is early; it should not grow a feature for
a tool that does not exist yet.

### Option B: a distinct evidence kind

If the analyzer earns it, give it a name. Changes, all additive:

- `packages/core/src/policy.ts`: `analyzers?: Record<string, AnalyzerSpec>`,
  where `AnalyzerSpec` is `{ command: string }` and nothing else; an analyzer
  has no model, no prompt, no `differentModel`. A rule's `require` may name
  one. `UnmetRule.kind` gains `"analyzer"`. A name defined in more than one of
  `commands`, `reviews`, `analyzers` is a policy error, as a rule naming an
  undefined one is today.
- `packages/core/src/record.ts`: `AnalyzerEvidence`, kind `"analyzer"`, with
  `name`, `tool` (the program's own name and version, as it reports them, in
  place of `model`), `verdict`, `summary`, `findings`, `diffSha256`,
  `durationMs`, `tree`, `stale`. Reuse `ReviewFinding`, with one optional
  field added to it: `code?: string`, a machine-readable category such as
  `cap:net:added`, so a script or a later Graft can group findings without
  parsing prose. Reviews may set it too; the model prompt need not.
- The analyzer request on stdin is the `ReviewRequest` minus `instructions`,
  plus `files: string[]` (the paths the commit touched, after triage) and
  `base: string` (the commit the diff is against), since a tool that resolves
  imports needs the tree, not only the diff. It runs from the repo root with
  the working tree (at `evidence`) or the commit checked out (at `check`), so
  it can read files; the diff is a hint, not the whole input.
- The answer is `ReviewResult` with `tool` in place of `model`. Same parser,
  same rule that the verdict follows the findings.
- Message line: `[analyzer approve capabilities] capdiff 0.1.0 (2 findings)`.
  Findings stay in the note, as for reviews.
- `graft check --rerun` runs analyzers the way it runs reviews: once per
  commit on that commit's diff, the check's verdict counts, and an analyzer
  whose command is not on PATH is `analyzer-skipped`. Same fork rule as
  commands: a fork's pull request does not run a program named in a commit
  message, and the base policy's definition is the one run.
- `docs/CHANGE.md` gains the kind, and the README's "Review as evidence"
  section gains a sibling.

Nothing in the record format needs a version bump: `parseMessageRecord`
(`record.ts`) skips an evidence line that matches neither `EVIDENCE_LINE` nor
`REVIEW_LINE`, so an older Graft reading a commit with an analyzer line sees a
record with one less piece of evidence and nothing else wrong. (One wrinkle:
`LABELLED_BRACKET` decides whether a block is in the 0.0.6 legacy format by
whether any line carries a label in a bracket; add the new kind there so a
block whose only evidence is an analyzer is not read as legacy.)

## Part 2: a capability-diff analyzer for Node

A sibling package, `packages/capdiff` (`@fourshore/graft-capdiff`), or its own
repository under FourShore. Not in `core` or `review`. Node first because
Graft is written in it, this repo can dogfood it, and the import graph is
tractable.

### What it reports

For each file the commit touched, the set of **capabilities** the file holds
before and after, and the difference. A capability is a coarse category of
effect, deliberately few:

| Code | Granted by |
| --- | --- |
| `fs` | `node:fs`, `node:fs/promises`, `node:path` is not one |
| `net` | `node:http`, `node:https`, `node:net`, `node:dns`, `node:tls`, global `fetch`, `WebSocket` |
| `process` | `node:child_process`, `node:worker_threads`, `node:cluster`, `process.exit`, `process.kill` |
| `env` | `process.env` reads |
| `eval` | `eval`, `new Function`, `vm`, dynamic `import(expr)` or `require(expr)` with a non-literal argument |
| `native` | `.node` addons, `node:ffi`-style packages, `process.dlopen` |
| `dep` | a package added to `dependencies` or `optionalDependencies` in a `package.json` |

A file holds a capability when it imports a module that grants it or uses a
global that grants it. Imports of the project's own modules propagate the
imported module's capabilities (one level of resolution over the file tree is
enough for v0; a cycle is cut at the first repeat). A third-party package
grants what a built-in table says it grants, by name (`undici` is `net`,
`execa` is `process`, `dotenv` is `env` and `fs`); an unknown package grants
`dep` only, and the finding says so, so the table grows from what people hit.

### Findings

- A file that **gains** a capability is a finding, with the file and the
  line of the import or call, `code: "cap:<cap>:added"`.
- A file that **loses** one is a `nit` with `code: "cap:<cap>:removed"`.
- A new `dep` is a `warning` naming the package and what the table says it
  grants, or that it is unknown.

Severity is what makes it a gate or a report. Without a manifest, every
`added` is a `warning`: the check passes, the PR summary shows the delta,
and the human decides. With a manifest, `.graft/capabilities.json`, an
`added` outside what the file's paths allow is a `blocker`:

```json
{
  "version": 1,
  "allow": [
    { "paths": ["packages/core/src/git.ts"], "capabilities": ["process", "fs", "env"] },
    { "paths": ["packages/core/src/review.ts"], "capabilities": ["net", "process", "env", "fs"] },
    { "paths": ["packages/*/src/**"], "capabilities": ["fs", "env"] }
  ]
}
```

The manifest is reviewed like the policy: the check reads the base's copy,
so a pull request cannot widen what it is checked against. `capdiff init`
writes one from the current tree, so adopting it on an existing repo starts
from "what is, is allowed" and the gate only catches what changes. That is
the same shape as `requireEvidence` and `rules`: nothing is retroactive.

### What it does not do, on purpose

- No per-function effects. File granularity, because that is what triage and
  the manifest already speak, and because per-function needs a real type
  checker.
- No taint, no data flow, no "does this `fetch` go to a host it should not."
  That is the model review's job; this tool tells the reviewer where to look.
- No transitive dependency scanning in v0. A new direct dependency is
  reported; what it pulls in is not. `npm audit` and lockfile tools cover
  that ground.
- False negatives are accepted (string-built imports, `require` through a
  helper). False positives are the cost: a capability "added" by a refactor
  that moved an import is a warning the reviewer dismisses, and the table
  and the manifest are how the noise is tuned down. If the warnings are not
  worth reading on this repo after a month, the tool is not worth shipping.

### Implementation notes for whoever picks it up

- Parse with the TypeScript compiler API, which is already a dev dependency
  of this monorepo, so `.ts`, `.js`, `.mjs`, `.cjs` all read the same way,
  and import resolution can reuse `ts.resolveModuleName` against the repo's
  `tsconfig`.
- Before and after trees: `git show <base>:<path>` for the before, the
  working tree or the commit for the after; `packages/review/src/diff.ts`
  already lists the files and their renames.
- The capability table is one JSON file in the package, exported, so a repo
  can extend it in the manifest (`"packages": { "my-sdk": ["net"] }`).
- Stdin/stdout contract exactly as `reviewViaCommand` expects under Option A,
  so the first version needs no change to Graft at all. `GRAFT_REVIEW` in the
  environment carries the name it was called under.
- Tests: fixtures of before/after file pairs with expected findings, and one
  end-to-end run through `graft evidence` on this repo.

## Part 3: a formatting rule

No code. A canonical format makes every diff the reviewer and the analyzer
read a semantic diff, and it makes the diff a model reads shorter. Graft
already supports it:

```json
{
  "commands": { "format": "npx prettier --check ." },
  "rules": [{ "paths": ["packages/*/src/**"], "require": ["format"] }]
}
```

One optional step for `graft init` in `packages/core/src/detect.ts`: when
the repo has a Prettier, Biome, `gofmt`, `rustfmt`, `black` or `ruff`
configuration, add `format` to the catalog and to the default rule the same
way `test` and `lint` are added today. This repo should adopt the rule on
itself first.

## What this is not

- Not a new language, and not a change to how agents write code. Graft's
  value is that it runs on plain git, needs no server and knows no language;
  the analyzer is language-specific and lives beside it, not in it.
- Not a replacement for the model review. The analyzer finds what changed;
  the review judges whether it should have.
- Not a sandbox. The manifest describes what code may do; it does not stop
  it at runtime. Deno permissions, WASI and OS sandboxes do that, and this
  record is meant to be read alongside them, not instead.

## Sequence and acceptance

1. **Formatting rule on this repo.** An afternoon. Acceptance: the rule is
   in `.graft/policy.json` and `graft check` is green.
2. **`capdiff` v0 as a reviewer command (Option A).** A week. Acceptance: it
   runs on this repo under `reviews.capabilities`, every file in
   `packages/*/src` has a capability set that a maintainer agrees is right,
   and the last twenty commits produce findings a maintainer would have
   wanted to see for at least a few of them and would not have minded for
   the rest. If that last clause fails, stop here and record why in this
   file.
3. **Manifest and blocker severity.** Acceptance: `capdiff init` writes a
   manifest for this repo, and a test commit that adds `node:child_process`
   to a file not allowed it fails `graft check --rerun`.
4. **Option B**, only if step 2 passed and the "review" label has caused
   real confusion in the summary or `graft show`. Acceptance: the record
   format section of `docs/CHANGE.md` documents the kind, and a record with
   an analyzer line round-trips through `parseMessageRecord`.

## Open questions for the reviewer

- Is file granularity enough to be useful, or is the only version worth
  building the per-function one? If the latter, this proposal is too early
  and should wait for a type-checker-backed analyzer.
- Should `dep` findings live here or in a separate, smaller analyzer that
  only reads `package.json` and the lockfile? It is the easiest part to
  build and might be worth shipping alone.
- Does the manifest belong in `.graft/` next to the policy, or in the
  analyzer's own file, given that `graft check` reads the policy from the
  base but would not know to do the same for a file it does not own? Under
  Option A the analyzer must read the base's manifest itself via `git show`.
- Is `warning` the right default severity with no manifest, or is "report
  only, never a finding" better for the first month so the noise can be
  measured before it is ever shown as a finding?

## Origin

This came out of a conversation about whether a programming language built
for agents would save tokens (it would not, much: models are trained on
human languages and tokenizers on human text), and what would actually make
agent-written code cheaper to trust. The answer was evidence of what ran and
a record of what the code can now do. Graft is the first; this proposes the
second as something Graft can carry.
