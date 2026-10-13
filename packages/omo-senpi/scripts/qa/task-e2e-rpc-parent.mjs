// Node-compatible RPC parent transport, shared with the existing resident QA protocol.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
const EXIT_TIMEOUT_MS = 10_000
export function launchRpc(command, sandbox, env) {
  const child = spawn(command.file, [...command.prefix, "--mode", "rpc", "--provider", "omo-mock", "--model", "mock-1", "--session-dir", sandbox.sessionsDir], { cwd: sandbox.cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  const events = []
  const waiters = []
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event
    try { event = JSON.parse(line) } catch { return }
    events.push(event)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue
      clearTimeout(waiter.timer)
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(event)
    }
  })
  const exited = new Promise((resolvePromise) => {
    child.once("error", (error) => { stderr += `${error.message}\n`; resolvePromise({ code: null, signal: null }) })
    child.once("close", (code, signal) => resolvePromise({ code, signal }))
  })
  child.stdin.on("error", (error) => { stderr += `${error.message}\n` })
  const waitFrom = (from, predicate, timeoutMs, label) => {
    const seen = events.slice(from).find(predicate)
    if (seen !== undefined) return Promise.resolve(seen)
    return new Promise((resolvePromise, reject) => {
      const waiter = { predicate, resolve: resolvePromise, timer: undefined }
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reject(new Error(`${label} timed out after ${timeoutMs}ms; events=${events.map((event) => event.type).join(",")}; stderr=${stderr.slice(-800)}`))
      }, timeoutMs)
      waiters.push(waiter)
    })
  }
  return {
    child,
    pid: child.pid,
    exited,
    mark: () => events.length,
    waitFrom,
    stderr: () => stderr,
    send: (message) => { child.stdin.write(`${JSON.stringify(message)}\n`) },
  }
}

export async function teardown(session) {
  const { child } = session
  if (child.exitCode !== null || child.signalCode !== null) return `pid ${child.pid} already exited`
  try { session.send({ type: "abort" }) } catch { /* stdin already closed */ }
  try { child.stdin.end() } catch { /* stdin already closed */ }
  if (await waitForExit(child, EXIT_TIMEOUT_MS)) return `pid ${child.pid} exited`
  child.kill("SIGTERM")
  if (await waitForExit(child, EXIT_TIMEOUT_MS)) return `pid ${child.pid} exited after SIGTERM`
  child.kill("SIGKILL")
  await waitForExit(child, EXIT_TIMEOUT_MS)
  return `pid ${child.pid} killed`
}

export function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => { child.removeListener("exit", onExit); resolvePromise(false) }, timeoutMs)
    const onExit = () => { clearTimeout(timer); resolvePromise(true) }
    child.once("exit", onExit)
  })
}
