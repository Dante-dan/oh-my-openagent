import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyPlan,
  approvalStatus,
  checkVariant,
  flowDir,
  gateVariant,
  initFlow,
  saveState,
  splitCases,
  stageDigest,
  type RatchetState,
} from "./core"

const ids = Array.from({ length: 10 }, (_, i) => `case_${i}`)
let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "omo-ratchet-"))
  await mkdir(join(cwd, "eval"))
  await mkdir(join(cwd, "src"))
  await writeFile(join(cwd, "eval/cases.jsonl"), ids.map((id) => JSON.stringify({ id })).join("\n"))
  await writeFile(join(cwd, "eval/run.ts"), "// test runner\n")
  await writeFile(join(cwd, "src/prompt.md"), "route messages\n")
})

afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

async function setup(hold: string[] = []): Promise<RatchetState> {
  const state = await initFlow(cwd, "router", {
    cases: ["eval/cases.jsonl"], harness: ["eval/run.ts"], change: ["src/prompt.md"],
  })
  applyPlan(state, { goal: { target: "quality", hold }, reps: 1, command: "bun eval/run.ts {variant} {flow_dir}" })
  splitCases(state, Object.fromEntries(ids.map((id) => [id, "routing"])), 0.4, 7)
  for (const stage of ["inputs", "grader", "plan"] as const) {
    state.approvals[stage] = { sha: await stageDigest(cwd, state, stage), at: new Date().toISOString() }
  }
  await saveState(cwd, state)
  return state
}

async function rows(variant: string, score: (id: string) => number, extra: Record<string, unknown> = {}): Promise<void> {
  const dir = join(flowDir(cwd, "router"), variant)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "results.jsonl"), ids.map((id) => JSON.stringify({
    prompt_id: id, rep: 0, grade: { quality: score(id) }, status: "ok", model: "model-a",
    usage: { input_tokens: 1_000, output_tokens: 100 }, latency_s: 1, ...extra,
  })).join("\n") + "\n")
}

const price = () => ({ input: 3, output: 15, cacheRead: 3, cacheWrite: 3 })

describe("host ratchet gate", () => {
  test("approval becomes stale when reviewed cases change", async () => {
    const state = await setup()
    expect((await approvalStatus(cwd, state)).inputs).toBe("current")
    await writeFile(join(cwd, "eval/cases.jsonl"), "changed\n")
    expect((await approvalStatus(cwd, state)).inputs).toBe("stale")
    await expect(checkVariant(cwd, state, "baseline")).rejects.toThrow("Approvals are not current")
  })

  test("keeps only a paired train and held-out improvement", async () => {
    const state = await setup()
    await rows("baseline", () => 0.2)
    expect((await gateVariant(cwd, state, "baseline", "", price)).decision).toBe("baseline")
    await rows("v1", () => 0.5)
    expect((await gateVariant(cwd, state, "v1", "one edit", price)).decision).toBe("keep")
    const train = new Set(state.train_ids)
    await rows("v2", (id) => train.has(id) ? 0.9 : 0.5)
    expect((await gateVariant(cwd, state, "v2", "overfit", price)).decision).toBe("revert")
  })

  test("rejects a test transcript and duplicate results", async () => {
    const state = await setup()
    await rows("baseline", () => 0.2)
    const dir = join(flowDir(cwd, "router"), "baseline")
    await mkdir(join(dir, "traces"))
    await writeFile(join(dir, "traces", `${state.test_ids[0]}_rep0.json`), "[]")
    await expect(gateVariant(cwd, state, "baseline", "", price)).rejects.toThrow("test")
    await rm(join(dir, "traces"), { recursive: true })
    const file = join(dir, "results.jsonl")
    const line = JSON.stringify({ prompt_id: ids[0], rep: 0, grade: { quality: 0.2 } })
    await writeFile(file, `${line}\n${line}\n`)
    await expect(gateVariant(cwd, state, "baseline", "", price)).rejects.toThrow("duplicate")
  })

  test("self-reported cost cannot satisfy a cost hold without priced usage", async () => {
    const state = await setup(["cost_usd"])
    await rows("baseline", () => 0.2, { cost_usd: 0 })
    await expect(gateVariant(cwd, state, "baseline", "", () => undefined)).rejects.toThrow("Guardrail")
  })
})
