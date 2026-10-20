---
name: init
description: Use when asked to set up, add, install or adopt Graft in a repository, or to make a repo refuse commits without evidence. Runs graft init, reviews the policy it wrote and commits the result.
---

# Set up Graft in a repo

Graft makes "no evidence, no merge" mechanical: a commit that cannot show
the checks the repo's policy names is refused, and `graft check` fails a
pull request that carries one anyway. Setting it up is one command plus a
review of what it wrote.

## Steps

1. Make sure the binary is there. `graft --version`; if that fails:

   ```
   npm install -g @fourshore/graft
   ```

   This plugin cannot install it for the user. Say so and give the command
   when npm is not available to you.

2. Run init from the repository root:

   ```
   graft init          # policy, hooks, AGENTS.md section, notes config
   graft init --ci     # also .github/workflows/graft-check.yml, the check on every pull request
   ```

   It is safe on an existing repo and does not touch history. It reads
   `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, a Maven or
   Gradle build or a `Gemfile`, and fills `.graft/policy.json` with the
   test, lint, type-check and build commands they define, plus a rule that
   source changes need a passing test run. It writes capture hooks for the
   agents it finds (Claude Code always; Codex, Cursor, Copilot CLI and
   Gemini CLI when their config directory is present), or all five with
   `--capture all`.

3. Show the user `.graft/policy.json` and adjust it to the repo: the
   `commands` catalog names each check once, and `rules` say which paths
   need which. A rule's command must exist in the catalog. Keep the rules
   to what the repo can actually run; a check that cannot pass locally
   makes every commit need an override.

4. Commit everything init wrote: the policy, the hook files, the
   `AGENTS.md` section (and a `@AGENTS.md` line in `CLAUDE.md` so Claude
   Code reads it), the workflow. That commit itself goes through the gate:
   record evidence first (`graft evidence --note "ran graft init and
   reviewed the policy"` is enough for a setup commit), then
   `git commit` with the git hooks, or `graft land <paths> -m "<title>"`.

5. Tell the user what changed and what now happens: their prompts open
   changes, their test, build and lint runs are recorded, and a commit
   without the policy's checks is refused.

## When this plugin is enabled

The plugin already runs the Claude Code capture hooks, so the repo's own
`.claude/settings.json` from `init` is for contributors without the plugin.
Where both are present the repo's hooks win and nothing is recorded twice.
A repo that wants no prompt text in its history sets `"task": "named"` in
the policy; the hooks then open a placeholder change that `graft start`
must name before the commit goes through.
