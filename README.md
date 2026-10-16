# Graft

**Git records what changed. Graft records what was asked, what was run, and
refuses to merge a change that cannot show it.**

Every commit carries a record: the task the author was given, who (or which
agent) did the work, and the commands they ran to check it. It lives in the
commit message as trailers and an `Evidence:` block, so git, GitHub and your
tools keep working as they are. Three things make it more than a convention:

- **The landing gate.** `graft land` refuses a change with no evidence, and a
  policy names the commands each kind of file needs before it may land.
- **The check in CI.** `graft check` fails a pull request whose behavior
  changes carry no evidence that meets the policy, and re-runs the recorded
  commands so a `[pass]` is a fact, not a claim.
- **Capture without ritual.** Hooks record the prompt as the task and every
  test, build or lint run as evidence, so the record exists whether or not the
  agent remembers Graft.

## Why

AI moved the bottleneck. Writing code used to be the slow part. Now an agent
can produce a working change in minutes, and the slow part is deciding whether
to trust it. Nobody can read every diff at the rate agents produce them, and a
diff on its own doesn't say what was asked for or what was checked.

Most of what Graft records you could ask for by convention: a commit template,
a line in CLAUDE.md that says "run the tests". What convention cannot do is
enforce it when the session is lazy, or make it free when the session is
careful. Graft does both. The gate makes "no evidence, no commit" mechanical,
the check makes it hold at the pull request, and the hooks make the record
appear without anyone typing it. For a repo where agents write most of the
commits and CI is thin, that is a new guarantee. For a team with mature CI it
is per-commit evidence and the task link, next to the diff.

Status: early, and used on this repo. See [docs/CHANGE.md](docs/CHANGE.md)
for the record format.

## Install

Needs Node 20+ and git.

```
npm install -g @fourshore/graft
graft --version
```

This installs `graft` and `graft-mcp`. Run the same command to update.

## Set up a repo

```
graft init         # policy, hooks, AGENTS.md section, notes config
graft init --ci    # also a GitHub Actions workflow that runs graft check on every pull request
```

Safe on an existing repo; it doesn't touch history. It writes
`.graft/policy.json`, installs the capture hooks, adds a "Version control"
section to `AGENTS.md`, and sets a few git config keys so the optional notes
survive `commit --amend` and `rebase`. Commit what it writes, including the
edit to `.claude/settings.json`: a per-session `init` leaves a diff until
that change is committed.

## Policy: the definition of done

`.graft/policy.json`, written by `graft init`:

```json
{ "version": 1, "requireEvidence": true, "secretFiles": ["nova.json", "config/*.secret"] }
```

The repo's definition of done goes in the same file, as a catalog of named
commands and rules that say which paths need which:

```json
{
  "version": 1,
  "commands": {
    "test": "go test ./...",
    "vet386": "env GOOS=windows GOARCH=386 go vet ./...",
    "migrate": "hasura migrate apply --dry-run"
  },
  "rules": [
    { "paths": ["**/*.go"], "require": ["test", "vet386"] },
    { "paths": ["hasura/migrations/**"], "require": ["migrate"] }
  ]
}
```

`commands` names the checks once. `graft evidence test` runs one by name,
the capture hooks record a typed command that matches one under its name
(so `cd /abs/repo && go test ./...` counts as `test`), and `graft check
--rerun` runs the name's current definition, so a command can change
without invalidating history. `rules` are checked by `land` against the
staged files and by `check` against each commit: a change that touches a
file matching `paths` must carry a passing run, by Graft or a harness and
not attested, of every name in `require`. `land` refuses otherwise and
says which name to run; `check` fails the commit. A rule that names a
command the catalog does not define is a policy error. This is how the
command list in a repo's CLAUDE.md becomes something the gate enforces
rather than prose.

Set `requireEvidence` to `false` to turn off the landing gate for a repo, or
to `"command"` to require at least one recorded command that exited 0 and
that Graft or a harness ran, so a note alone (`--note "checked"`) or an
attested run (`--attach --exit 0`) doesn't pass.
`secretFiles` adds repo-specific globs to the credential guard; `graft init`
doesn't write it, add it when the repo has its own credential file names.
`behaviorFiles` lists globs that `graft check` must treat as behavior even
though they look mechanical, such as a schema or spec kept in Markdown.
`trailers` adds trailers to every landed commit, with `$NAME` or `${NAME}`
filled from the environment, so the lines you would otherwise pass with
`--trailer` on every land cannot be forgotten:

