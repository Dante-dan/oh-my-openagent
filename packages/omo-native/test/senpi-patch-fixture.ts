import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const engineEntry = import.meta.resolve("@code-yeongyu/senpi")

/** Install the pinned upstream targets that the postinstall transformer requires. */
export function installOAuthLoginTargets(root: string): void {
  for (const [relative, source] of [
    [
      "dist/core/extensions/builtin/claude-sdk-oauth/oauth-login.js",
      new URL("./core/extensions/builtin/claude-sdk-oauth/oauth-login.js", engineEntry),
    ],
    [
      "node_modules/@earendil-works/pi-ai/dist/auth/pool/slots.js",
      new URL("../node_modules/@earendil-works/pi-ai/dist/auth/pool/slots.js", engineEntry),
    ],
  ] as const) {
    const destination = join(root, relative)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, readFileSync(source, "utf8"))
  }
}
