# The Graft change record

Version 1. This document is the contract. Anything that writes or reads change
records, the CLI, the MCP server, or a third-party tool, follows it. Plain git
tooling must keep working on a repository that uses Graft, and nothing here
depends on a Graft server.

## Why

Git stores what changed. It does not store what the author was asked to do, how
they planned to do it, who (or what) did the work, or what they ran to prove it
works. When a human wrote every line, that context lived in their head and in
review conversation. When an agent writes most of the code, the context is
produced as a side effect of the work and is thrown away unless something
captures it.

A change record captures it, at the moment it is cheapest to capture: while the
change is being made.

## The record

```json
{
  "version": 1,
  "id": "m4z1gs7jgdyp3pj2za9c",
  "task": "Add rate limiting to the public API",
  "plan": "Token bucket per API key in middleware; 429 with Retry-After.",
  "author": { "kind": "agent", "name": "claude-code", "model": "example-model-1" },
  "startedAt": "2026-10-15T05:40:00.000Z",
  "landedAt": "2026-10-15T05:52:13.000Z",
  "commit": "c476ccdcd71bea544df866de4d1882044604b635",
  "evidence": [
    {
      "kind": "command",
      "at": "2026-10-15T05:50:01.000Z",
      "command": "npm test",
      "exitCode": 0,
      "durationMs": 8120,
      "output": "...last 4 KB of stdout+stderr...",
      "label": "unit tests"
    },
    {
      "kind": "note",
      "at": "2026-10-15T05:51:30.000Z",
      "text": "Hit the endpoint 200 times with curl; 429 after 100 as expected."
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Schema version. Readers reject versions they do not know. |
| `id` | yes | 20-character Crockford base32: 8 characters of millisecond timestamp, 12 random. Sortable, unique, and stable for the life of the change. |
| `task` | yes | What the author was asked to do, in the words they were given. Not a summary of the diff. |
| `plan` | no | How they intended to do it. May be set at start, revised during, or set at land. |
| `ref` | no | Where the task came from: the thread, issue or ticket that asked for it, as a URL or id. Written as the `Graft-Task-Ref` trailer. |
| `author.kind` | yes | `agent` or `human`. |
| `author.name` | yes | Tool or person: `claude-code`, `cursor`, `zach`. |
| `author.model` | no | The model an agent ran on, from the harness's hook payload when it carries one or from `GRAFT_AUTHOR_MODEL`. Written as the `Graft-Model` trailer. |
| `startedAt`, `landedAt` | yes / on land | ISO 8601. |
| `commit` | on land | The SHA the record was first landed on. Informational; the trailer is the durable link. After an amend or rebase the note moves with the commit but this field keeps the original SHA, so readers take the commit from where the note is attached, never from this field. |
| `evidence[]` | yes (may be empty) | Ordered list of what was done to verify the change. |
| `capturedBy` | no | The harness whose hook opened the change (`claude-code`, from the prompt) rather than an explicit `graft start`. A later `graft start` adopts such a change, naming the task and keeping its evidence. |
| `attempts[]` | no | Changes abandoned in this worktree since the last land, each with its `id`, `task`, `plan`, `reason`, `startedAt`, `abandonedAt` and `evidence`: the plans that did not work and why. Written as the `Tried:` block. |
| `reverts` | no | The change id or commit this change undoes, when it was opened by `graft revert`. Written as the `Graft-Reverts` trailer. |
| `artifacts[]` | no | Files the change produced, each `{ "name", "sha256" }` (lower-case hex), recorded with `graft artifact`. One `Graft-Artifact` trailer each, so a build found in the field resolves to its change with `graft show <sha256>`. |
| `overrides[]` | no | The landing-gate checks a caller overrode to land the change: `no-evidence` (`--allow-no-evidence`, `GRAFT_ALLOW_NO_EVIDENCE`) or `secrets` (`--allow-secrets`, `GRAFT_ALLOW_SECRETS`). Set only when the gate would otherwise have refused. One `Graft-Override` trailer each. |

### Evidence

Two kinds in version 1.

- `command`: a shell command run from the repository root, with its exit code,
  wall-clock duration, and the last 4 KB of combined stdout and stderr. Exit
  code 0 is "passed". The output is kept so a reader can see *what* passed, not
  just that something did. With `attested: true` the author attached a run
  they made themselves; Graft did not run it, the duration is 0, and readers
  say "attested" instead of "pass" so the record is honest about who ran it.
  It does not satisfy `requireEvidence: "command"`, which asks for a run
  Graft or a harness saw, though `graft check --rerun` runs it. With `via`
  set (for example `"claude-code"`) a harness reported the run through a
  hook, with its own exit code and output: a pass or fail like any other,
  marked only so a reader knows who ran it. With `name` set the run is one
  of the policy's named commands (`graft evidence test`, or a captured
  command that matched the catalog); the message line carries the name in
  place of any free label, so a record rebuilt from the message still
  satisfies the rules that ask for that name and `graft check --rerun` can
  run the name's current definition without the note. `tree` is the hash of
  the working tree (tracked and untracked files, ignored ones left out) that
  the run checked: taken just before Graft runs the command, or when a
  harness reports a run it made. It is hashed in a scratch copy of the index,
  whose timestamp is kept so git re-reads any file whose stat cache could be
  wrong, and it stays in the note. Untracked files over 1 MB are left out of
  it, so a large data file or build output that will not be committed is not
  copied into the object store on every run; changes to such a file do not
  make a run stale. At land, a passing run that a rule relies on is compared
  with what is being committed: when a file the rule covers differs between
  the run's tree and the index, whether or not the file is staged, the run is
  `stale` (an unstaged edit the run saw is not in the commit; a file that is
  still untracked is left out of this, since no re-run could make it match), it does not
  satisfy the rule, and `land` refuses unless another run of the
  same name is fresh (or `--allow-no-evidence` is passed). A stale run that
  lands is written as `[stale name]` in the message, so a record rebuilt
  from the message still reads it as not covering the rule. A run with no
  `tree`, or whose tree this clone no longer has, is taken as fresh:
  staleness is asserted only when it is certain.
- `note`: free text for verification that did not come from a command: a manual
  check, a link to a CI run, a screenshot description.

Evidence is append-only while a change is open. Tools must not edit or drop
evidence; a failed run stays in the record next to the later run that passed.

### Attempts

`graft abandon` closes a change without landing it. Git keeps nothing of such
a change; Graft keeps what it tried. The abandoned record becomes an attempt,
stored at `$GIT_DIR/graft/attempts.json` beside the open change, and the next
change that lands in that worktree carries every waiting attempt in its
`attempts` list and its `Tried:` block, then the file is cleared. `graft start
--replace` abandons the change it replaces the same way, with the reason
"replaced by a new start". A change with no plan, no reason and no evidence
tried nothing, so nothing is kept; `graft abandon --discard` keeps nothing on
purpose. The next land is the right place because the attempts are, in time
and usually in subject, the dead ends on the way to it; the reason says when
they were not.

## Where it lives

A change has two states: open and landed.

### Open

An open change is stored at `$GIT_DIR/graft/open.json`. Keeping it inside the
git directory means it is never committed, it follows the worktree rather than
the branch, and `git worktree` gives every agent its own. One change may be
open per worktree.

### Landed

On land, the record is the commit message, and the command output is cached
in a git note.

**1. The commit message is the record: trailers, plus `Plan:` and `Evidence:`
blocks in the body.** These survive everything git does to a commit: rebase,
cherry-pick, squash (if the message is kept), `git log --grep`, GitHub's
commit view. They need no extra ref to push, so they travel with the commit,
and every reader (`log`, `show`, `context`, `check`) works from them alone.

```
Add rate limiting to the public API

