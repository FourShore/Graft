# AGENTS.md section for a repo that uses Graft

`graft init` appends this to the repo's `AGENTS.md` (and leaves it alone
when `AGENTS.md` or `CLAUDE.md` already mentions Graft). Copy it by hand
into a repo set up another way, and put a line `@AGENTS.md` in `CLAUDE.md`
so Claude Code reads it.

---

## Version control

This repo uses Graft (https://github.com/FourShore/Graft): every commit carries
the task it was given, the checks that ran and whether they passed, and a commit
without them is refused. Two things are yours.

- `graft start "<the task, in the words you were given>"` names the change.
  Where the capture hooks are installed (Claude Code, Codex, Cursor, Copilot
  CLI, Gemini CLI), your prompt already opened one and this only names it; if
  another session left one open, add `--replace`.
- Run the repo's checks before committing. `.graft/policy.json` names them and
  says which files need which; `graft status` lists them. `graft evidence <name>`
  runs one by name and records the result, in any agent. With the hooks, the
  test, build and lint runs you make are recorded as you make them, unless the
  exit code is hidden (`npm test | tail`) or your agent does not report it.
  `graft evidence --note "<what you checked>"` records a manual check. A check
  that ran before your last edit does not count.

Then commit. `graft status` says whether this clone has the git hooks: with
them, a plain `git commit` carries the record; without them, use
`graft land <paths> -m "<title>"`. Either refuses a change whose checks are
missing.

Before editing a file, `graft context <paths>` shows the changes that touched
it. Over MCP the same steps are `graft_start`, `graft_evidence`, `graft_land`
and `graft_context`.
