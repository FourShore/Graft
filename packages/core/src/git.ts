import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Output git may produce for one call before it is cut off; `run` callers that expect more pass their own. */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

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

  async run(args: string[], opts: { input?: string; env?: Record<string, string>; maxBuffer?: number } = {}): Promise<string> {
    const maxBuffer = opts.maxBuffer ?? GIT_MAX_BUFFER;
    try {
      const child = execFileAsync("git", args, {
        cwd: this.cwd,
        maxBuffer,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      });
      if (opts.input !== undefined && child.child.stdin) {
        child.child.stdin.end(opts.input);
      }
      const { stdout } = await child;
      return stdout.replace(/\n$/, "");
    } catch (err) {
      const e = err as { stderr?: string; message?: string; code?: string | number; signal?: string };
      throw new GitError(`git ${args.join(" ")} failed: ${gitFailure(e, maxBuffer)}`, args, e.stderr ?? "");
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

  /** Paths staged for the next commit, relative to the working tree root, exactly as named (never C-quoted). */
  async stagedFiles(): Promise<string[]> {
    return splitNul(await this.run(["diff", "--cached", "--name-only", "-z"]));
  }

  async hasWorkingTreeChanges(): Promise<boolean> {
    const out = await this.run(["status", "--porcelain"]);
    return out.length > 0;
  }
}

/** A NUL-separated path list (`-z` output) as paths. */
export function splitNul(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/** Why a git call failed, never empty: stderr, else the reason the process ended. */
function gitFailure(e: { stderr?: string; message?: string; code?: string | number; signal?: string }, maxBuffer: number): string {
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return `its output exceeded ${Math.round(maxBuffer / (1024 * 1024))} MB`;
  const stderr = e.stderr?.trim();
  if (stderr) return stderr;
  if (e.code === "ENOENT") return "git is not installed or not on PATH";
  if (e.signal) return `killed by ${e.signal}`;
  if (typeof e.code === "number") return `exit code ${e.code} with no message`;
  return e.message?.trim() || "no message from git";
}

/**
 * The argv of the git process that ran the hook this process is part of, or
 * null when it cannot be told (no /proc and no ps, as on Windows). Walks up a
 * few parents, since a hook script or a wrapper may sit between git and us.
 */
export async function invokingGitArgs(): Promise<string[] | null> {
  let pid = process.ppid;
  for (let depth = 0; depth < 5 && pid > 1; depth++) {
    const proc = await processInfo(pid);
    if (!proc) return null;
    if (/^git(\.exe)?$/i.test(basename(proc.argv[0] ?? ""))) return proc.argv;
    pid = proc.ppid;
  }
  return null;
}

async function processInfo(pid: number): Promise<{ argv: string[]; ppid: number } | null> {
  if (process.platform === "linux") {
    try {
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (argv[argv.length - 1] === "") argv.pop();
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return { argv, ppid };
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-o", "command=", "-p", String(pid)]);
    const m = /^\s*(\d+)\s+(.*)$/.exec(stdout.trim());
    return m ? { ppid: Number(m[1]), argv: m[2].split(/\s+/) } : null;
  } catch {
    return null;
  }
}
