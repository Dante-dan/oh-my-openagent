import { readFile, writeFile } from "../fs/resilient"
import { join, resolve } from "node:path"
import { createLockRecord, LockContentionError, withLock } from "../locks"
import type { GitExec } from "./exec"
import { commandError } from "./repo-arguments"

export const MEMORY_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000

/** Git's maintenance tasks pack without pruning objects or locking the commit index. */
export async function runMemoryMaintenance(dir: string, exec: GitExec, now: number): Promise<boolean> {
  const options = { cwd: dir, timeoutMs: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
  const common = await exec.run(["rev-parse", "--git-common-dir"], options)
  if (common.code !== 0) return false // a fresh identity may not own a repo yet
  const gitDir = resolve(dir, common.stdout.trim())
  const stamp = join(gitDir, "omo-maintenance-at")
  const record = await createLockRecord("memory git maintenance")
  try {
    return await withLock(join(gitDir, "omo-maintenance.lock"), record, async () => {
      let last = 0
      try { last = Number((await readFile(stamp, "utf8")).trim()) } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      }
      if (Number.isFinite(last) && last > 0 && now - last < MEMORY_MAINTENANCE_INTERVAL_MS) return false
      // Record attempts too: a missing Git task or a failed pack must not retry every prompt.
      await writeFile(stamp, String(now), "utf8")
      const argv = ["-c", "maintenance.loose-objects.auto=1", "maintenance", "run",
        "--task=loose-objects", "--task=incremental-repack", "--quiet"]
      const result = await exec.run(argv, options)
      if (result.code !== 0) throw commandError(argv, result)
      return true
    }, { waitTimeoutMs: 0 })
  } catch (error) {
    if (error instanceof LockContentionError) return false
    throw error
  }
}
