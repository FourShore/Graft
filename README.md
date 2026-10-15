# Graft

Version control for code that agents write. Graft is a layer on top of git that
records what git never did: what the author was asked to do, how they planned to
do it, who or what did the work, and what they ran to prove it works.

It stores all of that in plain git, as commit trailers and a git note, so
GitHub, `git log`, and every tool you already use keep working. Graft never
replaces git; it is grafted onto it.

> Status: Phase 0 plus a first review view. The change record spec, a CLI,
> an MCP server, and `graft review`. See [docs/CHANGE.md](docs/CHANGE.md) for
> the spec and the roadmap at the bottom of this file for what comes next.

## Why

Git was designed for humans who type every line and commit a few times a day.
When an agent writes most of the code, the diff is the cheap part. The expensive
part is knowing, six weeks later, *why* a change exists and *whether anyone
checked it*. That context is produced as a side effect of agent work and thrown
away. Graft captures it at the moment it is cheapest to capture.

## Install

Graft needs Node 20+ and git. It is not on npm yet, so install it from source.
These steps are safe to paste to a coding agent as-is.

```
git clone https://github.com/FourShore/Graft.git ~/graft
cd ~/graft
npm install
npm run build
npm link --workspace packages/cli
```

That puts two commands on your PATH: `graft` and `graft-mcp`. Check with:

```
graft --version
```

To update later: `cd ~/graft && git pull && npm install && npm run build`.
To remove: `npm unlink -g @fourshore/graft`.

Once the package is published, this becomes `npm install -g @fourshore/graft`.

### Set up a repository

In the repository you want to use Graft on:

```
graft init
```

This is safe to run on an existing repository. It changes nothing in your
history. It sets three git config keys so records survive `commit --amend` and
`rebase`, adds the records ref to `origin`'s fetch list, and writes
`.graft/policy.json` (commit that file).

### Tell your coding agent to use it

For Claude Code, register the MCP server once per machine or per repository:

```
claude mcp add graft -- graft-mcp --repo /path/to/your/repo
```

and add this to the repository's `CLAUDE.md` or `AGENTS.md` so the agent knows
the workflow:

```markdown
## Version control

This repository uses Graft. Before editing code, call `graft_start` with the
task you were given. Record every verification you run with `graft_evidence`
(tests, lint, build) or `graft_note` (anything you checked by hand). Commit
with `graft_land`, never with plain `git commit`. Call `graft_log` first when
you need to know why code is the way it is.
```

Agents that cannot use MCP can run the same workflow through the `graft` CLI;
the commands are below.

## Use it from the shell

Once per repo:

```
graft init
```

This makes git carry records through `commit --amend` and `rebase`, adds the
records ref to `origin`'s fetch list, and writes `.graft/policy.json`. Then:

```
graft start "Add rate limiting to the public API" --plan "Token bucket per key"
# ...edit code...
graft evidence --label "unit tests" -- npm test
graft evidence --note "Hit the endpoint 200 times; 429 after 100 as expected"
graft land -a -m "Add rate limiting"
```

`land` refuses to commit without evidence unless you say `--allow-no-evidence`.
That is the point.

Then:

```
graft log            # history as changes: task, author, evidence
graft show <id>      # one change in full, by id or commit
graft status         # the open change, if any
```

What lands in git:

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

plus the full record, with test output, as a note on `refs/notes/graft`.

## Review it as a human

```
graft review
```

opens a local page (no server, no account) that lists recent changes ranked
by how much attention they need, and for each change leads with the claim:
task, plan, and evidence with pass/fail and output. The diff comes after,
grouped into behavior, tests and mechanical files so a reviewer reads what
matters and collapses the rest.

| Badge | Meaning |
| --- | --- |
| Needs reading | Behavior changed and no passing test run is recorded |
| Verified | Behavior changed and the recorded test run passed |
| Mechanical | Only tests, docs, lockfiles or generated files changed |
| No record | The commit has no Graft record at all |

The badges are heuristics on paths and recorded evidence, and the page says
so. They tell a reviewer where to start, not what to approve.

## Use it from an agent

Graft ships an MCP server so agents call it as tools rather than shelling out:

```
claude mcp add graft -- graft-mcp --repo /path/to/repo
```

Tools: `graft_start`, `graft_plan`, `graft_evidence`, `graft_note`,
`graft_land`, `graft_sync`, `graft_status`, `graft_log`, `graft_show`,
`graft_abandon`.
`graft_log` is the one agents should call first: it is how they learn why the
code is the way it is before touching it.

## Use it from code

```ts
import { Graft } from "@fourshore/graft";

const g = new Graft("/path/to/repo");
await g.start({ task: "...", author: { kind: "agent", name: "my-bot" } });
await g.evidenceCommand("npm test", "unit tests");
const { commit, record } = await g.land({ all: true });
```

## Sharing records

Trailers travel with commits. The full records live on `refs/notes/graft`, and
`graft sync` exchanges them with the remote: fetch theirs, merge, push ours.

```
graft sync
```

Run it after `git push` and after `git pull`. The MCP server exposes it as
`graft_sync` so agents can do the same.

## Policy

`.graft/policy.json`, written by `graft init`:

```json
{ "version": 1, "requireEvidence": true }
```

`requireEvidence` is the landing gate. Set it to `false` for a repo where
you don't want it yet. More rules arrive with the review view.

See [docs/CHANGE.md](docs/CHANGE.md#where-it-lives) for what survives rebases,
amends and squashes.

## Roadmap

Graft is being built in phases. Each one is useful on its own.

| Phase | What | Status |
| --- | --- | --- |
| 0 | Change records on plain git: spec, CLI, MCP server | here |
| 1 | Instant workspaces: copy-on-write checkouts handed to agents through an API, no clone | next |
| 2 | Optimistic merge: concurrent landing by footprint, conflicts as structured objects an agent resolves, post-merge checks and auto-revert | |
| 3 | History as a query service; review grows re-run evidence, approve-the-intent and a server-backed queue | started (`graft review`) |

Phases 1 to 3 are a server. Phase 0 is deliberately server-free so the record
format gets used, and fixed, before anything depends on it.

## Development

This is an npm workspace with three packages:

| Package | What |
| --- | --- |
| `packages/core` (`@fourshore/graft-core`) | The record model, git plumbing, start/evidence/land/log/sync |
| `packages/review` (`@fourshore/graft-review`) | The review pages and local server |
| `packages/cli` (`@fourshore/graft`) | The `graft` and `graft-mcp` binaries |

```
npm install
npm test          # all packages
npm run build     # tsc -b across the workspace
node packages/cli/dist/cli.js review
```

Releases: `npm run release -- patch` bumps all three packages to one version,
commits and tags; `git push --follow-tags` then publishes them to npm from CI.
The repository needs an `NPM_TOKEN` secret with publish rights to the
`@fourshore` scope.

This repository uses Graft on itself. Run `graft log` here to see it.

## License

MIT
