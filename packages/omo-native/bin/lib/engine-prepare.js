import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { floorClaudeCodeVersion } from "./claude-code-floor.js"
import { prepareCompileSafeEngine } from "./compile-safe-engine.js"
import { prepareRpcStreamErrors } from "./rpc-stream-errors.js"

// Written inside the engine tree, so reinstalling or upgrading the engine drops it with the tree.
export const ENGINE_PREPARED_STAMP = ".omo-engine-prepared"

export function preparePackagedLaunchSpec(pluginRoot) {
  const spec = join(pluginRoot, "daemon-launch-spec.json")
  // The source workspace has no staged plugin until build:omo-native; published packages do.
  if (!existsSync(spec)) return
  const stat = lstatSync(spec)
  if (!stat.isFile()) throw new Error("daemon launch spec is not a regular file")
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) chmodSync(spec, stat.mode & ~0o022)
}

export function prepareInstalledEngine(senpiRoot, pluginRoot) {
  floorClaudeCodeVersion(senpiRoot)
  prepareCompileSafeEngine(senpiRoot)
  prepareRpcStreamErrors(senpiRoot)
  if (pluginRoot !== undefined) preparePackagedLaunchSpec(pluginRoot)
}

export function writeEnginePreparedStamp(senpiRoot, omoVersion) {
  writeFileSync(join(senpiRoot, ENGINE_PREPARED_STAMP), `${omoVersion}\n`)
}

function isPreparedFor(senpiRoot, omoVersion) {
  const stamp = join(senpiRoot, ENGINE_PREPARED_STAMP)
  return existsSync(stamp) && readFileSync(stamp, "utf8").trim() === omoVersion
}

/**
 * postinstall prepares the engine, but it never runs under `ignore-scripts=true` or Bun's blocked
 * postinstalls (#8713). The launcher therefore prepares an unstamped engine before starting it.
 * A failure is reported with the reinstall command and never blocks the launch: an unprepared
 * engine still runs, only without the guards.
 */
export function ensureEnginePrepared({ senpiRoot, pluginRoot, omoVersion, reinstallCommand, report = (line) => { process.stderr.write(line) } }) {
  if (isPreparedFor(senpiRoot, omoVersion)) return
  try {
    prepareInstalledEngine(senpiRoot, pluginRoot)
    writeEnginePreparedStamp(senpiRoot, omoVersion)
  } catch (error) {
    report(`omo: could not prepare the installed engine (${error.message}); reinstall with: ${reinstallCommand}\n`)
  }
}
