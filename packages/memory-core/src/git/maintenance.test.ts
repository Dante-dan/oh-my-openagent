import { afterEach, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitMemoryRepo } from "./repo"
import { createNodeGitExec } from "./exec"
import { MEMORY_MAINTENANCE_INTERVAL_MS } from "./maintenance"
import { removeTree } from "../../../../test-support/remove-tree"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => removeTree(dir))) })

test("#given loose objects #when two maintainers race a commit #then packing is serialized and rate limited without blocking writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-maintenance-"))
  dirs.push(dir)
  const repo = new GitMemoryRepo({ dir, agentId: "maintenance" })
  await repo.init({ seedFiles: [{ relativePath: "a.md", content: "initial\n" }] })
  const other = new GitMemoryRepo({ dir, agentId: "maintenance" })
  await writeFile(join(dir, "a.md"), "concurrent write\n")
  const now = Date.now()
  const [first, second, commit] = await Promise.all([
    repo.maintain(now), other.maintain(now),
    repo.commitWrite(["a.md"], "concurrent commit", { agentId: "maintenance", authorName: "Maintenance" }),
  ])
  expect([first, second].filter(Boolean)).toHaveLength(1)
  expect(commit.committed).toBe(true)
  expect(await repo.maintain(now + 1)).toBe(false)
  const exec = createNodeGitExec()
  const count = await exec.run(["count-objects", "-v"], { cwd: dir, timeoutMs: 1_000 })
  expect(Number(/packs: (\d+)/.exec(count.stdout)?.[1])).toBeGreaterThan(0)
  expect(await repo.maintain(now + MEMORY_MAINTENANCE_INTERVAL_MS)).toBe(true)
  expect(await repo.show("HEAD", "a.md")).toBe("concurrent write\n")
}, 30_000)
