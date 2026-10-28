import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** A tree of files to read: the working tree, or a commit. */
export interface Tree {
  /** The file's text, or null when it does not exist. Throws TooLargeError for a file past the size limit, which is not read and must not pass as empty. */
  read(path: string): Promise<string | null>;
  /** Every tracked source path under the tree, for `init` and `scan`. */
  list(): Promise<string[]>;
}

const MAX_FILE = 4 * 1024 * 1024;

export class TooLargeError extends Error {
  constructor(path: string) {
    super(`${path} is larger than ${MAX_FILE / 1024 / 1024} MB, so it was not read`);
  }
}

export class WorkTree implements Tree {
  private cache = new Map<string, Promise<string | null>>();
  constructor(readonly root: string) {}
  read(path: string): Promise<string | null> {
    let p = this.cache.get(path);
    if (!p) {
      p = (async () => {
        try {
          const s = await stat(join(this.root, path));
          if (!s.isFile()) return null;
          if (s.size > MAX_FILE) throw new TooLargeError(path);
          return await readFile(join(this.root, path), "utf8");
        } catch (e) {
          if (e instanceof TooLargeError) throw e;
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
        .catch((e: { code?: string }) => {
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new TooLargeError(path);
          return null;
        });
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

/** The tree git's automatic merge of two commits gives, conflicts and all: what a merge's remerge diff is against. */
export async function remergeTree(cwd: string, a: string, b: string): Promise<string | undefined> {
  const out = await new Promise<string>((resolve) => {
    // merge-tree exits 1 on conflicts and still prints the tree on its first line.
    execFile("git", ["merge-tree", "--write-tree", "--no-messages", a, b], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (_err, stdout) => resolve(stdout ?? ""));
  });
  const tree = out.split("\n")[0]?.trim();
  return tree && /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined;
}

