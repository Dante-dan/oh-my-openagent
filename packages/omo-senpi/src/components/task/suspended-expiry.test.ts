import { afterEach, expect, test } from "bun:test"
import { createCompletionNotifier, type ParentNotifierMessage } from "../../../../senpi-task/src/completion"
import { createMutationNotifyingStore } from "./store-mutation-observer"
import { createCompletionObservingStore } from "./completion-bridge"
import { cleanupProjects, FakeRegistry, seedRecord, settings, tempStore } from "../../../../senpi-task/src/lifecycle/__fixtures__/lifecycle-fakes"
import { resolveContext } from "../../../../senpi-task/src/lifecycle/context"
import { NO_HOST_ENDPOINT } from "../../../../senpi-task/src/lifecycle/host-session"
import { clearSuspensionReason, markSuspensionReason } from "../../../../senpi-task/src/lifecycle/host-session-record"
import { failExpiredSuspendedTasks, SUSPENDED_UNRESUMABLE_TIMEOUT_MS } from "../../../../senpi-task/src/lifecycle/suspended-expiry"

afterEach(cleanupProjects)

function harness() {
  let now = 10_000_000
  const backing = tempStore()
  const messages: ParentNotifierMessage[] = []
  const notifier = createCompletionNotifier({ store: backing, notifier: { enqueue: message => { messages.push(message) } } })
  const store = createMutationNotifyingStore(createCompletionObservingStore(backing, {
    notifier, parentState: () => ({ kind: "idle" }), wasBackground: () => false,
  }), () => {})
  const registry = new FakeRegistry()
  const dequeued: string[] = []
  const context = resolveContext({ store, registry, config: settings(), now: () => now,
    hostEndpoint: NO_HOST_ENDPOINT, signaller: { isAlive: () => false, signal: () => {} },
    dequeuePending: id => { dequeued.push(id) },
  })
  return { store, registry, messages, context, dequeued, advance: (ms: number) => { now += ms } }
}

test("#given a host-gone parked child with partial work #when its 30m deadline expires #then fail once, free residency and retain partial work", () => {
  const h = harness()
  seedRecord(h.store, { task_id: "st_93500001", status: "running", residency_state: "rpc_detached", updated_at: new Date(10_000_000).toISOString() })
  h.store.mutate("st_93500001", fresh => ({ ...fresh, final_response: "partial answer" }))
  markSuspensionReason(h.context, "st_93500001", "daemon_unavailable")
  expect(failExpiredSuspendedTasks(h.context, "parent-1")).toEqual([])
  h.advance(SUSPENDED_UNRESUMABLE_TIMEOUT_MS)
  expect(failExpiredSuspendedTasks(h.context, "parent-1")).toEqual(["st_93500001"])
  const failed = h.store.load("st_93500001")
  expect(failed?.status).toBe("error")
  expect(failed?.residency_state).toBe("disposed")
  expect(failed?.final_response).toBe("partial answer")
  expect(h.messages).toHaveLength(1)
  expect(h.messages[0]?.details[0]?.final_response).toContain("failed: suspended_unresumable (daemon_unavailable)")
  expect(h.messages[0]?.details[0]?.final_response).toContain("partial work at task_output(st_93500001)")
  expect(failExpiredSuspendedTasks(h.context, "parent-1")).toEqual([])
  expect(h.messages).toHaveLength(1)
  expect(h.dequeued).toEqual(["st_93500001"])
})

test("#given repeated host-loss retries #when the reason changes #then the durable first suspension deadline is unchanged", () => {
  const h = harness()
  seedRecord(h.store, { task_id: "st_93500002", status: "running", residency_state: "rpc_detached", updated_at: new Date(10_000_000).toISOString() })
  markSuspensionReason(h.context, "st_93500002", "daemon_unavailable")
  const first = h.store.load("st_93500002")?.suspended_at
  h.advance(SUSPENDED_UNRESUMABLE_TIMEOUT_MS)
  markSuspensionReason(h.context, "st_93500002", "host_draining")
  expect(h.store.load("st_93500002")?.suspended_at).toBe(first)
  expect(failExpiredSuspendedTasks(h.context, "parent-1")).toEqual(["st_93500002"])
})

test("#given a revived or other-parent child #when a stale expiry scan runs #then the active run and other parent are untouched", () => {
  const h = harness()
  for (const id of ["st_93500003", "st_93500004"]) seedRecord(h.store, { task_id: id, status: "running", residency_state: "persisted_only", updated_at: new Date(10_000_000).toISOString() })
  markSuspensionReason(h.context, "st_93500003", "daemon_unavailable")
  h.store.mutate("st_93500003", fresh => ({ ...fresh, residency_state: "resident" }))
  clearSuspensionReason(h.context, "st_93500003")
  h.store.mutate("st_93500004", fresh => ({ ...fresh, parent_session_id: "other-parent" }))
  h.advance(SUSPENDED_UNRESUMABLE_TIMEOUT_MS)
  expect(h.store.load("st_93500003")?.suspended_at).toBeUndefined()
  expect(failExpiredSuspendedTasks(h.context, "parent-1")).toEqual([])
  expect(failExpiredSuspendedTasks(h.context)).toEqual([])
  expect(h.messages).toHaveLength(0)
})
