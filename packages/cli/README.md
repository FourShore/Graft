# Graft

**No evidence, no merge.** Graft refuses a commit that cannot show what was
asked and what was run to check it, and fails the pull request that carries
one anyway.

```
$ git commit -m "Add rate limiting"
graft: No evidence recorded. Run `graft evidence -- <command>` or set GRAFT_ALLOW_NO_EVIDENCE=1 for this commit.

$ graft evidence test
Recorded test: npm test -> exit 0 (12.3s)

$ git commit -m "Add rate limiting"
graft: added change m4z1gs7jgdyp3pj2za9c to the commit message
```

The commit that lands says what the refused one could not:

```
Add rate limiting

Evidence:
  [pass test] npm test (12.3s)

Graft-Change: m4z1gs7jgdyp3pj2za9c
Graft-Task: Add rate limiting to the public API
Graft-Task-Ref: https://claude.ai/code/session_01ABC
Graft-Author: agent:claude-code
Graft-Evidence: 1 command, 1 passed
```

It is all in the commit message, as trailers and an `Evidence:` block, so git,
GitHub and your tools keep working as they are. Three things hold the line:

- **The gate.** A commit with no evidence, or without the checks the policy
  names for the files it touches, is refused: by `graft land`, and by a plain
  `git commit` once the hooks are in.
- **The check.** `graft check` fails a pull request whose behavior changes
  carry no evidence that meets the policy, and `--rerun` runs the recorded
  commands again so a `[pass]` is a fact, not a claim.
- **The capture.** Hooks for Claude Code, Codex, Cursor, Copilot CLI and
  Gemini CLI record the prompt as the task and every test, build or lint run
  as evidence, with the exit code the agent's own harness reported, so the
  record exists whether or not the agent remembers Graft.

```
npm install -g @fourshore/graft
graft init          # policy, hooks for the agents you use, AGENTS.md section
graft init --ci     # and a GitHub Actions workflow that runs graft check on every pull request
```

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

