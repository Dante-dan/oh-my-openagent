import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { load } from "js-yaml"
import { z } from "zod"

const stepSchema = z.object({
  id: z.string().optional(), uses: z.string().optional(), run: z.string().optional(),
  if: z.string().optional(), "continue-on-error": z.boolean().optional(),
  with: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})
const workflowSchema = z.object({
  on: z.record(z.string(), z.object({ paths: z.array(z.string()) })),
  permissions: z.record(z.string(), z.string()),
  jobs: z.object({ smoke: z.object({
    "runs-on": z.string(),
    strategy: z.object({ "fail-fast": z.boolean(), matrix: z.object({ include: z.array(z.object({ os: z.string(), target: z.string(), binary: z.string() })) }) }),
    steps: z.array(stepSchema),
  }) }).strict(),
})
function readWorkflow() {
  return workflowSchema.parse(load(readFileSync(new URL("../.github/workflows/release-binary-smoke.yml", import.meta.url), "utf8")))
}

describe("release binary PR smoke workflow", () => {
  test("runs only on pull requests when a release input changes", () => {
    // given / when
    const workflow = readWorkflow()
    // then
    expect(Object.keys(workflow.on)).toEqual(["pull_request"])
    expect(workflow.on.pull_request?.paths).toEqual([
      "script/build-omo-binary.ts", "script/build-omo-binary.test.ts",
      "script/senpi-worker-compile*.ts", "packages/omo-native/**",
      "script/qa/dependency-audit-*.ts", "package.json", "bun.lock",
      ".github/workflows/release-binary-smoke.yml",
    ])
    expect(workflow.permissions).toEqual({ contents: "read" })
  })

  test("uses native executable targets when scheduling each OS", () => {
    // given / when
    const job = readWorkflow().jobs.smoke
    // then
    expect(job["runs-on"]).toBe("${{ matrix.os }}")
    expect(job.strategy["fail-fast"]).toBe(false)
    expect(job.strategy.matrix.include).toEqual([
      { os: "ubuntu-latest", target: "linux-x64", binary: "omo-linux-x64" },
      { os: "macos-latest", target: "darwin-arm64", binary: "omo-darwin-arm64" },
      { os: "windows-latest", target: "windows-x64", binary: "omo-windows-x64.exe" },
    ])
  })

  test("patches and builds before testing when executing the smoke gate", () => {
    // given / when
    const steps = readWorkflow().jobs.smoke.steps
    const byId = new Map(steps.map((step) => [step.id, step]))
    // then: ids are workflow wiring, not authored step names.
    expect(steps.flatMap((step) => step.id ? [step.id] : [])).toEqual(["install", "patch", "build", "contracts", "capture", "receipts"])
    expect(steps.find((step) => step.uses === "oven-sh/setup-bun@v2")?.with?.["bun-version"]).toBe("1.4.2")
    expect(byId.get("install")?.run).toBe("bun install --frozen-lockfile --ignore-scripts")
    expect(byId.get("patch")?.run).toBe("node packages/omo-native/bin/senpi-patch.mjs")
    expect(byId.get("build")?.run).toContain("bun run script/build-omo-binary.ts")
    expect(byId.get("build")?.run).toContain('--target "${{ matrix.target }}"')
    expect(byId.get("build")?.run).toContain("--omo-version 0.0.0-ci")
    expect(byId.get("build")?.run).toContain("--omo-ai-version 0.0.0-ci")
    expect(byId.get("build")?.run).toContain('--out-dir "$OUT_DIR"')
    expect(byId.get("contracts")?.run).toContain("bun test script/build-omo-binary.test.ts script/senpi-worker-compile.test.ts")
    expect(byId.get("capture")?.run).toContain("--case bytes --case graph --case rpc --case extension")
    expect(byId.get("capture")?.run).toContain('--binary "$OUT_DIR/${{ matrix.binary }}"')
    expect(byId.get("capture")?.run).toContain("jq -e")
    expect(byId.get("capture")?.run).toContain('[.cases[].case] == ["bytes", "graph", "rpc", "extension"]')
    expect(steps.every((step) => step["continue-on-error"] !== true)).toBe(true)
  })

  test("uploads only JSON receipts when collecting CI evidence", () => {
    // given / when
    const steps = readWorkflow().jobs.smoke.steps
    const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
    // then
    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.with?.path).toBe("${{ runner.temp }}/release-binary-smoke/post/*.json")
    expect(uploads[0]?.with?.["if-no-files-found"]).toBe("error")
    expect(steps.some((step) => /(?:npm|bun) publish|gh release|gh workflow run/.test(step.run ?? ""))).toBe(false)
  })
})
