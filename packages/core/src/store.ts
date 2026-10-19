import { mkdir, open as openFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Git } from "./git.js";
import type { Attempt, ChangeRecord, Evidence } from "./record.js";

export interface SessionTask {
  sessionId: string;
  task: string;
}

/** How long to wait for another Graft process to finish with the open change. */
const LOCK_WAIT_MS = 10_000;
/** A lock older than this was left by a process that died; take it over. */
const LOCK_STALE_MS = 30_000;

/**
 * Where the currently open change lives: inside .git so it never gets
 * committed and follows the worktree, not the branch.
 *
 * Several Graft processes can touch it at once (an agent's parallel Bash
 * calls each fire a capture hook), so every write goes to a temporary file
 * that is renamed into place, and read-modify-write sequences hold a lock
 * file next to it.
 */
export class OpenChangeStore {
  constructor(private readonly git: Git) {}

  private async dir(): Promise<string> {
    const dir = join(await this.git.gitDir(), "graft");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async path(): Promise<string> {
    return join(await this.dir(), "open.json");
  }

  async read(): Promise<ChangeRecord | null> {
    const file = await this.path();
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      return JSON.parse(raw) as ChangeRecord;
    } catch {
      throw new Error(
        `The open change in ${file} is not valid JSON (an interrupted write?). ` +
          `Move it aside to start over: mv "${file}" "${file}.broken"`,
      );
    }
  }

  async write(record: ChangeRecord): Promise<void> {
    await writeAtomic(await this.path(), JSON.stringify(record, null, 2) + "\n");
  }

  async clear(): Promise<void> {
    await rm(await this.path(), { force: true });
  }

  /**
   * Append evidence to the open change under the lock, re-reading it first so
   * a run that finished while another process recorded something does not
   * overwrite it. Returns false, recording nothing, when the change `id` is no
   * longer the open one (it landed or was abandoned while the command ran).
   */
  async appendEvidence(id: string, ev: Evidence): Promise<boolean> {
    return this.withLock(async () => {
      const current = await this.read();
      if (!current || current.id !== id) return false;
      current.evidence.push(ev);
      await this.write(current);
      return true;
    });
  }

  /** Run `fn` holding the store's lock file. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = join(await this.dir(), "open.lock");
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
      try {
        const handle = await openFile(lock, "wx");
        await handle.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) {
          await rm(lock, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error(`Another Graft process holds ${lock}. If none is running, delete the file.`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }

  private async sessionPath(): Promise<string> {
    return join(await this.dir(), "session.json");
  }

  /** The last task a capture hook saw a harness session given, so a "continue" or a second commit in that session keeps it. */
  async readSession(): Promise<SessionTask | null> {
    try {
      return JSON.parse(await readFile(await this.sessionPath(), "utf8")) as SessionTask;
    } catch {
      return null;
    }
  }

  async writeSession(session: SessionTask): Promise<void> {
    await writeAtomic(await this.sessionPath(), JSON.stringify(session, null, 2) + "\n");
  }

  private async attemptsPath(): Promise<string> {
    return join(await this.dir(), "attempts.json");
  }

  /** Abandoned changes waiting to be folded into the next land, oldest first. */
  async readAttempts(): Promise<Attempt[]> {
    try {
      return JSON.parse(await readFile(await this.attemptsPath(), "utf8")) as Attempt[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async addAttempt(attempt: Attempt): Promise<void> {
    await this.withLock(async () => {
      const all = await this.readAttempts();
      all.push(attempt);
      await writeAtomic(await this.attemptsPath(), JSON.stringify(all, null, 2) + "\n");
    });
  }

  async clearAttempts(): Promise<void> {
    await rm(await this.attemptsPath(), { force: true });
  }
}

/** Write to a sibling temporary file and rename it over the target, so a reader never sees half a file. */
async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, content);
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
