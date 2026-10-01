import { afterEach, describe, expect, test } from "bun:test"

import { FakeRunner, baseSpec, cleanupProjects, flush, makeManager, settings } from "./__fixtures__/manager-fakes"

afterEach(cleanupProjects)

// oh-my-openagent#8973. Suspending a running child (parent session shutdown, daemon loss) forgets
// its handle, and the outcome tracker then refuses to settle a handle it no longer owns, so the
// lane lease of the suspended run was never released. Every suspension leaked one slot until the
// parent's lane was full and every revival and task_send answered `lane_capacity`.
describe("TaskManager lane lease of a suspended child", () => {
  test("#given a running child in a one-slot lane #when it is suspended and forgotten #then the next start in that lane is admitted", async () => {
    // given
    const inProcess = new FakeRunner()
    const { manager, store } = makeManager({ inProcess, config: settings({ default_concurrency: 1, max_depth: 1 }) })
    const first = await manager.start(baseSpec({ name: "first" }))
    if (first.kind !== "started") throw new Error("expected first to start")

    // when the child is suspended the way session shutdown does it: forget, then park
    manager.forget(first.task_id)
    store.transition(first.task_id, { type: "persist_only", timestamp: new Date().toISOString() })
    await flush()

    // then a sibling in the same lane starts instead of queueing behind a leaked slot
    const second = await manager.start(baseSpec({ name: "second" }))
    expect(second).toMatchObject({ kind: "started", status: "running" })
  })

  for (const hasNewerLease of [false, true]) {
    test(`#given a shared record advanced to a newer epoch ${hasNewerLease ? "with its own lease" : "without a new lease"} #when the old handle is forgotten #then only the old run's lease is released`, async () => {
      const inProcess = new FakeRunner()
      const { manager, store } = makeManager({ inProcess, config: settings({ default_concurrency: hasNewerLease ? 2 : 1, max_depth: 1 }) })
      const first = await manager.start(baseSpec({ name: "first" }))
      if (first.kind !== "started") throw new Error("expected first to start")
      const record = store.load(first.task_id)
      if (record === null) throw new Error("expected task record")
      const concurrency = manager.concurrency
      if (concurrency === undefined) throw new Error("expected manager concurrency")
      const oldEpoch = record.notification.run_epoch
      const nextEpoch = oldEpoch + 1
      if (hasNewerLease) expect(concurrency.tryAcquire(record.model, record.task_id, nextEpoch)).toBe(true)
      store.mutate(first.task_id, (fresh) => ({ ...fresh, notification: { ...fresh.notification, run_epoch: nextEpoch } }))

      manager.forget(first.task_id)

      expect(concurrency.leaseState(first.task_id, oldEpoch)).toBeUndefined()
      expect(concurrency.leaseState(first.task_id, nextEpoch)).toBe(hasNewerLease ? "held" : undefined)
      const next = await manager.start(baseSpec({ name: "next" }))
      expect(next).toMatchObject({ kind: "started", status: "running" })
    })
  }

  test("#given a suspended child whose slot was released #when its stale handle settles later #then the lane is not released twice", async () => {
    // given
    const inProcess = new FakeRunner()
    const { manager, store } = makeManager({ inProcess, config: settings({ default_concurrency: 1, max_depth: 1 }) })
    const first = await manager.start(baseSpec({ name: "first" }))
    if (first.kind !== "started") throw new Error("expected first to start")
    const staleHandle = inProcess.handles.get(first.task_id)
    manager.forget(first.task_id)
    store.transition(first.task_id, { type: "persist_only", timestamp: new Date().toISOString() })
    const second = await manager.start(baseSpec({ name: "second" }))
    expect(second).toMatchObject({ kind: "started", status: "running" })

    // when the suspended run's stale handle settles after the slot moved on
    staleHandle?.settle({ status: "completed", finalResponse: "late" })
    await flush()

    // then the lane is still held by the second child: a third start queues
    const third = await manager.start(baseSpec({ name: "third" }))
    expect(third).toMatchObject({ kind: "started", status: "pending" })
  })
})
