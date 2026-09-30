import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OmoConfigSchema } from "@oh-my-opencode/omo-config-core"

import { createModelPresetStore, snapshotModelPreset } from "./preset-store"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-presets-")); roots.push(root)
  const home = join(root, "home"); const cwd = join(home, "project")
  mkdirSync(join(home, ".omo"), { recursive: true }); mkdirSync(cwd)
  const path = join(home, ".omo", "omo.jsonc")
  writeFileSync(path, '// keep this comment\n{"[native]":{"categories":{"old":{"model":"mock/old","description":"keep"}}}}')
  return { root, cwd, path, store: createModelPresetStore({ cwd, env: { HOME: home } }) }
}
const preset = snapshotModelPreset({ categories: { quick: { model: "mock/quick", reasoning: "low" } } }, "mock/main", "high")

describe("named model preset storage", () => {
  test("#given current role models #when saved, listed, switched and deleted #then thinking and unrelated settings survive", () => {
    const f = fixture()
    f.store.save("night", preset)
    expect(f.store.list().night).toEqual(preset)
    expect(f.store.apply(preset, false).pinnedRoles).toEqual([])
    expect(f.store.read().config.categories?.old).toEqual({ description: "keep" })
    expect(f.store.read().config.model_profile).toBe("mock/main:high")
    expect(readFileSync(f.path, "utf8")).toContain("// keep this comment")
    f.store.delete("night")
    expect(f.store.list()).toEqual({})
  })
  test("#given project role and main pins #when switching #then only their actual pinned roles are reported", () => {
    const f = fixture()
    mkdirSync(join(f.cwd, ".omo")); writeFileSync(join(f.cwd, ".omo", "omo.jsonc"), JSON.stringify({
      "[native]": { model_profile: "mock/pinned", categories: { quick: { model: "mock/project" } } },
    }))
    const result = f.store.apply(preset, false)
    expect(result.pinnedRoles).toEqual(["main", "categories.quick"])
    expect(result.config.categories?.quick?.model).toBe("mock/project")
  })
  test("#given an explicit CLI model #when config switching succeeds #then main remains reported pinned", () => {
    const f = fixture()
    expect(f.store.apply(preset, true).pinnedRoles).toEqual(["main"])
  })
  test("#given built-in or unsafe names #when save or delete is requested #then no configuration changes", () => {
    const f = fixture(); const before = readFileSync(f.path, "utf8")
    for (const name of ["daily-normal", "geeky-heavy", "__proto__", "../escape"]) {
      expect(() => f.store.save(name, preset)).toThrow()
      expect(() => f.store.delete(name)).toThrow()
    }
    expect(readFileSync(f.path, "utf8")).toBe(before)
  })
  test("#given a preset #when root config is validated #then schema retains every role and thinking", () => {
    expect(OmoConfigSchema.parse({ model_presets: { night: preset } }).model_presets?.night).toEqual(preset)
  })
})
