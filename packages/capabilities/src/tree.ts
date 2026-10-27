import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** A tree of files to read: the working tree, or a commit. */
export interface Tree {
  /** The file's text, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  /** Every tracked source path under the tree, for `init` and `scan`. */
  list(): Promise<string[]>;
}

const MAX_FILE = 4 * 1024 * 1024;

export class WorkTree implements Tree {
  private cache = new Map<string, Promise<string | null>>();
  constructor(readonly root: string) {}
  read(path: string): Promise<string | null> {
    let p = this.cache.get(path);
    if (!p) {
      p = (async () => {
        try {
          const s = await stat(join(this.root, path));
          if (!s.isFile() || s.size > MAX_FILE) return null;
          return await readFile(join(this.root, path), "utf8");
        } catch {
          return null;
        }
      })();
      this.cache.set(path, p);
    }
    return p;
  }
  async list(): Promise<string[]> {
    const { stdout } = await execFileP("git", ["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: this.root, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean);
  }
}

export class GitTree implements Tree {
  private cache = new Map<string, Promise<string | null>>();
  constructor(
    readonly root: string,
    readonly rev: string,
  ) {}
  read(path: string): Promise<string | null> {
    let p = this.cache.get(path);
    if (!p) {
      p = execFileP("git", ["show", `${this.rev}:${path}`], { cwd: this.root, maxBuffer: MAX_FILE, encoding: "utf8" })
        .then((r) => r.stdout)
        .catch(() => null);
      this.cache.set(path, p);
    }
    return p;
  }
  async list(): Promise<string[]> {
    const { stdout } = await execFileP("git", ["-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--name-only", this.rev], { cwd: this.root, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean);
  }
}

/** An empty tree: a root commit's parent, or a repository with no commit yet. */
export const EMPTY_TREE: Tree = { read: async () => null, list: async () => [] };

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}
