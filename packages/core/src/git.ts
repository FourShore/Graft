import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** Thin wrapper around the git binary, scoped to one working directory. */
export class Git {
  constructor(public readonly cwd: string) {}

  async run(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
    try {
      const child = execFileAsync("git", args, {
        cwd: this.cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      });
      if (opts.input !== undefined && child.child.stdin) {
        child.child.stdin.end(opts.input);
      }
      const { stdout } = await child;
      return stdout.replace(/\n$/, "");
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new GitError(
        `git ${args.join(" ")} failed: ${(e.stderr ?? e.message ?? "").trim()}`,
        args,
        e.stderr ?? "",
      );
    }
  }

  /** Absolute path of the .git directory (handles worktrees). */
  gitDir(): Promise<string> {
    return this.run(["rev-parse", "--absolute-git-dir"]);
  }

  /** Absolute path of the working tree root. */
  topLevel(): Promise<string> {
    return this.run(["rev-parse", "--show-toplevel"]);
  }

  async head(): Promise<string | null> {
    try {
      return await this.run(["rev-parse", "--verify", "HEAD"]);
    } catch {
      return null;
    }
  }

  async hasStagedChanges(): Promise<boolean> {
    return (await this.stagedFiles()).length > 0;
  }

  /** Paths staged for the next commit, relative to the working tree root. */
  async stagedFiles(): Promise<string[]> {
    const out = await this.run(["diff", "--cached", "--name-only"]);
    return out.split("\n").filter(Boolean);
  }

  async hasWorkingTreeChanges(): Promise<boolean> {
    const out = await this.run(["status", "--porcelain"]);
    return out.length > 0;
  }
}
