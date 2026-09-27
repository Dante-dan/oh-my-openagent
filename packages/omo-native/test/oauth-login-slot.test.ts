import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { prepareOAuthLoginSlot } from "../bin/lib/oauth-login-slot.js"

const roots: string[] = []

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function createEngine(): { root: string; oauthPath: string; slotsPath: string } {
  const root = mkdtempSync(join(tmpdir(), "omo-oauth-slot-"))
  roots.push(root)
  write(join(root, "package.json"), JSON.stringify({ type: "module" }))
  const oauthPath = join(root, "dist/core/extensions/builtin/claude-sdk-oauth/oauth-login.js")
  write(oauthPath, 'export function finish(current, credential, name) { return upsertAccount(current, toSlot(credential, name, "login")); }\n')
  const slotsPath = join(root, "node_modules/@earendil-works/pi-ai/dist/auth/pool/slots.js")
  write(
    slotsPath,
    `function mergeProvidedPool(current, existing, provided) {
    const known = new Set(existing.map((slot) => slot.name));
    const added = provided.filter((slot) => !known.has(slot.name));
    return added.length === 0 ? current : { ...current, accounts: [...existing, ...added] };
}
export function commit(current, flat) {
  const provided = flat.accounts;
  const storedAccounts = current.accounts;
  return mergeProvidedPool(current, storedAccounts, provided);
}
`,
  )
  return { root, oauthPath, slotsPath }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("OAuth re-login slot preparation", () => {
  test("replaces only the explicitly refreshed slot and preserves current siblings", async () => {
    const { root, slotsPath } = createEngine()
    prepareOAuthLoginSlot(root)
    const { commit } = await import(`${pathToFileURL(slotsPath).href}?${Date.now()}`)
    const current = { accounts: [
      { name: "existing", access: "old" },
      { name: "sibling", access: "newest-sibling" },
    ] }
    const provided = { accounts: [
      { name: "existing", access: "fresh" },
      { name: "sibling", access: "stale-sibling" },
      { name: "added", access: "new" },
    ] }
    Object.defineProperty(provided, Symbol.for("omo-ai.oauth-login-slot"), { value: "existing" })
    expect(commit(current, provided).accounts).toEqual([
      { name: "existing", access: "fresh" },
      { name: "sibling", access: "newest-sibling" },
      { name: "added", access: "new" },
    ])
    expect(JSON.stringify(provided)).not.toContain("oauth-login-slot")
  })

  test("is idempotent", () => {
    const { root, oauthPath, slotsPath } = createEngine()
    prepareOAuthLoginSlot(root)
    const first = [readFileSync(oauthPath, "utf8"), readFileSync(slotsPath, "utf8")]
    prepareOAuthLoginSlot(root)
    expect([readFileSync(oauthPath, "utf8"), readFileSync(slotsPath, "utf8")]).toEqual(first)
  })

  test("fails closed when the merge shape drifts", () => {
    const { root, slotsPath } = createEngine()
    write(slotsPath, "export const changed = true\n")
    expect(() => prepareOAuthLoginSlot(root)).toThrow("unsupported Senpi pi-ai login slot merge")
  })
})
