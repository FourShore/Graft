# @fourshore/graft-capabilities

What each changed file can now do that it could not before. A capability-diff
analyzer for Node and TypeScript, run as a [Graft](https://github.com/FourShore/Graft#readme)
reviewer command, so the answer lands in the commit's record next to the tests
and `graft check --rerun` makes it again on each commit at the pull request.

Graft's record says what was asked and what was run. The model review says
whether the diff does the task. Neither says that a change to `billing/` now
makes HTTP calls, or that a build script started spawning processes. For code
written mostly by agents, that is the question a human merging at speed most
needs answered, and a deterministic tool answers it better than a model
guessing from the diff: this one resolves the imports.

## Capabilities

A file holds a capability when it imports a module that grants it or uses a
global that grants it. Seven, deliberately few:

| Capability | Granted by |
| --- | --- |
| `fs` | `node:fs`, `node:fs/promises` (`node:path` grants nothing) |
| `net` | `node:http`, `https`, `http2`, `net`, `dns`, `tls`, `dgram`; global `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource` |
| `process` | `node:child_process`, `worker_threads`, `cluster`; `process.exit`, `process.kill`, `process.abort` |
| `env` | `process.env`, also as `import { env } from "node:process"` or `const { env } = process` |
| `eval` | `eval`, `new Function`, `node:vm`, `import()` or `require()` with a computed argument |
| `native` | a `.node` addon, `process.dlopen`, `process.binding` |
| `dep` | a third-party package the table does not know |

A third-party package grants what the built-in table says it grants, by name:
`undici` is `net`, `execa` is `process`, `dotenv` is `env` and `fs`, and
common libraries that reach nothing outside the program (`zod`, `lodash`,
`vitest`) grant nothing. An unknown package grants `dep`, and the finding
names it, so the table grows from what people hit. A repo extends it in the
manifest (`"packages"`, below); the repository's own workspace packages are
project code, not dependencies, as are the files a root `tsconfig.json`'s
`paths` aliases name (`@/lib/utils`). Workspaces come from `package.json` and
from `pnpm-workspace.yaml`.

A file also inherits, one level, the capabilities of the project files it
imports, so a file that starts importing `./git.js` is reported as reaching
`process` through it. Type-only imports grant nothing, `import { type Stats }`
included. A name the file binds itself (its own `fetch`, a parameter called
`process`) is not the global where that binding is in scope, and only there;
a `require` that `createRequire` made and a `process` imported from
`node:process` are the real thing under any name.

## Findings

For each file the commit touched, the capabilities before and after, and the
difference, as a Graft review result:

- A file that **gains** a capability is a `warning`: `net added: calls fetch`.
- A file that **inherits** one through an import it adds is a `nit`:
  `process inherited: imports ./git.js, which imports node:child_process`.
- A file that **loses** one is a `nit`.
- A new entry in a `package.json`'s `dependencies` or `optionalDependencies`
  is a `warning` saying what the table knows of it: `New dependency axios,
  which grants net.`

Warnings do not change the verdict: the check passes, the summary on the pull
request shows the delta, and the human decides. The gate is the manifest.

## The manifest

`.graft/capabilities.json` says what each path may hold:

```json
{
  "version": 1,
  "allow": [
    { "paths": ["src/git.ts", "src/review.ts"], "capabilities": ["process", "fs", "env"] },
    { "paths": ["src/**"], "capabilities": ["fs", "env"] }
  ],
  "packages": { "my-sdk": ["net"] }
}
```

A file may hold the union of the capabilities of every rule whose paths match
it (globs as in the policy, and a glob that starts with `./` is anchored to
the root, so `./index.js` is that file only); a file no rule matches may hold
none. With a manifest, a capability a file gains that its paths do not allow
is a `blocker`, so `graft land` refuses the change and `graft check --rerun`
fails the commit; one its paths allow is a `nit`. So is a file moved to a path
that may not hold what it already holds, and a source file under a manifest
that cannot be read (one over 4 MB).

The manifest is read from the base of the diff (HEAD for the working tree,
the parent at the check), like the policy, so a change cannot widen what it
is checked against: widen the manifest in a commit of its own first. A
commit that leaves the manifest unparseable is refused, and a manifest that
does not parse allows nothing until it is fixed, so breaking it opens no
gate. A merge is compared against git's own re-merge of its parents, as
Graft's check diffs it, so only what the merge itself changed is reviewed.
A base the repository does not have (a shallow clone) is an error, not an
empty review.

`graft-capabilities init` writes the manifest from the tree as it is, one rule per
distinct capability set naming the files that hold it today, so adopting it
on an existing repo starts from "what is, is allowed" and the gate only
catches what changes. It writes a root file as `./name`. Collapse the rules
into globs by hand as you like; `--force` rewrites the rules and keeps
`packages`.

## Install

Install it in the project, so its version is pinned in the lockfile and `npx`
runs that copy rather than fetching a package of that name:

```sh
npm install -D @fourshore/graft-capabilities
```

```json
{
  "reviews": { "capabilities": { "command": "npx --no-install graft-capabilities" } },
  "rules": [{ "paths": ["src/**"], "require": ["capabilities"] }]
}
```

With that in `.graft/policy.json`, `graft evidence capabilities` runs it on
the working tree and records the result, `graft land` requires it for a
change to `src/`, and `graft check --rerun` runs it again on each commit's
own diff with no API key, since it is a command. The commit message line
reads `[review approve capabilities] graft-capabilities/0.2.0 (prompt 4f3a2b1c; 2
findings)` and the findings stay in the note.

`graft-capabilities scan [paths]` prints what each tracked source file holds,
inherited capabilities in parentheses; `--rev <commit>` reads a commit
instead of the working tree.

## What it does not do, on purpose

- No per-function effects. File granularity, because that is what the
  manifest and Graft's triage speak, and per-function needs a type checker.
- No data flow, no "does this `fetch` go to a host it should not". That is
  the model review's job; this tool tells the reviewer where to look.
- No transitive dependency scanning. A new direct dependency is reported;
  what it pulls in is not. `npm audit` and lockfile tools cover that ground.
- No sandbox. The manifest describes what code may do; it does not stop it at
  runtime.

False negatives are accepted: a string-built import, a `require` through a
helper, a capability reached two imports away. False positives are the cost,
and the table and the manifest are how the noise is tuned down.
