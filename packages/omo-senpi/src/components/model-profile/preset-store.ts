import {
  OmoModelPresetSchema,
  updateOmoConfig,
  type OmoConfig,
  type OmoConfigEdit,
  type OmoModelPreset,
  type UpdateOmoConfigOptions,
} from "@oh-my-opencode/omo-config-core"

import { loadSenpiOmoConfig } from "../config-resolution"
import { BUILTIN_MODEL_PROFILES } from "./builtin-profiles"

const MODEL_FIELDS = ["model", "models", "reasoning"] as const
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export type PresetStoreOptions = {
  readonly cwd: string
  readonly env?: UpdateOmoConfigOptions["env"]
  readonly load?: typeof loadSenpiOmoConfig
  readonly write?: typeof updateOmoConfig
}

export type PresetApplyResult = {
  readonly pinnedRoles: readonly string[]
  readonly config: OmoConfig
}

function checkName(name: string): void {
  if (!NAME.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) {
    throw new Error("Preset names must be 1-64 letters, digits, underscores or hyphens, beginning with a letter or digit")
  }
  if (Object.hasOwn(BUILTIN_MODEL_PROFILES, name)) throw new Error("Built-in model lanes cannot be saved or deleted")
}

function modelFields(entry: object): Record<string, unknown> {
  return Object.fromEntries(MODEL_FIELDS.flatMap((key) => {
    const value: unknown = Reflect.get(entry, key)
    return value === undefined ? [] : [[key, value]]
  }))
}

function roleSnapshot<T extends object>(roles: Readonly<Record<string, T>> | undefined): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(roles ?? {}).map(([name, entry]) => [name, modelFields(entry)]))
}

export function snapshotModelPreset(config: OmoConfig, model: string, thinking: string): OmoModelPreset {
  return OmoModelPresetSchema.parse({
    model, thinking,
    agents: roleSnapshot(config.agents),
    categories: roleSnapshot(config.categories),
  })
}

export function createModelPresetStore(options: PresetStoreOptions) {
  const read = () => (options.load ?? loadSenpiOmoConfig)({ cwd: options.cwd, env: options.env })
  const write = (edits: readonly OmoConfigEdit[]) => (options.write ?? updateOmoConfig)({
    scope: "user", env: options.env, edits,
  })
  const list = () => read().config.model_presets ?? {}
  return {
    list,
    read,
    save(name: string, preset: OmoModelPreset): void {
      checkName(name)
      if (Object.hasOwn(list(), name)) throw new Error(`Preset "${name}" already exists; delete it before replacing it`)
      write([{ path: ["[native]", "model_presets", name], value: OmoModelPresetSchema.parse(preset) }])
    },
    delete(name: string): void {
      checkName(name)
      if (!Object.hasOwn(list(), name)) throw new Error(`Unknown preset "${name}"`)
      write([{ path: ["[native]", "model_presets", name], value: undefined }])
      if (Object.hasOwn(list(), name)) throw new Error(`Preset "${name}" is pinned by a configuration layer; its user entry was removed`)
    },
    apply(preset: OmoModelPreset, cliPinned: boolean): PresetApplyResult {
      const loaded = read()
      const edits: OmoConfigEdit[] = [{
        path: ["[native]", "model_profile"], value: `${preset.model}:${preset.thinking}`,
      }]
      // Clear stale model fields from every writable user layer, preserving tools,
      // prompts and other role settings. Project and selected-profile pins remain.
      for (const kind of ["agents", "categories"] as const) {
        const names = new Set(Object.keys(preset[kind]))
        for (const layer of loaded.layers.filter((layer) => layer.source.scope === "user")) {
          for (const block of [layer.config, layer.config["[native]"], layer.config["[senpi]"]]) {
            if (typeof block !== "object" || block === null) continue
            const roles: unknown = Reflect.get(block, kind)
            if (typeof roles === "object" && roles !== null) Object.keys(roles).forEach((name) => names.add(name))
          }
        }
        for (const name of names) for (const field of MODEL_FIELDS) {
          edits.push({ path: [kind, name, field], value: undefined })
          edits.push({ path: ["[senpi]", kind, name, field], value: undefined })
          edits.push({ path: ["[native]", kind, name, field], value: preset[kind][name]?.[field] })
        }
      }
      const filteredEdits = edits.filter((edit) => edit.value !== undefined || loaded.layers.some((layer) => {
        if (layer.source.scope !== "user") return false
        let value: unknown = layer.config
        for (const key of edit.path) {
          if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return false
          value = Reflect.get(value, key)
        }
        return true
      }))
      write(filteredEdits)
      const actual = read().config
      const pinnedRoles: string[] = []
      if (cliPinned || actual.model_profile !== `${preset.model}:${preset.thinking}`) pinnedRoles.push("main")
      for (const kind of ["agents", "categories"] as const) {
        const names = new Set([...Object.keys(actual[kind] ?? {}), ...Object.keys(preset[kind])])
        for (const name of names) {
          if (JSON.stringify(modelFields(actual[kind]?.[name] ?? {})) !== JSON.stringify(modelFields(preset[kind][name] ?? {}))) {
            pinnedRoles.push(`${kind}.${name}`)
          }
        }
      }
      return { config: actual, pinnedRoles }
    },
  }
}
