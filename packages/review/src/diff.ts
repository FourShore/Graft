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

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of raw.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      file = { path: header[2], status: "modified", hunks: [], additions: 0, deletions: 0 };
      if (header[1] !== header[2]) {
        file.oldPath = header[1];
        file.status = "renamed";
      }
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) file.status = "added";
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
  return files;
}