Status: early, and used on this repo. See [docs/CHANGE.md](https://github.com/FourShore/Graft/blob/main/docs/CHANGE.md)
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
hook files: a per-session `init` leaves a diff until that change is committed.

Which agents get hooks is decided by what is around: Claude Code always, and
Codex, Cursor, Copilot CLI or Gemini CLI when the repo or your home directory
has its config directory. `graft init --capture all` writes all five, for a
repo other people will clone, and `--capture codex,gemini` names a set.

## Policy: the definition of done

`.graft/policy.json`, written by `graft init`. When the repo has a
`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, Maven or Gradle
build, or `Gemfile`, init fills in the test, lint, type-check and build
commands those files already define and a rule that source changes need a
passing test run, so the gate means something from the first commit. With
none of them it writes the bare form:

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
says which name to run; `check` fails the commit. The run must also be of
the files being committed: every run records a hash of the working tree it
checked, and a run whose tree differs from what is being committed in a
file the rule covers (an edit after the run, or an unstaged edit the run
saw and the commit leaves out) is `stale`, which `land` refuses the same way (`graft evidence test` again) and
which the message records as `[stale test]` if it lands anyway. A rule that
names a command the catalog does not define is a policy error. This is how the
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
`ref` is a template with the same expansion for where a task came from, so
every change carries a `Graft-Task-Ref` without anyone passing `--ref`:

```json
{ "version": 1, "ref": "https://claude.ai/code/session_${CLAUDE_CODE_REMOTE_SESSION_ID#cse_}" }
```

The capture hook's change gets it when the prompt opens one, an explicit
`graft start --ref` overrides it, and a change is left without a ref rather
than given a half-filled one when the variable is unset. Without a `ref`
template two sources still fill it: a Claude Code cloud session's own link,
from the session variable above, and a session trailer another tool already
put in the commit message (`Claude-Session` from Claude Code, `Agent-Logs-Url`
from Copilot, `Entire-Checkpoint` from Entire, recorded as `entire:<id>`), so
the task link is there whichever tool wrote the commit.
`task` says what the record may hold about the task. The default, `"captured"`,
lets the capture hooks record the prompt as the task. `"named"` keeps every
prompt out of the record: the hooks still open a change and record the runs,
but the task is a placeholder until `graft start "<task>"` names it, and the
gate refuses to land a placeholder with no override. Use it where prompts
carry customer names or plans that must not become permanent history, and
tell the agent (the `AGENTS.md` section does) to name the task in the words
it was given.
`captureCommands` lists extra regular expressions for commands the capture
hooks record on top of the built-in test, build, lint and type-check patterns.
`checkCommands` lists regular expressions for recorded commands outside the
catalog that `graft check --rerun` may run again; each must match the whole
command. Unset, only catalog commands are re-run (a run recorded under a
name, or whose text is a catalog command), since anything else is text from a
commit message.
[docs/CHANGE.md](https://github.com/FourShore/Graft/blob/main/docs/CHANGE.md#where-it-lives) covers what survives rebases,
amends, and squashes.

## Capture without ritual

`graft init` also installs hooks, so records exist whether or not anyone
remembers Graft:

- **Agent hooks.** The prompt opens a change (the prompt is the task, as the
  agent received it), and every shell call that looks like a test, build,
  lint or type-check run is recorded as evidence with the exit code and
  output the agent's own harness reported, so it is a pass or a fail, not a
  claim. Other commands are ignored. Widen the filter with `captureCommands`
  in the policy. An explicit `graft start` afterwards just names the task and
  keeps what was captured. One hook command serves every agent, `graft hook
  <agent>`, and `init` writes it where each one reads its hooks:

  | Agent | Hook file | Events |
  | --- | --- | --- |
  | Claude Code | `.claude/settings.json` | `UserPromptSubmit`, `PostToolUse` and `PostToolUseFailure` for `Bash` |
  | Codex | `.codex/hooks.json` | `UserPromptSubmit`, `PostToolUse` for `Bash` |
  | Cursor | `.cursor/hooks.json` | `beforeSubmitPrompt`, `postToolUse` for `Shell` |
  | Copilot CLI | `.github/hooks/graft.json` | `userPromptSubmitted`, `postToolUse` |
  | Gemini CLI | `.gemini/settings.json` | `BeforeAgent`, `AfterTool` for `run_shell_command` |

  A captured command that `cd`s to an absolute path inside the repository is
  recorded relative to the root (`cd ./pkg && go test ./...`), and one typed
  in a subdirectory gets that `cd` in front, so it re-runs on another
  machine. A run whose exit code is not the check's (`npm test | tail`,
  `npm test || true`, `npm test; echo`, a background run) is not recorded,
  and neither is one whose harness reported no exit code at all, which Cursor
  and Copilot CLI sometimes do; the hook tells the agent so, and to run it
  with `graft evidence <name>` or `set -o pipefail`. A change opened by one
  session does not take runs from another session in the same worktree. A
  short reply such as "continue" does not open a change with "continue" as
  its task: the session's last real prompt is used. The hook files are
  tracked: `init` edits them in place, and the edit is meant to be committed,
  so a per-session `init` leaves a diff until it is.
- **Git hooks** (`prepare-commit-msg` and `post-commit`). A plain
  `git commit` with a change open gets the Plan and Evidence blocks and the
  trailers in its message and the full record as a note, exactly like
  `graft land`, and the same policy gate applies (`GRAFT_ALLOW_NO_EVIDENCE=1`
  or `GRAFT_ALLOW_SECRETS=1` override it for one commit, and the commit then
  carries a `Graft-Override` trailer; `0`, `false` or empty do not).
  Trailers the message already ends with (`Co-Authored-By`, `Claude-Session`)
  stay in the last paragraph, after the record, so git still reads them as
  trailers. Merges, squashes, amends of a commit that already carries a
  record, and the commits git makes for a rebase, cherry-pick or revert are
  left alone, and a hook that is already there is not overwritten. A message
  given with `-m` or `-F` is kept as written, so `git commit -m "#42 fix the
  crash"` keeps its subject.

The hooks run `graft`. Where it is not on PATH they step aside: a commit goes
through unrecorded with a one-line install hint, for `graft check` to catch at
the pull request, and the agent hooks do nothing (Cursor's still answers
`continue`, so the prompt is not blocked). `graft status` says whether the
clone has the git hooks. `graft init --no-hooks` skips them. Claude Code runs
project hooks only after you trust the folder.

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
      - uses: FourShore/Graft@v0   # v0 moves with each 0.x release; @v0.1.0 or that tag's SHA stays on one
```

Each release sets the action's `version` input to its own version, so pinning
a release tag, or its commit SHA, also pins the Graft it installs; a SHA
between releases installs the version the last release set, and `version:`
overrides it. The action installs Graft, fetches the notes, and runs the
check against the pull request's base with annotations and a step summary.
On `merge_group` it checks from the queue's base commit and on `push` from the
commit before the push (a push that creates a branch is skipped); other events
need the `base` input. It re-runs recorded commands only for branches of the
same repository, since a fork's commit messages are text a stranger wrote;
`rerun: "false"` never re-runs, and even when it re-runs, only the policy's
catalog commands and those matching `checkCommands` are run. With
`comment: "true"` it also posts the summary table as one pull request comment,
updated in place on each run; the workflow then needs
`permissions: pull-requests: write`. The same check runs from a shell:

```
graft check --base origin/main            # every behavior change needs evidence that meets the policy
graft check --base origin/main --rerun    # and the recorded commands the policy allows are run again, here
```

It walks `base..HEAD` against the policy as the base has it, so a pull request
cannot relax the rules it is checked against (a branch that changes
`.graft/policy.json` gets a note saying so; only when the base has no policy,
the pull request that adopts Graft, is the branch's own used). It groups each
commit's files into behavior, tests and mechanical (a renamed file by the
stricter of its old and new path), and fails when a commit that changed
behavior has no record, no evidence, or (under `requireEvidence: "command"`)
no passing command that
Graft or a harness ran, and when a commit touched files a policy rule covers
without a passing run of every command the rule names. A commit that only
touches tests needs evidence too, since a weakened assertion is the cheapest
way to green; commits that only touch docs, lockfiles or generated files need
nothing. A commit landed past the gate with an override carries a
`Graft-Override` trailer, which the check shows on its line and, on GitHub,
as a warning. A merge commit is checked by what it changed beyond merging
its parents (`git show --remerge-diff`, git 2.36 or newer; older git skips
merges with a note), so an edit slipped into a merge needs a record like any
other. A range with no commits fails, since the base or the checkout is wrong,
and so does one with more commits than `--limit` (200) rather than being cut
short; a shallow clone is refused (check out with `fetch-depth: 0`).

Without `--rerun` the output says that the recorded evidence was not re-run,
so every pass in it is the author's claim. With `--rerun` each distinct
recorded passing command, attested ones included, runs once from the root of
the current checkout and each commit's line says whether its commands passed
again, failed or were not run; a non-zero exit fails the check with the
output. Only the catalog's commands are run by default, by the base policy's
current definition when recorded by name or as the catalog's text; any other
recorded command runs only when it fully matches a `checkCommands` pattern,
and is otherwise listed as not re-run without failing the check. A recorded
`graft check --rerun` is run but does not re-run anything itself. A commit
whose trailers promise evidence that only the git note holds fails as "note
missing" and says to fetch `refs/notes/graft`, rather than as a commit with
none. `--base main` resolves to `origin/main` in a clone that has no local
`main`, which is every CI runner; with no `--base` the check uses
`origin/main`, else `origin/master`, and otherwise asks for one. With
`--format github` the step summary has each commit's task, and the text log,
which carries re-run output, is fenced off with `::stop-commands::` so
nothing in it is read as a workflow command.

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
`trailers` on `graft_land`). It refuses to commit without evidence (`--allow-no-evidence` overrides, and says so in a `Graft-Override` trailer)
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
abandons it and opens the new one; `graft status` shows what is there.

## Keeping what did not work

Git keeps nothing of a change that was never committed, so every agent
rediscovers the dead ends. Graft keeps them:

```
graft abandon --reason "a global bucket made 429s nondeterministic"
graft revert <id> --reason "greets in the wrong language"
```

`abandon` closes the open change and keeps what it tried: the task, plan,
reason and evidence. The next change that lands in that worktree carries it
in a `Tried:` block in the commit message (and in full in the note), so the
record of the change that worked names the attempts that did not. A change
with nothing tried (no plan, reason or evidence) leaves nothing behind;
`--discard` keeps nothing on purpose. `graft start --replace` keeps the
change it replaces the same way.

`revert` runs `git revert --no-commit` on a landed change and opens a change
whose task names what is being undone and whose plan is the reason, with a
`Graft-Reverts` trailer pointing at the original. Record evidence and land it
like any other change; `graft context` then shows the revert next to the
change it undid.

## Following a change out of the repo

```
graft artifact dist/nova.exe            # records its SHA-256 on the open change
graft show 3b1f…e9                      # later: the change that produced that file
graft export > changes.jsonl            # every recorded change with its diff, one per line
```

`artifact` records a file the change produced, by content hash, as a
`Graft-Artifact` trailer; `--sha256 <hex> --name <file>` records one that is
not on this machine. A binary found on an office machine then resolves to the
task, the plan and the evidence that shipped it. `export` writes the (task,
diff, evidence) rows a repository has accumulated as JSON lines, newest first,
for a script or a model; `--all` adds commits without a record and `--no-diff`
leaves the diff out.

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
`graft_abandon`, `graft_revert`. `graft_land` commits what's staged plus any `paths` you give
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

## What's next

Everything below runs on plain git and the CLI. Nothing in this repository
needs a server; the record format is designed so a service that wants to read
it can, without Graft having to be one.

- **CI as a second tier of evidence.** `graft check --rerun` emits a result
  the pull request summary and `graft show` can tell apart from the author's
  run, so author-run and CI-verified are visible everywhere.
- **A log across repositories.** `graft start --id` already lands one change
  in several repositories; a `graft log` that reads several clones and groups
  by change id follows when someone needs it.
- **The agent as installer.** A skill and an `AGENTS.md` template, so an agent
  setting up a repository runs `graft init` the way it writes a `.gitignore`.

Earlier roadmaps here described instant workspaces, optimistic merging and a
history query service. Those need a server and are not planned in this
repository.

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
