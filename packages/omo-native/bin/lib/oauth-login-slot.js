import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const targetSymbol = 'Symbol.for("omo-ai.oauth-login-slot")'
const oauthReturn = 'return upsertAccount(current, toSlot(credential, name, "login"));'
const markedOAuthReturn = `const updated = upsertAccount(current, toSlot(credential, name, "login"));
            Object.defineProperty(updated, ${targetSymbol}, { value: name });
            return updated;`

const mergeFunction = `function mergeProvidedPool(current, existing, provided) {
    const known = new Set(existing.map((slot) => slot.name));
    const added = provided.filter((slot) => !known.has(slot.name));
    return added.length === 0 ? current : { ...current, accounts: [...existing, ...added] };
}`
const targetedMergeFunction = `function mergeProvidedPool(current, existing, provided, loginTarget) {
    const replacement = typeof loginTarget === "string"
        ? provided.find((slot) => slot.name === loginTarget)
        : undefined;
    const accounts = replacement === undefined
        ? existing
        : existing.map((slot) => (slot.name === loginTarget ? replacement : slot));
    const known = new Set(existing.map((slot) => slot.name));
    const added = provided.filter((slot) => !known.has(slot.name));
    return replacement === undefined && added.length === 0
        ? current
        : { ...current, accounts: [...accounts, ...added] };
}`
const mergeCall = "mergeProvidedPool(current, storedAccounts, provided)"
const targetedMergeCall = `mergeProvidedPool(current, storedAccounts, provided, flat[${targetSymbol}])`

function replaceOnce(path, source, expected, replacement, marker, label) {
  if (source.includes(replacement) || source.includes(marker)) return source
  if (!source.includes(expected)) throw new Error(`omo-ai: unsupported Senpi ${label}`)
  return source.replace(expected, replacement)
}

/**
 * Carries the provider's explicitly selected re-login target across pi-ai's
 * credential lock without serializing it. The merge may then replace that one
 * slot while retaining every sibling from the latest stored value.
 */
export function prepareOAuthLoginSlot(senpiRoot) {
  const oauthPath = join(senpiRoot, "dist", "core", "extensions", "builtin", "claude-sdk-oauth", "oauth-login.js")
  const slotsPath = join(senpiRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "auth", "pool", "slots.js")
  for (const [path, label] of [
    [oauthPath, "Claude OAuth login target"],
    [slotsPath, "pi-ai login slot merge"],
  ]) {
    if (!existsSync(path)) throw new Error(`omo-ai: installed Senpi target is missing: ${label}`)
  }

  const oauthSource = readFileSync(oauthPath, "utf8")
  const patchedOAuth = replaceOnce(oauthPath, oauthSource, oauthReturn, markedOAuthReturn, targetSymbol, "Claude OAuth login target")
  if (patchedOAuth !== oauthSource) writeFileSync(oauthPath, patchedOAuth)

  const slotsSource = readFileSync(slotsPath, "utf8")
  let patchedSlots = replaceOnce(slotsPath, slotsSource, mergeFunction, targetedMergeFunction, targetedMergeFunction, "pi-ai login slot merge")
  patchedSlots = replaceOnce(slotsPath, patchedSlots, mergeCall, targetedMergeCall, targetedMergeCall, "pi-ai login slot call")
  if (patchedSlots !== slotsSource) writeFileSync(slotsPath, patchedSlots)
}