```json
{ "version": 1, "requireEvidence": "command", "trailers": ["Claude-Session: https://claude.ai/code/session_${CLAUDE_CODE_REMOTE_SESSION_ID#cse_}"] }
```

A trailer whose variable is not set is left out of that commit, and `land`
says so, rather than written with an empty value. `${NAME#prefix}` and
`${NAME%suffix}` strip a literal affix, as in `sh`, for the case above where
the variable carries an id in one spelling and the link needs another.
`captureCommands` lists extra regular expressions for commands the capture
hooks record on top of the built-in test, build, lint and type-check patterns.
`checkCommands` lists regular expressions for the commands `graft check
--rerun` may run again; unset means every recorded passing command.
[docs/CHANGE.md](docs/CHANGE.md#where-it-lives) covers what survives rebases,
amends, and squashes.

## Capture without ritual

`graft init` also installs hooks, so records exist whether or not anyone
remembers Graft:

- **Claude Code hooks** in `.claude/settings.json`. The prompt opens a change
  (the prompt is the task, as the agent received it), and every Bash call that
  looks like a test, build, lint or type-check run is recorded as evidence
  with the exit code and output the harness itself reported, so it is a pass
  or a fail, not a claim. Other commands are ignored. Widen the filter with
  `captureCommands` in the policy. An explicit `graft start` afterwards just
  names the task and keeps what was captured. A captured command that `cd`s
  to an absolute path inside the repository is recorded relative to the root
  (`cd ./pkg && go test ./...`), so it re-runs on another machine. The
  settings file is tracked: `init` edits it in place, and the edit is meant
  to be committed, so a per-session `init` leaves a diff until it is.
- **Git hooks** (`prepare-commit-msg` and `post-commit`). A plain
  `git commit` with a change open gets the Plan and Evidence blocks and the
  trailers in its message and the full record as a note, exactly like
  `graft land`, and the same policy gate applies (`GRAFT_ALLOW_NO_EVIDENCE=1`
  or `GRAFT_ALLOW_SECRETS=1` override it for one commit). Merges, squashes and
  amends are left alone, and a hook that is already there is not overwritten.

The hooks run `graft`, so it has to be on PATH. `graft init --no-hooks` skips
them. Claude Code runs project hooks only after you trust the folder.

## Verify at the pull request

A `[pass]` in a record is the author's word. `graft check` makes it a fact
where a human merges. The shortest route is the reusable action, which
`graft init --ci` writes into `.github/workflows/graft-check.yml`:

```yaml
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      # your install step (npm ci, go mod download, ...), so recorded commands can run
      - uses: FourShore/Graft@main   # pin to a tag or SHA to fix the version
```

The action installs Graft, fetches the notes, and runs the check against the
pull request's base with annotations and a step summary. It re-runs recorded
commands only for branches of the same repository, since a fork's commit
messages are text a stranger wrote; `rerun: "false"` never re-runs, and
`checkCommands` in the policy can restrict what is re-run further. The same
check runs from a shell:

```
graft check --base origin/main            # every behavior change needs evidence that meets the policy
graft check --base origin/main --rerun    # and every recorded passing command is run again, here
```

It walks `base..HEAD`, groups each commit's files into behavior, tests and
mechanical, and fails when a commit that changed behavior has no record, no
evidence, or (under `requireEvidence: "command"`) no passing command that
Graft or a harness ran, and when a commit touched files a policy rule covers
without a passing run of every command the rule names. Commits that only
touch tests, docs or lockfiles need nothing. With `--rerun` each distinct
recorded passing command, attested ones included, runs once from the root of
the current checkout, by its current catalog definition when it was recorded
by name, and a non-zero exit fails the check with the output. A recorded
`graft check --rerun` is run but does not re-run anything itself. A commit
whose trailers promise evidence that only the git note holds fails as "note
missing" and says to fetch `refs/notes/graft`, rather than as a commit with
none. `--base main` resolves to `origin/main` in a clone that has no local
`main`, which is every CI runner.

## Use it from the shell

```
graft start "Add rate limiting to the public API" --plan "Token bucket per key" --ref https://issues.example/42
# edit code
graft evidence test                     # a command the policy names, run by name
graft evidence --label "unit tests" -- npm test
graft evidence --note "Hit the endpoint 200 times; 429 after 100 as expected"
graft land src/api.ts src/api.test.ts -m "Add rate limiting"
```

`start --ref` records where the task came from (a thread, issue or ticket
URL) as a `Graft-Task-Ref` trailer, so a commit links back to the ask.

`evidence <name>` runs a command the policy names (see [Policy](#policy))
and records it under that name; `graft status` lists the names. Otherwise
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
not see it run, and it does not satisfy `requireEvidence: "command"`, since
that policy exists to demand a run Graft or a harness saw. Over MCP, pass
`exitCode` (and `output`) to `graft_evidence`.

`land` commits what's staged, plus any files you name, or everything with
`-a`. Add your own trailers with `--trailer "Co-Authored-By: ..."` (repeatable;
`trailers` on `graft_land`). It refuses to commit without evidence (`--allow-no-evidence` overrides)
and refuses staged files that look like credentials such as `.env`, `*.pem`,
`*.key` (`--allow-secrets` overrides). Evidence output and notes are scrubbed
of any value held in an environment variable whose name looks secret, and the
output of a command that names a credential file (`cat nova.json && go test
./...`, with `nova.json` in `secretFiles`) is withheld from the record
entirely; the command line itself is kept.

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
commits that have no record, with their title and files, and the output says
to pass it when a path's history is all pre-Graft; `--json` returns the
entries with the same text in a `text` field, which is also what
`graft_context` returns.

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
Graft-Evidence: 1 command, 1 passed; 1 note
```

The message is the record: any clone and GitHub's commit view show the task,
plan and evidence list, and every reader (`log`, `show`, `context`, `check`)
works from it. The command output is kept in a git note on `refs/notes/graft`,
a cache that travels only with `graft sync` (see below).

A crashed session can leave a change open in `.git`. `graft start --replace`
drops it and opens the new one; `graft status` shows what is there.

## Point your agent at it

The `AGENTS.md` section that `graft init` writes tells an agent to open a
change before editing, record each check it runs (by name when the policy
names commands), and commit with `graft land`. Most agent harnesses read `AGENTS.md`. Claude Code
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

## Command output and notes

The commit message carries everything a reader or the check needs: the task,
the plan, the evidence list with each command, exit code and duration, and
the trailers. It travels with a plain `git push` and survives rebase and
cherry-pick. The one thing it does not carry is command output, which Graft
keeps in a git note on `refs/notes/graft` as a cache. Notes do not travel on
their own: `graft sync` pushes and fetches them when you want the output in
another clone, and nothing else depends on them. Some hosted agent sessions
cannot push the notes ref at all; `graft sync` says so and carries on, and
every reader works from the message as usual.

## Use it from code

```ts
import { Graft } from "@fourshore/graft";

const g = new Graft("/path/to/repo");
await g.start({ task: "...", author: { kind: "agent", name: "my-bot" } });
await g.evidenceCommand("npm test", "unit tests");
const { commit, record } = await g.land({ paths: ["src/api.ts"] });
```

## Roadmap

| Phase | What | Status |
| --- | --- | --- |
| 0 | Change records on plain git: spec, CLI, MCP server | done |
| 1 | Instant workspaces: copy-on-write checkouts handed to agents through an API | next |
| 2 | Optimistic merge: concurrent landing, conflicts as data an agent can resolve, post-merge checks | |
| 3 | History as a query service: CI-verified evidence as a second tier, changes that span repos, the artifact a commit produced | next after 0.1 |

Phases 1 to 3 need a server. Phase 0 doesn't, on purpose, so the record format
gets real use before anything depends on it.

## Development

npm workspace, three packages:

| Package | What |
| --- | --- |
| `packages/core` (`@fourshore/graft-core`) | Record model, git plumbing, start/evidence/land/log/sync |
| `packages/review` (`@fourshore/graft-review`) | Triage of a diff by evidence, and `graft check` |
| `packages/cli` (`@fourshore/graft`) | `graft` and `graft-mcp` |

```
git clone https://github.com/FourShore/Graft.git
cd Graft
npm install
npm run build
npm test
node packages/cli/dist/cli.js       # run `graft` from this checkout
```

Release: `npm run release -- patch` bumps all packages, commits, and tags.
`git push --follow-tags` publishes to npm from CI via trusted publishing.

This repo uses Graft on itself; `graft log` here shows the records.

## License

MIT
