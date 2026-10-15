import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Git } from "./git.js";
import type { ChangeRecord } from "./record.js";

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
}
