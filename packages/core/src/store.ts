import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Git } from "./git.js";
import type { Attempt, ChangeRecord } from "./record.js";

/**
 * Where the currently open change lives: inside .git so it never gets
 * committed and follows the worktree, not the branch.
 */
export class OpenChangeStore {
  constructor(private readonly git: Git) {}

  private async path(): Promise<string> {
    const dir = join(await this.git.gitDir(), "graft");
    await mkdir(dir, { recursive: true });
    return join(dir, "open.json");
  }

  async read(): Promise<ChangeRecord | null> {
    try {
      const raw = await readFile(await this.path(), "utf8");
      return JSON.parse(raw) as ChangeRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(record: ChangeRecord): Promise<void> {
    await writeFile(await this.path(), JSON.stringify(record, null, 2) + "\n");
  }

  async clear(): Promise<void> {
    await rm(await this.path(), { force: true });
  }

  private async attemptsPath(): Promise<string> {
    return join(await this.gitDir(), "attempts.json");
  }

  private async gitDir(): Promise<string> {
    const dir = join(await this.git.gitDir(), "graft");
    await mkdir(dir, { recursive: true });
    return dir;
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
    const all = await this.readAttempts();
    all.push(attempt);
    await writeFile(await this.attemptsPath(), JSON.stringify(all, null, 2) + "\n");
  }

  async clearAttempts(): Promise<void> {
    await rm(await this.attemptsPath(), { force: true });
  }
}
