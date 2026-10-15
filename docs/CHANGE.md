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
| `author.kind` | yes | `agent` or `human`. |
| `author.name` | yes | Tool or person: `claude-code`, `cursor`, `zach`. |
| `author.model` | no | Model identifier when the author is an agent. |
| `startedAt`, `landedAt` | yes / on land | ISO 8601. |
| `commit` | on land | The SHA the record was first landed on. Informational; the trailer is the durable link. |
| `evidence[]` | yes (may be empty) | Ordered list of what was done to verify the change. |

### Evidence

Two kinds in version 1.

- `command`: a shell command run from the repository root, with its exit code,
  wall-clock duration, and the last 4 KB of combined stdout and stderr. Exit
  code 0 is "passed". The output is kept so a reader can see *what* passed, not
  just that something did.
- `note`: free text for verification that did not come from a command: a manual
  check, a link to a CI run, a screenshot description.

Evidence is append-only while a change is open. Tools must not edit or drop
evidence; a failed run stays in the record next to the later run that passed.

## Where it lives

A change has two states: open and landed.

### Open

An open change is stored at `$GIT_DIR/graft/open.json`. Keeping it inside the
git directory means it is never committed, it follows the worktree rather than
the branch, and `git worktree` gives every agent its own. One change may be
open per worktree.

### Landed

On land, the record is written to two places in the commit, so that a reader
with plain git sees the important part and a reader with Graft sees all of it.

**1. Trailers in the commit message.** These survive everything git does to a
commit: rebase, cherry-pick, squash (if the message is kept), `git log --grep`,
GitHub's commit view.

```
Add rate limiting to the public API

Plan:
  Token bucket per API key in middleware; 429 with Retry-After.

Graft-Change: m4z1gs7jgdyp3pj2za9c
Graft-Task: Add rate limiting to the public API
Graft-Author: agent:claude-code
Graft-Model: example-model-1
Graft-Evidence: 1 command, 1 passed; 1 note
```

| Trailer | Value |
| --- | --- |
| `Graft-Change` | The change id. **The only trailer readers must rely on.** |
| `Graft-Task` | The task, collapsed to one line. |
| `Graft-Author` | `<kind>:<name>`. |
| `Graft-Model` | Present only for agents with a known model. |
| `Graft-Evidence` | Human-readable summary of the evidence list. |

The commit title is the task truncated to 72 characters unless the author gives
a better one. The plan, if any, goes in the body under `Plan:` so it reads well
in any git tool.

**2. The full record as a git note** on `refs/notes/graft`, keyed by commit SHA,
holding the JSON above verbatim. Notes carry the parts that do not belong in a
commit message: full evidence output and timestamps.

Notes are a separate ref, so they have to be pushed and fetched on purpose:

```
git push origin refs/notes/graft
git fetch origin refs/notes/graft:refs/notes/graft
```

`graft sync` does this: it fetches the remote's notes, merges them with
`cat_sort_uniq` (so two clones' records combine rather than overwrite), and
pushes. `graft init` adds the notes ref to the remote's fetch refspec so a
plain `git fetch` brings records along too.

### What survives what

| Operation | Trailers | Note |
| --- | --- | --- |
| `git rebase`, `cherry-pick` | kept | lost (note is keyed by the old SHA) |
| `git commit --amend` | kept | lost unless `notes.rewriteRef` is set |
| Squash merge that keeps the message | kept | lost |
| `git push` / `git fetch` | kept | only if the notes ref is pushed/fetched |

So: the change id in the trailer is the durable identity, and the note is a
cache of detail that can be recovered. `graft init` sets `notes.rewriteRef`
and the `notes.rewrite.*` keys so git carries notes through amend and rebase in
that clone. A future `graft fsck` can find commits whose note is missing and
report them.

## Policy

`.graft/policy.json` at the working tree root, written by `graft init`:

```json
{ "version": 1, "requireEvidence": true }
```

Version 1 has one rule. `requireEvidence` makes `land` refuse a change with an
empty evidence list unless the author passes `--allow-no-evidence`. Readers
reject unknown policy versions. The file is committed, so changing policy is a
reviewed change like any other.

## Reading records

`graft log` lists commits with their trailers, loading the note when present.
`graft show <id|sha>` finds a change by id with `git log --all --grep` on the
`Graft-Change` trailer, so a change is findable from any branch that contains
it, note or no note.

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
- **Redaction.** Tasks and evidence output can contain secrets. Version 1 trusts
  the author; a server must not.
- **Signing.** Nothing stops a record from lying about its author or evidence.
  A server that runs the evidence commands itself is the real fix.
- **Multiple open changes per worktree.** One at a time keeps the model simple
  and matches how agents actually work.
