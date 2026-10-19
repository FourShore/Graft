/** A parsed unified diff, enough to render and to group files. */
export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: "context" | "add" | "del" | "meta";
  text: string;
}

/**
 * Parse `git show`/`git diff` output made with the `a/` and `b/` prefixes.
 * Paths git had to quote (a double quote, a backslash, a control character,
 * or non-ASCII bytes when core.quotePath is on) are unquoted. The `diff --git`
 * header is ambiguous when a path contains " b/", so the `rename from/to`
 * and `---`/`+++` lines, when present, name the file instead.
 */
export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const [oldPath, path] = parseHeader(line.slice("diff --git ".length)) ?? ["", ""];
      file = { path, status: "modified", hunks: [], additions: 0, deletions: 0 };
      if (oldPath !== path) {
        file.oldPath = oldPath;
        file.status = "renamed";
      }
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk && line.startsWith("rename from ")) setOld(file, unquote(line.slice("rename from ".length)));
    else if (!hunk && line.startsWith("rename to ")) setNew(file, unquote(line.slice("rename to ".length)));
    else if (!hunk && line.startsWith("--- ")) {
      const p = diffPath(line.slice(4), "a/");
      if (p !== null) setOld(file, p);
    } else if (!hunk && line.startsWith("+++ ")) {
      const p = diffPath(line.slice(4), "b/");
      if (p !== null) setNew(file, p);
    } else if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("Binary files")) file.status = "binary";
    else if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith("+")) {
        file.additions++;
        hunk.lines.push({ kind: "add", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        file.deletions++;
        hunk.lines.push({ kind: "del", text: line.slice(1) });
      } else if (line.startsWith("\\")) {
        hunk.lines.push({ kind: "meta", text: line });
      } else {
        hunk.lines.push({ kind: "context", text: line.slice(1) });
      }
    }
  }
  for (const f of files) {
    if (f.oldPath === undefined) continue;
    if (f.oldPath === f.path) delete f.oldPath;
    if (f.status === "renamed" && f.oldPath === undefined) f.status = "modified";
  }
  return files.filter((f) => f.path);
}

/** The old path, from a `rename from` or `--- a/` line. */
function setOld(file: DiffFile, p: string): void {
  if (file.status === "added") return;
  if (file.status === "deleted") {
    file.path = p;
    return;
  }
  file.oldPath = p;
  if (!file.path) file.path = p;
}

/** The new path, from a `rename to` or `+++ b/` line. */
function setNew(file: DiffFile, p: string): void {
  file.path = p;
  if (file.oldPath !== undefined && file.oldPath !== p && file.status === "modified") file.status = "renamed";
}

/** The path on a `---`/`+++` line without its prefix, or null for /dev/null. */
function diffPath(s: string, prefix: string): string | null {
  if (s === "/dev/null") return null;
  // git ends a name that contains a space with a tab.
  const t = s.replace(/\t$/, "");
  const p = t.startsWith('"') ? unquote(t) : t;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** The two paths of a `diff --git` header (after the keyword), each quoted or not. */
function parseHeader(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest);
    const a = unquote(rest.slice(0, end));
    const b = rest.slice(end + 1);
    return [strip(a, "a/"), strip(b.startsWith('"') ? unquote(b) : b, "b/")];
  }
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "');
    if (start >= 0) return [strip(rest.slice(0, start), "a/"), strip(unquote(rest.slice(start + 1)), "b/")];
  }
  // Unquoted on both sides: the same name twice when the file was not renamed.
  const same = /^a\/(.+) b\/\1$/.exec(rest);
  if (same) return [same[1], same[1]];
  const m = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return m ? [m[1], m[2]] : null;
}

function strip(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** Index just past the closing quote of the C-style string at the start of `s`. */
function quotedEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i + 1;
  }
  return s.length;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Undo git's C-style quoting of a path: `"caf\303\251.ts"` is `café.ts`. An unquoted path is returned as is. */
export function unquote(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes: number[] = [];
  for (const m of s.slice(1, -1).matchAll(/\\([0-7]{3}|[^])|([^\\]+)/g)) {
    if (m[2] !== undefined) bytes.push(...Buffer.from(m[2], "utf8"));
    else if (/^[0-7]{3}$/.test(m[1])) bytes.push(parseInt(m[1], 8));
    else if (m[1] in ESCAPES) bytes.push(ESCAPES[m[1]]);
    else bytes.push(92, ...Buffer.from(m[1], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}
