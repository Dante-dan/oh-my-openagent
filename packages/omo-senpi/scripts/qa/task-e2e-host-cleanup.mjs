// The host is detached from the print-mode parent. Stop only sockets owned by this QA sandbox.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { isolatedChildEnv } from "./sandbox-child-env.mjs"

export function taskVerdictExitCode(verdict) { return verdict === "PASS" ? 0 : 1 }

function parse(text) {
  try { return JSON.parse(text?.trim() || "{}") } catch { return {} }
}

export async function cleanupTaskHosts(senpiBin, sandbox) {
  const alternateRoot = `/tmp/omo-rpc-${createHash("sha256").update(sandbox.agentDir).digest("hex").slice(0, 8)}`
  const sockets = []
  for (const root of [join(sandbox.agentDir, "rpc", "shards"), alternateRoot]) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      const socket = join(root, name)
      if (/^p-[0-9a-f]{16}\.sock$/.test(name) && lstatSync(socket).isSocket()) sockets.push(socket)
    }
  }
  const options = {
    cwd: sandbox.cwd,
    env: { ...isolatedChildEnv(process.env, sandbox.agentDir), HOME: sandbox.homeDir, USERPROFILE: sandbox.homeDir, XDG_CONFIG_HOME: sandbox.xdgConfigHome },
    encoding: "utf8", timeout: 30_000,
  }
  const receipts = []
  for (const socket of sockets) {
    const status = spawnSync(senpiBin, ["host", "status", "--socket", socket, "--json"], options)
    const before = parse(status.stdout)
    const stopped = spawnSync(senpiBin, ["host", "stop", "--socket", socket, "--force", "--json"], options)
    const receipt = parse(stopped.stdout)
    const pid = before.pid ?? receipt.pid
    const alive = () => {
      if (typeof pid !== "number") return undefined
      try { process.kill(pid, 0); return true } catch (error) { return error.code === "ESRCH" ? false : undefined }
    }
    const deadline = Date.now() + 5_000
    while (alive() === true && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    receipts.push({ socket, pid, statusExit: status.status, stopExit: stopped.status, receipt, pidStillAlive: alive() })
  }
  // A process-list failure is unknown cleanup, never a vacuous success from an empty socket list.
  const scan = spawnSync("ps", [process.platform === "darwin" ? "-axo" : "-eo", "pid=,command="], { encoding: "utf8" })
  const survivors = (scan.stdout ?? "").split("\n").filter((line) => line.includes(sandbox.root) || line.includes(alternateRoot))
  const proven = scan.status === 0 && survivors.length === 0 && receipts.every((entry) => entry.stopExit === 0 && entry.pidStillAlive === false)
  if (proven) rmSync(sandbox.root, { recursive: true, force: true })
  return { sandboxRoot: sandbox.root, sockets: receipts, processScanExit: scan.status, survivors, sandboxRemoved: !existsSync(sandbox.root), proven }
}
