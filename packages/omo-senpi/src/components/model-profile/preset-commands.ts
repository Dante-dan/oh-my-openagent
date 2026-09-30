import type { SenpiExtensionAPI } from "../../extension/types"
import { createModelPresetStore, snapshotModelPreset } from "./preset-store"
import { BUILTIN_MODEL_PROFILES } from "./builtin-profiles"

interface PresetContext {
  readonly cwd?: string
  readonly model?: { readonly provider: string; readonly id: string }
  readonly modelRegistry?: { find(provider: string, id: string): unknown; getApiKey?(model: unknown): Promise<string | undefined> }
  readonly ui?: { select(title: string, choices: string[]): Promise<string | undefined>; notify(message: string, type?: string): void }
}

interface PresetApi {
  getThinkingLevel(): string
  setSessionThinkingLevel(level: string): void
  setSessionModel(model: unknown): Promise<boolean>
}

function modelApi(pi: SenpiExtensionAPI): PresetApi {
  for (const method of ["getThinkingLevel", "setSessionThinkingLevel", "setSessionModel"]) {
    if (typeof Reflect.get(pi, method) !== "function") throw new Error("This Senpi runtime does not support model preset commands")
  }
  return pi as unknown as PresetApi
}

export function registerModelPresetCommands(pi: SenpiExtensionAPI): void {
  let lastContext: PresetContext | undefined
  let cliPinned = false
  pi.on("session_start", (payload, ctx) => {
    lastContext = ctx as PresetContext | undefined
    const provenance: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "initialModelProvenance") : undefined
    cliPinned = provenance === "cli" || provenance === "scoped" || provenance === undefined
  })
  const run = async (args: string, ctx: PresetContext) => {
    const [action = "list", name] = args.trim().split(/\s+/)
    const store = createModelPresetStore({ cwd: ctx.cwd ?? pi.cwd ?? process.cwd() })
    if (action === "list") return { profiles: store.list(), builtinLanes: Object.keys(BUILTIN_MODEL_PROFILES) }
    if (name === undefined) throw new Error("Usage: /modelpreset save|switch|delete <name>, or /modelpreset list")
    if (action === "delete") { store.delete(name); return { deleted: name } }
    const api = modelApi(pi)
    if (action === "save") {
      if (ctx.model === undefined) throw new Error("The current session has no model to save")
      store.save(name, snapshotModelPreset(store.read().config, `${ctx.model.provider}/${ctx.model.id}`, api.getThinkingLevel()))
      return { saved: name }
    }
    if (action !== "switch") throw new Error("Unknown modelpreset action")
    const profiles = store.list()
    if (!Object.hasOwn(profiles, name)) throw new Error(`Unknown user preset "${name}"; built-in lanes remain available through model_profile`)
    const preset = profiles[name]!
    const slash = preset.model.indexOf("/")
    const model = ctx.modelRegistry?.find(preset.model.slice(0, slash), preset.model.slice(slash + 1))
    if (model === undefined) throw new Error(`Preset model ${preset.model} is unavailable; configuration was not changed`)
    // Probe availability before writing. The host setter remains the authority for
    // whether the model may be used; pinned sessions deliberately retain their model.
    const key = await ctx.modelRegistry?.getApiKey?.(model)
    if (ctx.modelRegistry?.getApiKey !== undefined && !key) throw new Error("Preset model has no authentication; configuration was not changed")
    const result = store.apply(preset, cliPinned)
    if (!result.pinnedRoles.includes("main")) {
      if (!(await api.setSessionModel(model))) throw new Error("The runtime refused the model; user defaults were saved but the current session was not switched")
      api.setSessionThinkingLevel(preset.thinking)
    }
    return { selected: name, pinnedRoles: result.pinnedRoles }
  }
  pi.registerCommand("modelpreset", {
    description: "Save, list, switch or delete a named model setup",
    handler: async (args: string, ctx: PresetContext) => {
      try {
        let command = args
        if (!args.trim() && ctx.ui !== undefined) {
          const store = createModelPresetStore({ cwd: ctx.cwd ?? pi.cwd ?? process.cwd() })
          const choice = await ctx.ui.select("Switch model preset", Object.keys(store.list()))
          if (choice === undefined) return
          command = `switch ${choice}`
        }
        const result = await run(command, ctx)
        pi.sendMessage({ customType: "omo-model-preset:result", content: JSON.stringify(result), display: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui?.notify(message, "error")
        pi.sendMessage({ customType: "omo-model-preset:error", content: message, display: true })
      }
    },
  })
  // Desktop clients can use the same session-bound operation without a TUI picker.
  pi.rpc?.handle?.("omo.model_preset", async (input) => {
    if (lastContext === undefined) throw new Error("No active session context")
    if (typeof input !== "object" || input === null || typeof Reflect.get(input, "command") !== "string") throw new Error("Expected {command: string}")
    return run(Reflect.get(input, "command"), lastContext)
  })
}
