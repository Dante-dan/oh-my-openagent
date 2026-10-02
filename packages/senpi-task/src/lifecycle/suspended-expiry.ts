import type { TaskRecord } from "../state"
import { nowIso, TERMINAL_STATUSES, type LifecycleContext } from "./context"

export const SUSPENDED_UNRESUMABLE_TIMEOUT_MS = 30 * 60 * 1_000

/** Terminalize expired parked runs without deleting their partial response or session artifacts. */
export function failExpiredSuspendedTasks(context: LifecycleContext, parentSessionId?: string): readonly string[] {
  // A live engine scopes all mutations to its own parent; an unknown current session does not
  // authorize a global sweep across the store's other sessions.
  if (parentSessionId === undefined) return []
  const expired: string[] = []
  const cutoff = context.now() - SUSPENDED_UNRESUMABLE_TIMEOUT_MS
  const eligible = (record: TaskRecord): boolean =>
    record.parent_session_id === parentSessionId &&
    (record.residency_state === "rpc_detached" || record.residency_state === "persisted_only") &&
    !TERMINAL_STATUSES.has(record.status) &&
    Date.parse(record.suspended_at ?? record.updated_at) <= cutoff &&
    context.registry.get(record.task_id) === undefined &&
    (record.host_pid === undefined || !context.signaller.isAlive(record.host_pid)) &&
    (record.pid === undefined || !context.signaller.isAlive(record.pid))

  for (const observed of context.store.list().records) {
    if (!eligible(observed)) continue
    let applied = false
    const result = context.store.mutate(observed.task_id, (fresh) => {
      if (!eligible(fresh)) return fresh
      applied = true
      const reason = fresh.suspension_reason ?? "parent_restarted_or_lane_unavailable"
      const partialRef = fresh.host_session?.session_path ?? `task_output(${fresh.task_id})`
      return { ...fresh, status: "error", residency_state: "disposed",
        error_message: `failed: suspended_unresumable (${reason}); partial work at ${partialRef}`,
        updated_at: nowIso(context), terminal_at: nowIso(context), notify_on_terminal: true }
    })
    if (!applied || result === null) continue
    context.dequeuePending(result.task_id)
    context.kernelToolBindings?.release(result.task_id)
    context.store.appendEvent(result.task_id, { type: "suspended_unresumable", payload: {
      reason: result.error_message, suspended_at: result.suspended_at ?? observed.updated_at,
    } })
    expired.push(result.task_id)
  }
  return expired
}
