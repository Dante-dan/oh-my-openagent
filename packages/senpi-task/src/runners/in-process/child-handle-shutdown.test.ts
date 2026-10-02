import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"

import { createRestoredChildHandle, discardUnstartedChildSession, type ChildSession } from "./child-handle"

function child(shutdown: () => Promise<void>, events: string[]): ChildSession {
  return {
    sessionId: "shutdown-child",
    extensionRunner: {
      hasHandlers: () => true,
      async emit(event) {
        expect(event).toEqual({ type: "session_shutdown", reason: "quit" })
        events.push("shutdown")
        await shutdown()
      },
    },
    async prompt() {},
    async steer() { return "handled" },
    async followUp() { return "handled" },
    async abort() {},
    subscribe: () => () => {},
    getLastAssistantText: () => "done",
    dispose: () => { events.push("dispose") },
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe("in-process child extension shutdown", () => {
  for (const mode of ["handle", "unstarted"] as const) {
    test(`#given a listening child extension #when ${mode} is disposed #then shutdown closes it before session invalidation exactly once`, async () => {
      const events: string[] = []
      const server = createServer()
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      let finish: (() => void) | undefined
      const pending = new Promise<void>((resolve) => { finish = resolve })
      const session = child(async () => {
        await pending
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        events.push("closed")
      }, events)
      const handle = createRestoredChildHandle({ taskId: "child", session })
      const dispose = () => mode === "handle" ? handle.dispose() : discardUnstartedChildSession(session)
      try {
        dispose()
        dispose()
        expect(events).toEqual(["shutdown"])
        expect(server.listening).toBe(true)
        finish?.()
        await flush()
        expect(events).toEqual(["shutdown", "closed", "dispose"])
        expect(server.listening).toBe(false)
      } finally {
        finish?.()
        if (server.listening) server.close()
      }
    })
  }

  test("#given a failed extension shutdown #when disposal starts #then the session is still invalidated", async () => {
    const events: string[] = []
    discardUnstartedChildSession(child(async () => { throw new Error("shutdown failed") }, events))
    await flush()
    expect(events).toEqual(["shutdown", "dispose"])
  })

  test("#given a session without extension handlers #when discarded #then disposal remains synchronous", () => {
    const events: string[] = []
    const session = child(async () => {}, events)
    discardUnstartedChildSession({ ...session, extensionRunner: undefined })
    expect(events).toEqual(["dispose"])
  })
})