Plan:
  Token bucket per API key in middleware; 429 with Retry-After.

Evidence:
  [pass unit tests] npm test (12.3s)
  [note] Hit the endpoint 200 times; 429 after 100 as expected

Graft-Change: m4z1gs7jgdyp3pj2za9c
Graft-Task: Add rate limiting to the public API
Graft-Author: agent:claude-code
Graft-Evidence: 1 command, 1 passed; 1 note
```

| Trailer | Value |
| --- | --- |
| `Graft-Change` | The change id. **The only trailer readers must rely on.** |
| `Graft-Task` | The task, collapsed to one line. |
| `Graft-Task-Ref` | Present when the change has a `ref`: the URL or id of what asked for it. |
| `Graft-Reverts` | Present when the change was opened by `graft revert`: the change id or commit it undoes. |
| `Graft-Artifact` | One per recorded artifact: `sha256:<64 hex> <name>`. May repeat; readers collect every line. |
| `Graft-Author` | `<kind>:<name>`. |
| `Graft-Model` | Present when `author.model` is set. |
| `Graft-Override` | One per override that let the change past the gate: `no-evidence` or `secrets`. May repeat. `graft check` shows it on the commit and, on GitHub, as a warning. |
| `Graft-Evidence` | Human-readable summary of the evidence list: commands, how many passed, and how many of those were stale (`2 commands, 1 passed, 1 stale`), then notes. A stale run is not counted as passed. |

Other trailers can be added at land time (`graft land --trailer "Co-Authored-By: ..."`,
or `trailers` on `graft_land`); they go after Graft's own. The `Graft-` prefix
is reserved.

The commit title is the task truncated to 72 characters unless the author gives
a better one. The plan, if any, goes in the body under `Plan:` so it reads well
in any git tool. Attempts, if any, go under `Tried:`, one line per attempt:
`[<change id>] <task>: <reason, or the plan when no reason was given>
(<evidence summary>)`, and a record rebuilt from the message keeps that line
as the attempt's `summary`. The evidence list goes under `Evidence:`, one line
per note, attested run, and command: repeated Graft or harness runs of one
command (by catalog name, else by its label and text) keep only the last, with the
earlier runs counted after the duration (`(3.0s; earlier: 2 runs, 1 failed)`).
When that last run did not pass, the latest passing run is kept too, so a
reader of the message alone reaches the same verdict on the policy as one with
the note, which keeps every run. `Graft-Evidence` counts every run.
The bracket holds the status, `pass`, `stale`, `fail <exit code>` or `note`,
and then the label if there is one (`[pass unit tests]`, `[note manual]`); after it
come the command and its duration, or the note text. Keeping the label inside
the bracket means a command or note containing `: ` is read back exactly.
Labels lose any square brackets; commands and notes are collapsed to one line
and cut at 200 characters. Output is not in the message.

Readers build the record from the message: the trailers give the id, task,
ref, reverts and author, the blocks give the plan, attempts and evidence, timestamps fall back
to the commit date, and command output is empty unless the note is in the
clone. `recordSource` says which was read, for tools that want to show
output when they have it. Only the record Graft wrote is read: the trailer
paragraph that holds the last `Graft-Change` line, and the `Plan:`, `Tried:`
and `Evidence:` blocks in the paragraphs immediately before it, in that
order. A header in the task's own text, or the records of other commits in a
squash message, is not part of the record; a squash of several landed
changes reads as the last of them, with its own blocks and trailers.

**2. The full record as a git note** on `refs/notes/graft`, keyed by commit SHA,
holding the JSON above verbatim. The note is a cache: it carries what does not
belong in a commit message, the command output and exact timestamps, and
nothing requires it. The one exception is a record from before 0.0.6, which
had no `Evidence:` block, so its evidence exists only in the note; `graft
check` names such a commit "note missing" rather than failing it as having
none.

Notes are a separate ref, so they have to be pushed and fetched on purpose,
and only when the output is wanted in another clone:

```
git push origin refs/notes/graft
git fetch origin refs/notes/graft:refs/notes/graft
```

`graft sync` does this: it fetches the remote's notes, merges them into
the clone's, and pushes. Notes on different commits combine; when both
clones hold a different record for the same commit, one record is kept, the
one with more evidence, then the later `landedAt`, then the clone's own, so
every note stays one JSON document. A note that does not parse (as an
earlier `graft sync` could leave by concatenating two records) is reported
once on stderr, and readers build the record from the message instead. `graft init` does not add the notes ref to the remote's fetch
refspec: an exact refspec makes every `git fetch` fail while the remote has no
notes, and a forced one overwrites notes the clone has not pushed. It removes
the one earlier versions added. A repo that wants a plain `git fetch` to bring
notes can add `+refs/notes/*:refs/notes/*` itself. A clone that cannot push the
ref (some hosted agent sessions) loses nothing but the output.

### What survives what

| Operation | Message (trailers, plan, evidence list) | Note (output) |
| --- | --- | --- |
| `git rebase`, `cherry-pick` | kept | lost (note is keyed by the old SHA) |
| `git commit --amend` | kept | lost unless `notes.rewriteRef` is set |
| Squash merge that keeps the message | kept | lost |
| `git push` / `git fetch` | kept | only if the notes ref is pushed/fetched |

So: the change id in the trailer is the durable identity, the message carries
the record a reviewer needs, and the note is a cache of output that can be
recovered. `graft init` sets `notes.rewriteRef`
and the `notes.rewrite.*` keys so git carries notes through amend and rebase in
that clone. A future `graft fsck` can find commits whose note is missing and
report them.

## Policy

`.graft/policy.json` at the working tree root, written by `graft init`:

```json
{ "version": 1, "requireEvidence": true }
```

`requireEvidence` makes `land` refuse a change with an empty evidence list
unless the author passes `--allow-no-evidence`. Set it to `"command"` and
`land` also requires at least one recorded command that exited 0 and was
run by Graft or reported by a harness hook: a note or an attested run does
not satisfy the gate, since each is only a claim. `secretFiles`, optional, is a
list of globs relative to the root (`"nova.json"`, `"config/*.secret"`,
`"keys/**"`) that `land` refuses to commit without `--allow-secrets`, on top
of the built-in list (`.env`, `*.pem`, `*.key`, `.aws/credentials`, `*.tfvars`, ...). A glob without a slash
matches a file name anywhere in the tree. The same list decides whose output
is withheld: a command that names one of these files keeps its command line,
exit code and duration in the record, and its output is replaced with a
line saying why. `behaviorFiles`, optional, is a
list of globs (same rules) for files `graft check` must group as behavior
even though its heuristics would file them under mechanical, such as a schema
or a spec kept in Markdown. `trailers`, optional, is a list of `Key: value`
lines added to every landed commit after Graft's own trailers, with `$NAME`
and `${NAME}` expanded from the environment; a line naming an unset variable
is left out of that commit, never written empty. `ref`, optional, is one
such template for the change's `ref`, used when `graft start` is given none
(the capture hooks never pass one), so `Graft-Task-Ref` is filled from the
harness's session variable on every change; an unset variable leaves the
change without a ref. `captureCommands`, optional,
is a list of regular expressions (as strings) for commands the capture hooks
record as evidence on top of the built-in test, build, lint and type-check
patterns.
`checkCommands`, optional, is a list of regular
expressions (as strings), each matched against the whole command: `graft
check --rerun` re-runs a run recorded under a catalog name, or whose text is
a catalog command, by the catalog's definition, and any other recorded
command only when it matches one of these. Unset, only catalog commands are
re-run. `commands`, optional, is a map of name to shell command: the repo's
checks, named once, run by `graft evidence <name>`, recognised by the
capture hooks, and re-run by `graft check --rerun` under their current
definition. `rules`, optional, is a list of `{ "paths": [globs], "require":
[names] }`: a change touching a file that matches `paths` must carry a
passing, non-attested run of every named command, made on the content being
committed (see `tree` under Evidence), or `land` refuses and `check` fails
the commit. A rule naming a command that `commands` does not
define makes the policy unreadable, so the mistake surfaces at once. Readers
reject unknown policy versions. The file is committed, so changing policy is a
reviewed change like any other; `graft check` reads it from the base of the
range it checks, so a branch is held to the policy it is merging into, not
one it brings along.

## Reading records

`graft log` lists commits with their trailers, loading the note when present.
`graft show <id|sha>` finds a change by id with `git log --all --grep` on the
`Graft-Change` trailer, so a change is findable from any branch that contains
it, note or no note. Given a SHA-256 (64 hex characters, with or without a
`sha256:` prefix) it searches the `Graft-Artifact` trailers the same way.

`graft export` writes every recorded change as one JSON object per line
(`commit`, `title`, `authoredAt`, `record`, `recordSource`, `diff`), newest
first: the (task, diff, evidence) rows a repository has accumulated, for a
script or a model to consume. `--all` adds commits without a record; `--no-diff`
leaves the diff out.

`graft context <paths>` is the read an agent makes before editing: `git log
--name-only -- <paths>` over the newest commits, each record read as above,
rendered newest first and cut at a character budget. The first thing cut from
an entry is its plan, then its evidence lines (replaced by the trailer-style
summary); when an entry still does not fit, it and everything older are dropped
and the text says how many. Commits without a record are counted in the header
and shown only on request.

Readers must tolerate a commit that has trailers but no note (show the
trailers) and must ignore commits with neither.

## Out of scope for version 1

These are deliberate omissions, not oversights. Each is a candidate for version
2 once the basics have been used in anger.

- **Draft trail.** Snapshots of the working tree between start and land, so the
  iterations beneath a clean commit are recoverable. Jujutsu's operation log is
  the model.
- **Footprint.** The files and symbols a change touched, declared up front, for
  concurrent landing in a Graft server.
- **Redaction, beyond the basics.** Version 1 scrubs evidence output and notes
  of the values of environment variables whose names look secret (`SECRET`,
  `TOKEN`, `PASSWORD`, `API_KEY`, ...), and `land` refuses files that look like
  credentials (`.env`, `*.pem`, ...) unless told otherwise. Pattern-based
  scanning of the diff itself is for a server.
- **Signing.** Nothing stops a record from lying about its author or evidence.
  `graft check --rerun` in CI re-runs the recorded commands on the merge
  commit, which turns the evidence claim into a fact at the point a human
  merges; a server that runs them itself would also cover the author.
- **Multiple open changes per worktree.** One at a time keeps the model simple
  and matches how agents actually work.
