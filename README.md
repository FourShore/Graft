# Graft

**Git records what changed. Graft records why, and whether it was tested.**

Every commit gets a record: the task the author was given, the plan, who (or
which agent) did the work, and the commands they ran to check it. It's stored
as commit trailers and a git note, so git, GitHub, and your tools keep working
as they are.

## Why

AI moved the bottleneck. Writing code used to be the slow part. Now an agent
can produce a working change in minutes, and the slow part is deciding whether
to trust it. Nobody can read every diff at the rate agents produce them, and a
diff on its own doesn't say what was asked for or what was checked.

Git was built for the old bottleneck. It tracks what changed and who committed
it, which was enough when a human typed every line and could be asked about
it. It has no place for the task, the plan, or the evidence, so that context
gets produced during agent work and thrown away.

Graft keeps it. Each commit carries the task, the author, and the commands
that were run, and `graft land` won't commit without evidence. Review starts
from the claim, "this is what I was asked and this is what I ran", instead of
from a bare diff. Months later, `graft log` answers "why is this here" without
digging through chat logs.

Status: early. The record format, a CLI, an MCP server, and a local review page
work and are used on this repo. See [docs/CHANGE.md](docs/CHANGE.md) for the
spec and the roadmap below for what's next.

## Install

Needs Node 20+ and git.

```
npm install -g @fourshore/graft
graft --version
```

This installs `graft` and `graft-mcp`. Run the same command to update.

## Set up a repo

```
graft init
```

Safe on an existing repo; it doesn't touch history. It sets a few git config
keys so records survive `commit --amend` and `rebase`, adds the notes ref to
`origin`'s fetch list, writes `.graft/policy.json`, and adds a "Version
control" section to `AGENTS.md`. Commit both files.

## Point your agent at it

The `AGENTS.md` section that `graft init` writes tells an agent to open a
change before editing, record each check it runs, commit with `graft land`,
and sync after pushing. Most agent harnesses read `AGENTS.md`. Claude Code
reads `CLAUDE.md`, so put a line containing `@AGENTS.md` in it. Pass
`--no-agents` to `graft init` to leave the file alone.

Agents with MCP support can use the same steps as tools. For Claude Code:

```
claude mcp add graft -- graft-mcp --repo /path/to/your/repo
```

Tools: `graft_start`, `graft_plan`, `graft_evidence`, `graft_note`,
`graft_land`, `graft_sync`, `graft_status`, `graft_context`, `graft_log`, `graft_show`,
`graft_abandon`. `graft_land` commits what's staged plus any `paths` you give
it; `stageAll` is off by default.

## Capture without ritual

`graft init` also installs hooks, so records exist whether or not anyone
remembers Graft:

- **Claude Code hooks** in `.claude/settings.json`. The prompt opens a change
  (the prompt is the task, as the agent received it), and every Bash call that
  looks like a test, build, lint or type-check run is recorded as evidence
  with the exit code and output the harness itself reported, so it is a pass
  or a fail, not a claim. Other commands are ignored. Widen the filter with
  `captureCommands` in the policy. An explicit `graft start` afterwards just
  names the task and keeps what was captured.
- **Git hooks** (`prepare-commit-msg` and `post-commit`). A plain
  `git commit` with a change open gets the Plan and Evidence blocks and the
  trailers in its message and the full record as a note, exactly like
  `graft land`, and the same policy gate applies (`GRAFT_ALLOW_NO_EVIDENCE=1`
  or `GRAFT_ALLOW_SECRETS=1` override it for one commit). Merges, squashes and
  amends are left alone, and a hook that is already there is not overwritten.

The hooks run `graft`, so it has to be on PATH. `graft init --no-hooks` skips
them. Claude Code runs project hooks only after you trust the folder.

## Use it from the shell

```
graft start "Add rate limiting to the public API" --plan "Token bucket per key"
# edit code
graft evidence --label "unit tests" -- npm test
graft evidence --note "Hit the endpoint 200 times; 429 after 100 as expected"
graft land src/api.ts src/api.test.ts -m "Add rate limiting"
graft sync
```

`evidence` runs what follows `--` with each argument passed as given, so
quotes and parentheses survive (`graft evidence -- node -e 'console.log("ok")'`).
A single argument is run through the shell as written, so pipes and `&&`
work there (`graft evidence -- "npm test && npm run lint"`). A redirect or
pipe given as its own argument is passed to the program literally
(`graft evidence -- go version '2>&1'` hands `2>&1` to `go`), so put a
command that needs shell syntax in one string. On Windows the arguments are
quoted for `cmd.exe` instead of `sh`.

If you already ran the slow thing through your own tools, attach it instead of
running it twice: `graft evidence --attach --label "go tests" --exit 0 --output-file
out.txt -- go test ./...`. Nothing is run; the record carries the command, exit
code and output as `attested` rather than `pass`, so a reader knows Graft did
not see it run. Over MCP, pass `exitCode` (and `output`) to `graft_evidence`.

`land` commits what's staged, plus any files you name, or everything with
`-a`. Add your own trailers with `--trailer "Co-Authored-By: ..."` (repeatable;
`trailers` on `graft_land`). It refuses to commit without evidence (`--allow-no-evidence` overrides)
and refuses staged files that look like credentials such as `.env`, `*.pem`,
`*.key` (`--allow-secrets` overrides). Evidence output and notes are scrubbed
of any value held in an environment variable whose name looks secret.

