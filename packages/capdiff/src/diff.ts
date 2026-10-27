/** A file a diff touched, with where it came from when renamed. */
export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
}

/** The marker Graft leaves where it cut a diff a reviewer is shown. */
export const CUT_MARKER = /^\[\.\.\. \d+ more characters of diff were cut;/m;

/**
 * The files a unified diff touches, from its headers alone. Paths come from
 * the `rename from/to` and `---`/`+++` lines, which are unambiguous, and from
 * the `diff --git` header otherwise.
 */
export function filesInDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let cur: (ChangedFile & { a?: string; b?: string }) | null = null;
  const push = () => {
    if (!cur) return;
    const path = cur.b ?? cur.path;
    const oldPath = cur.a ?? cur.oldPath;
    const status = cur.status === "renamed" ? "renamed" : cur.status;
    files.push({ path, ...(status === "renamed" && oldPath && oldPath !== path ? { oldPath } : {}), status });
    cur = null;
  };
  for (const line of diff.split("\n")) {
    const header = /^diff --git (?:"a\/(.*)"|a\/(.*?)) (?:"b\/(.*)"|b\/(.*))$/.exec(line);
    if (header) {
      push();
      const a = unquote(header[1] ?? header[2] ?? "");
      const b = unquote(header[3] ?? header[4] ?? "");
      cur = { path: b, oldPath: a, status: "modified" };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.a = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      cur.status = "renamed";
      cur.b = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("--- ") && !line.startsWith("--- /dev/null")) cur.a = unquote(stripPrefix(line.slice(4)));
    else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) cur.b = unquote(stripPrefix(line.slice(4)));
  }
  push();
  return files;
}

function stripPrefix(s: string): string {
  const t = s.replace(/\t.*$/, "");
  const q = t.startsWith('"') ? t : null;
  if (q) return q.replace(/^"([ab])\//, '"');
  return t.replace(/^[ab]\//, "");
}

/** A git-quoted path (core.quotePath) back to text. */
export function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  const bytes: number[] = [];
  const inner = s.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = inner[++i];
    if (/[0-7]/.test(n)) {
      const oct = inner.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else {
      bytes.push(...Buffer.from({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" }[n] ?? n, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The files between two revisions, from `git diff-tree --name-status`, which no cap can shorten. */
export function parseNameStatus(zOutput: string): ChangedFile[] {
  const parts = zOutput.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    if (!code) continue;
    if (code[0] === "R" || code[0] === "C") {
      const oldPath = parts[i++];
      const path = parts[i++];
      if (code[0] === "R") files.push({ path, oldPath, status: "renamed" });
      else files.push({ path, status: "added" });
    } else {
      const path = parts[i++];
      if (path === undefined) break;
      files.push({ path, status: code[0] === "A" ? "added" : code[0] === "D" ? "deleted" : "modified" });
    }
  }
  return files;
}
