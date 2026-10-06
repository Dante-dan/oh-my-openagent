import type { EntryRenderer } from "@code-yeongyu/senpi"
import type { GitMemoryRepo, MemoryToolProvenance } from "@oh-my-opencode/memory-core"

import type { ComponentLogger } from "../../extension/types"
import type { MemoryExtensionAPI } from "./capabilities"
import type { MemoryIdentityContext } from "./context"
import {
  MEMORY_TOOL_NAME,
} from "./tool-metadata"
import { joinFields, noticeComponent } from "./worker/entry-renderers"

export const ACCEPTED_TURNS_ENTRY_TYPE = "omo-memory:accepted-turns"

export interface AcceptedTurnsRecord {
  readonly version: 1
  readonly sessionId: string
  readonly priorUserTurns: number
  readonly sessionBaselineTurns: number
  readonly checkedHead?: string
  readonly savedAtTurn?: number
  readonly historySince?: string
}

export interface ResolvedNudgeSettings {
  readonly enabled: boolean
  readonly everyUserTurns: number
}

export interface MemoryNudgeWiringOptions {
  readonly logger?: ComponentLogger
  readonly resolveContext: (sessionId: string) => MemoryIdentityContext | undefined
  readonly resolveSettings: (identity: string) => ResolvedNudgeSettings
}

export interface MemoryNudgeWiring {
  register(pi: MemoryExtensionAPI): void
  nudgeTurns(repo: GitMemoryRepo, sessionId: string, identity: string): Promise<number | undefined>
  provenance(sessionId: string): MemoryToolProvenance | undefined
}

// House-notice renderer for the durable accepted-turns record. Not registered:
// the entry is appended on every accepted user turn (hydration bookkeeping),
// senpi hides unregistered custom entries, and createMemoryComponent's renderer
// list is pinned in index.test.ts (out of this change's scope).
export const renderAcceptedTurnsEntry: EntryRenderer<AcceptedTurnsRecord> = (entry, options, theme) => {
  const record = entry.data
  if (record === undefined) return undefined
  const turns = record.priorUserTurns
  const noun = turns === 1 ? "turn" : "turns"
  return noticeComponent(
    {
      glyph: "·",
      title: joinFields(["Memory accepted turns", `${turns} ${noun}`]),
      tone: "muted",
      why: `This session has recorded ${turns} accepted user ${noun}.`,
      extra: [{ text: `baseline ${record.sessionBaselineTurns}`, tone: "dim" }],
      detail: `session ${record.sessionId}`,
    },
    options,
    theme,
  )
}

export function createMemoryNudgeWiring(options: MemoryNudgeWiringOptions): MemoryNudgeWiring {
  const sessions = new Map<string, AcceptedTurnsRecord>()
  const pendingInputs = new Map<string, string>()
  const checks = new Map<string, Promise<number | undefined>>()
  const failedUntil = new Map<string, number>()
  const maintenance = new Map<string, Promise<unknown>>()
  let registered: MemoryExtensionAPI | undefined

  function persist(pi: MemoryExtensionAPI, record: AcceptedTurnsRecord): void {
    sessions.set(record.sessionId, record)
    pi.appendEntry(ACCEPTED_TURNS_ENTRY_TYPE, record)
  }

  return {
    register(pi): void {
      registered = pi
      pi.on("session_start", (_payload, eventCtx) => {
        const session = readSession(eventCtx)
        if (session === undefined) return
        const hydrated = findLatestAcceptedTurns(session.entries, session.id)
        if (hydrated !== undefined) {
          sessions.set(session.id, { ...hydrated, historySince: hydrated.historySince ?? session.since })
          return
        }
        sessions.set(session.id, {
          version: 1,
          sessionId: session.id,
          priorUserTurns: 0,
          sessionBaselineTurns: 0,
          historySince: session.since ?? new Date(Date.now() - 1_000).toISOString(),
        })
      })

      pi.on("input", (payload, eventCtx) => {
        if (!isRecord(payload) || payload.type !== "input" || payload.source === "extension") return
        if (typeof payload.inputId !== "string" || payload.inputId.length === 0) return
        const sessionId = readSessionId(eventCtx)
        if (sessionId !== undefined) pendingInputs.set(payload.inputId, sessionId)
      })

      pi.on("input_disposition", (payload) => {
        if (!isRecord(payload) || payload.type !== "input_disposition") return
        if (typeof payload.inputId !== "string") return
        const sessionId = pendingInputs.get(payload.inputId)
        if (sessionId === undefined) return
        pendingInputs.delete(payload.inputId)
        if (payload.disposition !== "queued" && payload.disposition !== "started") return
        const current = sessions.get(sessionId) ?? {
          version: 1,
          sessionId,
          priorUserTurns: 0,
          sessionBaselineTurns: 0,
        }
        persist(pi, { ...current, priorUserTurns: current.priorUserTurns + 1 })
      })

      pi.on("tool_call", (payload, eventCtx) => {
        if (!isRecord(payload) || !isMemoryToolName(payload.toolName) || !isRecord(payload.input)) return
        const sessionId = readSessionId(eventCtx)
        if (sessionId === undefined) return
        const context = options.resolveContext(sessionId)
        const state = sessions.get(sessionId)
        if (context === undefined || state === undefined) return
        payload.input.provenance = {
          sessionId,
          userTurns: state.priorUserTurns,
          identityId: context.identity,
          repoPath: context.identityPaths.repo,
          // The receipt key for the IC-17 outbound half: unforgeable because the bridge
          // overwrites the whole provenance object; never read from model arguments.
          ...(typeof payload.toolCallId === "string" && payload.toolCallId.length > 0
            ? { toolCallId: payload.toolCallId }
            : {}),
        }
      })
    },

    async nudgeTurns(repo, sessionId, identity): Promise<number | undefined> {
      const state = sessions.get(sessionId)
      if (state === undefined) return undefined
      const settings = options.resolveSettings(identity)
      if (!settings.enabled) return undefined
      if ((failedUntil.get(sessionId) ?? 0) > Date.now()) return undefined
      const existing = checks.get(sessionId)
      if (existing !== undefined) return existing
      if (!maintenance.has(repo.dir)) {
        const task = repo.maintain().catch((error: unknown) => {
          options.logger?.warn("omo-senpi memory maintenance failed", { error: describe(error) })
        }).finally(() => maintenance.delete(repo.dir))
        maintenance.set(repo.dir, task)
      }
      const check = (async () => {
        try {
          const head = await repo.head(500, true)
          let savedAt = state.savedAtTurn ?? state.sessionBaselineTurns
          if (head !== null && head !== state.checkedHead) {
            const history = await repo.log({
              // Exact trailer lines prevent a session-id prefix from hiding the latest real save.
              grepRegex: ["^Omo-Writer: memory-tool$", `^Omo-Session: ${escapeRegex(sessionId)}$`, "^Omo-Turn: [0-9]+$"],
              limit: 1,
              range: state.checkedHead === undefined ? head : `${state.checkedHead}..${head}`,
              ...(state.historySince === undefined ? {} : { since: state.historySince }),
              timeoutMs: 500,
            })
            const lastSave = history.find((commit) => commit.trailers["Omo-Writer"] === "memory-tool"
              && commit.trailers["Omo-Session"] === sessionId)
            savedAt = parseTurn(lastSave?.trailers["Omo-Turn"]) ?? savedAt
            const current = sessions.get(sessionId) ?? state
            const next = { ...current, checkedHead: head, savedAtTurn: savedAt }
            if (registered !== undefined) persist(registered, next)
          }
          const current = sessions.get(sessionId) ?? state
          const pendingTurn = [...pendingInputs.values()].some((id) => id === sessionId) ? 1 : 0
          const turns = current.priorUserTurns + pendingTurn - savedAt
          return turns >= settings.everyUserTurns ? turns : undefined
        } catch (error) {
          failedUntil.set(sessionId, Date.now() + 30_000)
          options.logger?.warn("omo-senpi memory nudge check failed", { error: describe(error) })
          return undefined
        }
      })().finally(() => checks.delete(sessionId))
      checks.set(sessionId, check)
      return check
    },

    provenance(sessionId): MemoryToolProvenance | undefined {
      const state = sessions.get(sessionId)
      return state === undefined ? undefined : { sessionId, userTurns: state.priorUserTurns }
    },
  }
}