```
graft context <paths>  # before editing: the changes that touched these files, sized for a prompt
graft log              # history as changes: task, author, evidence
graft show <id>        # one change in full, by id or commit
graft status           # the open change, if any
```

`context` is the reading side for a cold start. Give it the files or
directories you are about to edit and it prints the commits that touched them,
newest first, each with its task, plan, evidence lines and the files it
changed, then stops at `--budget` characters (default 8000), dropping plans
before it drops older commits. It reads the note when it is in the clone and
the commit message when it is not, so it works in a fresh clone. `--all` adds
commits that have no record as one line each; `--json` returns the entries
with the same text in a `text` field, which is also what `graft_context`
returns.

The commit ends up looking like this:

```
Add rate limiting

Add rate limiting to the public API

Plan:
  Token bucket per key

Evidence:
  [pass unit tests] npm test (12.3s)
  [note] Hit the endpoint 200 times; 429 after 100 as expected

Graft-Change: m4z1gs7jgdyp3pj2za9c
Graft-Task: Add rate limiting to the public API
Graft-Author: agent:claude-code
Graft-Model: example-model-1
Graft-Evidence: 1 command, 1 passed; 1 note
```

The message carries the task, plan and evidence list, so any clone and
GitHub's commit view show them. The command output is a note on
`refs/notes/graft`.

A crashed session can leave a change open in `.git`. `graft start --replace`
drops it and opens the new one; `graft status` shows what is there.

## Sharing records

The commit message travels with the commit, so the task, plan and evidence
list reach every clone with a plain `git push`. The command output lives in a
note, and notes don't travel on their own, so run `graft sync` after
`git push` and after `git pull`. It fetches the remote's notes, merges them
with yours, and pushes.

Some hosted agent sessions can only push their own branch, so their notes
push is refused. `graft sync` says so and carries on; `graft log` and
`graft review` rebuild the record from the message, minus the output, until
someone runs `graft sync` from a normal clone.

## Review

```
graft review
```

Opens a local page, no server or account, listing recent changes ranked by how
much attention they need. Each change shows the task, plan, and evidence
first, then the diff grouped into behavior, tests, and mechanical files.

| Badge | Meaning |
| --- | --- |
| Needs reading | Behavior changed, no passing test run recorded |
| Verified | Behavior changed, recorded test run passed |
| Mechanical | Only tests, docs, lockfiles, or generated files changed |
| Note missing | The commit has Graft trailers but no evidence list in its message and no note in this clone; run `graft sync` |
| No record | No Graft record on this commit |

The badges come from file paths and recorded evidence. They say where to look
first, not what to approve.

## Use it from code

```ts
import { Graft } from "@fourshore/graft";

const g = new Graft("/path/to/repo");
await g.start({ task: "...", author: { kind: "agent", name: "my-bot" } });
await g.evidenceCommand("npm test", "unit tests");
const { commit, record } = await g.land({ paths: ["src/api.ts"] });
```

## Policy

`.graft/policy.json`, written by `graft init`:

```json
{ "version": 1, "requireEvidence": true, "secretFiles": ["nova.json", "config/*.secret"] }
```

Set `requireEvidence` to `false` to turn off the landing gate for a repo, or
to `"command"` to require at least one recorded command that exited 0, so a
note alone (`--note "checked"`) doesn't pass.
`secretFiles` adds repo-specific globs to the credential guard; `graft init`
doesn't write it, add it when the repo has its own credential file names.
`behaviorFiles` lists globs that `graft review` must treat as behavior even
though they look mechanical, such as a schema or spec kept in Markdown.
`trailers` adds trailers to every landed commit, with `$NAME` or `${NAME}`
filled from the environment, so the lines you would otherwise pass with
`--trailer` on every land cannot be forgotten:

```json
{ "version": 1, "requireEvidence": "command", "trailers": ["Claude-Session: $CLAUDE_SESSION_URL"] }
```

A trailer whose variable is not set is left out of that commit, and `land`
says so, rather than written with an empty value.
`captureCommands` lists extra regular expressions for commands the capture
hooks record on top of the built-in test, build, lint and type-check patterns.
[docs/CHANGE.md](docs/CHANGE.md#where-it-lives) covers what survives rebases,
amends, and squashes.

## Roadmap

| Phase | What | Status |
| --- | --- | --- |
| 0 | Change records on plain git: spec, CLI, MCP server | done |
| 1 | Instant workspaces: copy-on-write checkouts handed to agents through an API | next |
| 2 | Optimistic merge: concurrent landing, conflicts as data an agent can resolve, post-merge checks | |
| 3 | History as a query service; review with re-run evidence and a server-backed queue | started (`graft review`) |

Phases 1 to 3 need a server. Phase 0 doesn't, on purpose, so the record format
gets real use before anything depends on it.

## Development

npm workspace, three packages:

| Package | What |
| --- | --- |
| `packages/core` (`@fourshore/graft-core`) | Record model, git plumbing, start/evidence/land/log/sync |
| `packages/review` (`@fourshore/graft-review`) | Review page and local server |
| `packages/cli` (`@fourshore/graft`) | `graft` and `graft-mcp` |

```
git clone https://github.com/FourShore/Graft.git
cd Graft
npm install
npm run build
npm test
npm link --workspace packages/cli   # point `graft` at this checkout
```

Release: `npm run release -- patch` bumps all packages, commits, and tags.
`git push --follow-tags` publishes to npm from CI via trusted publishing.

This repo uses Graft on itself; `graft log` here shows the records.

## License

MIT
