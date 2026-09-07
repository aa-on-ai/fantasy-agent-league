import { mkdir, readFile, writeFile, rename, rmdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../manager/season.js";
import type { Ledger, LedgerEntry } from "./coordinator.js";

export class FileLedger implements Ledger {
  constructor(private readonly root: string) {}
  private async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error("unsafe_ledger_path");
  }
  private path(actionId: string): string {
    if (!/^[a-f0-9]{64}$/.test(actionId)) throw new Error("invalid_action_id");
    return join(this.root, `${actionId}.json`);
  }
  async exclusive<T>(scope: string, run: () => Promise<T>): Promise<T> {
    await this.prepare();
    const lock = join(this.root, `${digest(scope)}.lock`);
    // A crash leaves the lock in place. Do not guess that a live action is stale.
    await mkdir(lock, { mode: 0o700 });
    try { return await run(); } finally { await rmdir(lock); }
  }
  async get(actionId: string): Promise<LedgerEntry | null> {
    try {
      const entry = JSON.parse(await readFile(this.path(actionId), "utf8")) as LedgerEntry;
      if (entry.actionId !== actionId || !["pending", "verified", "uncertain"].includes(entry.status)) throw new Error("invalid_ledger_entry");
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async put(entry: LedgerEntry): Promise<void> {
    const path = this.path(entry.actionId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entry) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
}
