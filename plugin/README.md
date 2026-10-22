# Graft for Claude Code

The Claude Code plugin for [Graft](https://github.com/FourShore/Graft):
no evidence, no merge. With it enabled, your prompt opens a change, every
test, build or lint run you make is recorded with its exit code, and a
commit that cannot show the checks the repo's policy names is refused.

```
npm install -g @fourshore/graft
/plugin install graft --marketplace fourshore/graft
```

The first line is the binary the hooks call, 0.2.0 or newer (the plugin
runs `graft hook claude-code --plugin`, which earlier versions do not have);
the plugin cannot install or update it for you and says so at session start
when it is missing or too old. The second works on
Claude Code 2.1.275 or later; before that, `/plugin marketplace add
FourShore/Graft` then `/plugin install graft@fourshore`.

What the plugin carries:

- **Hooks** (`hooks/hooks.json`): `UserPromptSubmit` opens a change with
  the prompt as its task, and `PostToolUse` and `PostToolUseFailure` for
  `Bash` record each test, build, lint or type-check run with the exit code
  Claude Code reported. Where a repo's own `.claude/settings.json` already
  runs the capture hook (what `graft init` writes), the plugin's copy steps
  aside, so nothing is recorded twice.
- **Skills**: `graft:init` sets Graft up in a repo and reviews the policy
  it wrote; `graft:workflow` is how to name the change, record evidence and
  commit, and what to do when a commit is refused.
- **MCP server** (`.mcp.json`): `graft-mcp`, with `graft_start`,
  `graft_evidence`, `graft_land`, `graft_context` and the rest as tools, for
  the agent that prefers tools to the shell.

The git side (the `prepare-commit-msg` gate and the `post-commit` note) is
per clone and is still written by `graft init`; the plugin does not reach
into `.git`.
