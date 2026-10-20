---
name: workflow
description: Use when a repo uses Graft (a .graft/policy.json, Graft-Change trailers in git log, or "graft" in AGENTS.md) and you are about to edit, run checks or commit, or when a commit is refused for missing evidence. Covers naming the change, recording evidence and committing. Setting Graft up in a repo is the graft:init skill.
---

# Graft: no evidence, no merge

Graft refuses a commit that cannot show what was asked and what was run to
check it, and `graft check` fails a pull request that carries one anyway.
With this plugin enabled, your prompt already opened a change and every
test, build or lint command you run through Bash is recorded with its exit
code. Two things are yours.

## Name the change

```
graft start "<the task, in the words you were given>"
```

If the prompt opened one, this only names it. If another session left one
open, add `--replace`. Where the policy says `"task": "named"`, the prompt was
not recorded and this step is required before the commit will go through.

## Record the checks, then commit

`graft status` lists the commands the policy names and which files need
which. Run them so the exit code is yours to see, not hidden behind a pipe:

```
graft evidence test                      # a policy command, by name
graft evidence -- npm run lint           # any command
graft evidence --note "<what you checked by hand>"
```

A run from before your last edit does not count; run it again. Then commit.
With the git hooks installed (`graft status` says), a plain `git commit`
carries the record. Without them:

```
graft land <paths> -m "<title>"
```

Either refuses a change whose evidence is missing and says which command to
run. Do not pass `--allow-no-evidence` or set `GRAFT_ALLOW_NO_EVIDENCE` unless
the user asked for that commit to land unchecked; it is written into the
commit as `Graft-Override`.

Before editing a file, `graft context <paths>` shows the changes that touched
it: their task, evidence and what they tried that did not work.

## If the commit is refused

Read the message: it names the command to run (`graft evidence test`) or the
file that looks like a credential. Run the check and commit again. Do not
retry with an override to get past it.
