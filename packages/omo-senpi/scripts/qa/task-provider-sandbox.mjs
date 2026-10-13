import { chmodSync, copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const seededTaskSandboxes = new Set()

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../plugin")

/** The parent's -e provider is not inherited by a daemon. Seed only the scenario-owned payload. */
export function seedTaskProvider(sandbox, mockProviderEntry) {
  seededTaskSandboxes.add(sandbox)
  const isolatedPluginRoot = join(sandbox.root, "plugin")
  if (!existsSync(isolatedPluginRoot)) cpSync(pluginRoot, isolatedPluginRoot, { recursive: true })
  const specPath = join(isolatedPluginRoot, "daemon-launch-spec.json")
  const spec = JSON.parse(readFileSync(specPath, "utf8"))
  const entry = `./${basename(mockProviderEntry)}`
  copyFileSync(mockProviderEntry, join(isolatedPluginRoot, basename(mockProviderEntry)))
  if (!process.argv.includes("--without-host-provider") && !spec.core.extensions.includes(entry)) spec.core.extensions.push(entry)
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`)
  chmodSync(specPath, 0o600)
  const settingsPath = join(sandbox.agentDir, "settings.json")
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
  settings.packages = [isolatedPluginRoot]
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  return isolatedPluginRoot
}
