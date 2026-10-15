# Graft

Graft adds a change record to every git commit: the task the author was given,
the plan, who (or which agent) did the work, and the commands they ran to check
it. The record lives in the commit message as trailers and in a git note, so
nothing about git, GitHub, or your existing tools changes.

It exists because agents now write most of the code in a lot of repos, and the
question six weeks later is rarely "what changed" but "why, and did anyone test
it". Git doesn't keep that. Graft does.

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
`origin`'s fetch list, and writes `.graft/policy.json`. Commit that file.

## Point your agent at it

For Claude Code, register the MCP server:

```
claude mcp add graft -- graft-mcp --repo /path/to/your/repo
```

Then put this in `CLAUDE.md` or `AGENTS.md`:

```markdown
## Version control

This repo uses Graft. Call `graft_start` with your task before editing.
Record each check you run with `graft_evidence` (tests, lint, build) or
`graft_note` (anything checked by hand). Commit with `graft_land`, not
`git commit`. After `git push`, call `graft_sync`. Call `graft_log` when you
need to know why code is the way it is.
```

Tools: `graft_start`, `graft_plan`, `graft_evidence`, `graft_note`,
`graft_land`, `graft_sync`, `graft_status`, `graft_log`, `graft_show`,
`graft_abandon`. `graft_land` commits what's staged plus any `paths` you give
it; `stageAll` is off by default. Agents without MCP can use the CLI below.

## Use it from the shell

```
graft start "Add rate limiting to the public API" --plan "Token bucket per key"
# edit code
graft evidence --label "unit tests" -- npm test
graft evidence --note "Hit the endpoint 200 times; 429 after 100 as expected"
graft land src/api.ts src/api.test.ts -m "Add rate limiting"
graft sync
```

`land` commits what's staged, plus any files you name, or everything with
`-a`. Add your own trailers with `--trailer "Co-Authored-By: ..."` (repeatable;
`trailers` on `graft_land`). It refuses to commit without evidence (`--allow-no-evidence` overrides)
and refuses staged files that look like credentials such as `.env`, `*.pem`,
`*.key` (`--allow-secrets` overrides). Evidence output and notes are scrubbed
of any value held in an environment variable whose name looks secret.

```
graft log            # history as changes: task, author, evidence
graft show <id>      # one change in full, by id or commit
graft status         # the open change, if any
```

The commit ends up looking like this:

```
Add rate limiting

Add rate limiting to the public API

Plan:
  Token bucket per key

Graft-Change: m4z1gs7jgdyp3pj2za9c
Graft-Task: Add rate limiting to the public API
Graft-Author: agent:claude-code
Graft-Model: example-model-1
Graft-Evidence: 1 command, 1 passed; 1 note
```

The full record, including command output, is a note on `refs/notes/graft`.

## Sharing records

Trailers travel with the commit. Notes don't travel on their own, so run
`graft sync` after `git push` and after `git pull`. It fetches the remote's
notes, merges them with yours, and pushes.

Some hosted agent sessions can only push their own branch, so their notes
push is refused. The trailers still land; the full records reach the remote
the next time anyone runs `graft sync` from a normal clone.

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
{ "version": 1, "requireEvidence": true }
```

Set `requireEvidence` to `false` to turn off the landing gate for a repo.
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
