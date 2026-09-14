/**
 * Cross-package parity test: asserts that senpi-task's AGENT_FALLBACK_CHAINS
 * mirrors model-core's AGENT_MODEL_REQUIREMENTS for the four curated agents,
 * normalizing the claude-sdk-oauth head that senpi adds (#8051).
 *
 * RED on dev before #8259 fix, GREEN after.
 */
import { describe, expect, test } from "bun:test"

import { AGENT_FALLBACK_CHAINS } from "@oh-my-opencode/senpi-task/agents/builtin/fallback-chains"
import { AGENT_MODEL_REQUIREMENTS } from "@oh-my-opencode/model-core"

/** Strip the claude-sdk-oauth provider that senpi-task adds to every Claude rung. */
function normalizeSenpiChain(chain: readonly { providers: readonly string[]; model: string; variant?: string }[]) {
  return chain.map((entry) => ({
    ...entry,
    providers: entry.providers.filter((p) => p !== "claude-sdk-oauth"),
  }))
}

const CURATED_PAIRS: [senpiName: string, modelCoreName: string][] = [
  ["explore", "explore"],
  ["librarian", "librarian"],
  ["plan-consultant", "metis"],
  ["plan-reviewer", "momus"],
]

describe("agent fallback chain parity (senpi-task ↔ model-core)", () => {
  for (const [senpiName, modelCoreName] of CURATED_PAIRS) {
    test(`#given ${senpiName} in senpi-task #when compared with ${modelCoreName} in model-core #then models variants and providers match`, () => {
      const senpiChain = AGENT_FALLBACK_CHAINS[senpiName]
      const modelCoreChain = AGENT_MODEL_REQUIREMENTS[modelCoreName]?.fallbackChain

      expect(senpiChain, `senpi-task missing chain: ${senpiName}`).toBeDefined()
      expect(modelCoreChain, `model-core missing chain: ${modelCoreName}`).toBeDefined()

      const normalized = normalizeSenpiChain(senpiChain!)
      expect(normalized).toEqual(modelCoreChain)
    })
  }

  test("#given the curated agent set #when listing keys #then senpi-task has exactly the four expected chains", () => {
    expect(Object.keys(AGENT_FALLBACK_CHAINS).sort()).toEqual(
      CURATED_PAIRS.map(([name]) => name).sort(),
    )
  })
})
