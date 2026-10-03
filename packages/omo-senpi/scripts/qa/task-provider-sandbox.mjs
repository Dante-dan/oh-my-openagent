import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../plugin")

/** Seed only this scenario's daemon launch spec with its keyless child provider. */
export function seedTaskProvider(sandbox, mockProviderEntry) {
  const isolatedPluginRoot = join(sandbox.root, "plugin")
  if (!existsSync(isolatedPluginRoot)) cpSync(pluginRoot, isolatedPluginRoot, { recursive: true })
  const specPath = join(isolatedPluginRoot, "daemon-launch-spec.json")
  const spec = JSON.parse(readFileSync(specPath, "utf8"))
  const entry = `./${basename(mockProviderEntry)}`
  copyFileSync(mockProviderEntry, join(isolatedPluginRoot, basename(mockProviderEntry)))
  if (!spec.core.extensions.includes(entry)) spec.core.extensions.push(entry)
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`)
  const settingsPath = join(sandbox.agentDir, "settings.json")
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
  settings.packages = [isolatedPluginRoot]
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  return isolatedPluginRoot
}