function findLatestAcceptedTurns(
  entries: readonly unknown[],
  sessionId: string,
): AcceptedTurnsRecord | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== ACCEPTED_TURNS_ENTRY_TYPE) continue
    if (isAcceptedTurnsRecord(entry.data) && entry.data.sessionId === sessionId) return entry.data
  }
  return undefined
}

function isAcceptedTurnsRecord(value: unknown): value is AcceptedTurnsRecord {
  return isRecord(value)
    && value.version === 1
    && typeof value.sessionId === "string"
    && isTurn(value.priorUserTurns)
    && isTurn(value.sessionBaselineTurns)
    && value.sessionBaselineTurns <= value.priorUserTurns
    && (value.checkedHead === undefined || (typeof value.checkedHead === "string" && /^[0-9a-f]{40,64}$/.test(value.checkedHead)))
    && (value.savedAtTurn === undefined || isTurn(value.savedAtTurn))
    && (value.historySince === undefined || (typeof value.historySince === "string" && Number.isFinite(Date.parse(value.historySince))))
}

function readSession(eventCtx: unknown): { id: string; entries: readonly unknown[]; since?: string } | undefined {
  if (!isRecord(eventCtx) || !isRecord(eventCtx.sessionManager)) return undefined
  const manager = eventCtx.sessionManager
  const getSessionId = manager.getSessionId
  const getEntries = manager.getEntries
  if (typeof getSessionId !== "function" || typeof getEntries !== "function") return undefined
  const id = Reflect.apply(getSessionId, manager, [])
  const entries = Reflect.apply(getEntries, manager, [])
  if (typeof id !== "string" || id.length === 0 || !Array.isArray(entries)) return undefined
  const timestamp = entries.find((entry) => isRecord(entry) && typeof entry.timestamp === "string")?.timestamp
  const since = typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))
    ? new Date(Date.parse(timestamp) - 1_000).toISOString() : undefined
  return { id, entries, ...(since === undefined ? {} : { since }) }
}

function readSessionId(eventCtx: unknown): string | undefined {
  if (!isRecord(eventCtx) || !isRecord(eventCtx.sessionManager)) return undefined
  const manager = eventCtx.sessionManager
  const getter = manager.getSessionId
  if (typeof getter !== "function") return undefined
  const value = Reflect.apply(getter, manager, [])
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function parseTurn(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const turn = Number(value)
  return isTurn(turn) ? turn : undefined
}

function isTurn(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isMemoryToolName(value: unknown): boolean {
  // The MCP surface exposes the same tools under senpi's catalog names (mcp_<server>_<tool>);
  // matching only the bare names would skip provenance injection on the search exposure.
  return value === MEMORY_TOOL_NAME
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
