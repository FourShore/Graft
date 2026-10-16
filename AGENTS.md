# Working on Graft

Build with `npm run build` and test with `npm test`. When `graft` is not on
your PATH, run it as `node packages/cli/dist/cli.js`. Dogfood: every commit to
this repo is landed with Graft, so the section below applies here too.

## Version control

This repo uses Graft (https://github.com/FourShore/Graft). Every commit records
the task you were given, your plan, and the checks you ran, so the next reader
knows why the code is the way it is.

- Before editing, open a change: `graft start "<the task, in the words you were given>"`.
  If the capture hooks are installed your prompt already opened one and this
  just names the task. If it says a change is already open from another session,
  use `graft start --replace`.
- Record each check as you run it: `graft evidence --label "unit tests" -- npm test`,
  or `graft evidence --note "<what you checked by hand>"` for anything manual.
  When `.graft/policy.json` names commands, run them by name (`graft evidence test`);
  `graft status` lists the names, and they are what the landing gate checks.
- Commit with `graft land <paths> -m "<title>"`, not `git commit`. It refuses to
  land without evidence.
- After `git push`, run `graft sync` so the full records reach the remote.
- Before editing a file, run `graft context <paths>` to read the changes that
  touched it. To learn why code is the way it is, run `graft log` or `graft show <id>`.

With the Graft MCP server the same steps are `graft_start`, `graft_evidence`,
`graft_note`, `graft_land`, `graft_sync`, `graft_context` and `graft_log`.
