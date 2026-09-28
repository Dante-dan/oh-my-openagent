/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { load } from "js-yaml"
import { z } from "zod"

import { DESKTOP_ENGINE_RELEASE_HOSTS, desktopEngineReleaseAssetName } from "../packages/senpi-desktop-engine/src/release-assets"
import { PLATFORMS } from "./build-binaries"
import { DESKTOP_ENGINE_TARGETS } from "./release-desktop-engine-target"
import { runBlock, sliceWorkflowSection } from "./release-workflow-test-steps"

const publishWorkflowPath = new URL("../.github/workflows/publish.yml", import.meta.url)
const publishPlatformWorkflowPath = new URL("../.github/workflows/publish-platform.yml", import.meta.url)

describe("release and platform publish workflows", () => {
  test("publishes platform packages before installable wrappers", () => {
    // #given
    const workflow = readFileSync(publishWorkflowPath, "utf8")

    // #when
    const computesReleaseMetadata = workflow.includes("release-metadata:") &&
      workflow.includes("outputs:") &&
      workflow.includes("version: ${{ steps.version.outputs.version }}") &&
      workflow.includes("dist_tag: ${{ steps.version.outputs.dist_tag }}")
    const computesVersionOnce = (workflow.match(/id: version/g) ?? []).length === 1
    const platformUsesMetadata = workflow.includes("version: ${{ needs.release-metadata.outputs.version }}") &&
      workflow.includes("dist_tag: ${{ needs.release-metadata.outputs.dist_tag }}")
    const mainWaitsForPlatform = workflow.includes(
      "needs: [gate-reuse, preflight-trust, release-metadata, prepare-release-state, publish-platform]",
    ) &&
      workflow.includes("inputs.skip_platform == true || inputs.lazycodex_only == true || needs.publish-platform.result == 'success'")
    const releaseUsesMetadata = workflow.includes("VERSION: ${{ needs.release-metadata.outputs.version }}")
    const wrappersVerifyPlatformPackages = workflow.includes("name: Verify platform packages are published") &&
      workflow.includes("Missing platform package(s); refusing to publish wrappers.")
    const platformPropagationBudget = workflow.includes('ATTEMPTS="${PROPAGATION_ATTEMPTS:-100}"') &&
      workflow.includes('DELAY="${PROPAGATION_DELAY:-15}"')

    // #then
    expect(computesReleaseMetadata, "release metadata must be a first-class job output").toBe(true)
    expect(computesVersionOnce, "version and dist tag must be computed exactly once").toBe(true)
    expect(platformUsesMetadata, "platform workflow must consume the shared release metadata").toBe(true)
    expect(mainWaitsForPlatform, "wrapper publish must wait for platform success unless pre-published platforms are explicitly verified").toBe(true)
    expect(releaseUsesMetadata, "release tail must use the shared release metadata").toBe(true)
    expect(wrappersVerifyPlatformPackages, "wrappers must verify matching platform binaries exist before npm publish").toBe(true)
    expect(platformPropagationBudget, "wrapper publish must tolerate the observed 12-16 minute npm propagation lag").toBe(true)
  })

  test("fails when a required platform artifact is missing", () => {
    // #given
    const workflow = readFileSync(publishPlatformWorkflowPath, "utf8")

    // #when
    const downloadStep = sliceWorkflowSection(
      workflow,
      "      - name: Download artifact",
      "      - name: Extract artifact",
    )
    const downloadsWhenPublishNeeded = downloadStep.includes("if: steps.check.outputs.skip_all != 'true'")
    const suppressesDownloadFailure = downloadStep.includes("continue-on-error: true")

    // #then
    expect(downloadsWhenPublishNeeded, "publish job must download artifacts for packages that still need publishing").toBe(true)
    expect(suppressesDownloadFailure, "missing required artifacts must fail the reusable publish workflow").toBe(false)
  })

  test("publishes openagent platform packages even when legacy opencode publish is unavailable", () => {
    // #given
    const workflow = readFileSync(publishPlatformWorkflowPath, "utf8")

    // #when
    const opencodePublishStep = sliceWorkflowSection(
      workflow,
      "      - name: Publish oh-my-opencode-${{ matrix.platform }}",
      "      - name: Publish oh-my-openagent-${{ matrix.platform }}",
    )
    const openagentPublishStep = sliceWorkflowSection(
      workflow,
      "      - name: Publish oh-my-openagent-${{ matrix.platform }}",
      "        timeout-minutes: 15",
    )

    // #then
    expect(opencodePublishStep.includes("continue-on-error: true"), "legacy opencode package publish must not block renamed platform publish").toBe(true)
    expect(openagentPublishStep.includes("if: always() && steps.check.outputs.skip_openagent != 'true' && steps.download.outcome == 'success'"), "renamed platform publish must run after legacy publish failures").toBe(true)
    expect(openagentPublishStep.includes(".bin ="), "renamed internal platform packages must not require public bin metadata").toBe(false)
  })

  test("keeps the platform publish workflow step syntax valid around version updates", () => {
    // #given
    const workflow = readFileSync(publishPlatformWorkflowPath, "utf8")

    // #when
    const duplicateVersionStep = workflow.includes(
      "      - name: Update version in package.json\n      - name: Update version in package.json",
    )

    // #then
    expect(duplicateVersionStep, "platform publish workflow must not contain adjacent duplicate step names").toBe(false)
  })

  test("publishes platform launchers without Bun compile", () => {
    // #given
    const workflow = readFileSync(publishPlatformWorkflowPath, "utf8")

    // #when
    const buildStep = sliceWorkflowSection(
      workflow,
      "      - name: Build launcher",
      "      - name: Verify darwin launcher",
    )
    const darwinVerifyStep = sliceWorkflowSection(
      workflow,
      "      - name: Verify darwin launcher",
      "      - name: Compress binary",
    )

    // #then
    expect(buildStep).toContain("bun run build:binaries")
    expect(buildStep).toContain("bin/oh-my-opencode.js")
    expect(buildStep).not.toContain("bun build packages/omo-opencode/src/cli/index.ts --compile")
    expect(darwinVerifyStep).toContain("#!/usr/bin/env node")
    expect(darwinVerifyStep).not.toContain("codesign")
  })

  test("regenerates and commits release lockfiles only in the prepared source state", () => {
    // #given
    const workflow = readFileSync(publishWorkflowPath, "utf8")
    const prepareStep = sliceWorkflowSection(workflow, "      - name: Prepare release state (generation)", "      - name: Publish prepared release state")
    const releaseJob = workflow.slice(workflow.indexOf("  release:"))
    const codexLockfileCommand = "npm --prefix packages/omo-codex/plugin install --package-lock-only --ignore-scripts --no-audit --fund=false"
    const codexLockfilePath = "packages/omo-codex/plugin/package-lock.json"

    // #then
    expect(prepareStep).toContain(codexLockfileCommand)
    expect(prepareStep.indexOf(codexLockfileCommand)).toBeGreaterThan(prepareStep.indexOf("node packages/omo-codex/plugin/scripts/sync-version.mjs"))
    expect(prepareStep.indexOf("bun install --lockfile-only")).toBeGreaterThan(prepareStep.indexOf(codexLockfileCommand))
    expect(prepareStep).toContain(codexLockfilePath)
    expect(prepareStep).toContain("git commit -m \"release: v${VERSION}\"")
    expect(releaseJob).not.toContain("name: Apply release version to source tree")
    expect(releaseJob).not.toContain("name: Commit version bump")
  })

  test("validates an existing release tag before redispatching its prepared source", () => {
    // #given
    const workflow = readFileSync(publishWorkflowPath, "utf8")
    const dispatchJob = sliceWorkflowSection(workflow, "  dispatch-provenance-safe-publish:", "  publish-main:")

    // #when
    const checksExistingTagTarget =
      dispatchJob.includes('RELEASE_TAG="v${VERSION}"') &&
      dispatchJob.includes('if git rev-parse -q --verify "refs/tags/${RELEASE_TAG}" >/dev/null; then') &&
      dispatchJob.includes('TAG_SHA="$(git rev-list --max-count=1 "${RELEASE_TAG}")"') &&
      dispatchJob.includes('"$TAG_SHA" != "$RELEASE_SHA"')
    const createsMissingTagAtPreparedSource = dispatchJob.includes('git tag "${RELEASE_TAG}" "$RELEASE_SHA"')
    const redispatchesTag = dispatchJob.includes('gh workflow run publish.yml --ref "${RELEASE_TAG}"')
    const marketplacePushSkipsWhenClean = workflow.includes("LazyCodex marketplace already up to date")

    // #then
    expect(checksExistingTagTarget, "reruns must reject a release tag that points away from the prepared source").toBe(true)
    expect(createsMissingTagAtPreparedSource, "the first publish run must create its tag at the prepared source").toBe(true)
    expect(redispatchesTag, "the provenance-bearing publish run must be dispatched from the verified release tag").toBe(true)
    expect(marketplacePushSkipsWhenClean, "marketplace sync must skip push when rerun has no changes").toBe(true)
  })

  test("enumerates windows-arm64 consistently across every platform-list surface", () => {
    // #given
    const publishSource = readFileSync(new URL("../script/publish.ts", import.meta.url), "utf8")
    const publishPlatformWorkflow = readFileSync(publishPlatformWorkflowPath, "utf8")

    const publishIdsBlock = publishSource.slice(
      publishSource.indexOf("PLATFORM_PACKAGE_IDS = ["),
      publishSource.indexOf("] as const"),
    )
    const publishIds = [...publishIdsBlock.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]).sort()

    const buildBinariesPlatforms = PLATFORMS.map((entry) => entry.platform).sort()

    const matrixLists = [...publishPlatformWorkflow.matchAll(/^\s*platform: \[([^\]]+)\]/gm)].map((match) =>
      match[1]
        .split(",")
        .map((value) => value.trim())
        .sort(),
    )

    const publishWorkflow = readFileSync(publishWorkflowPath, "utf8")
    const publishYmlLists = [
      ...[...publishWorkflow.matchAll(/PLATFORMS=\(([^)]+)\)/g)].map((match) => match[1]),
      ...[...publishWorkflow.matchAll(/for platform in (darwin-arm64[^\n;]*); do/g)].map((match) => match[1]),
    ].map((list) => list.trim().split(/\s+/).sort())

    // #when / #then
    expect(publishIds, "PLATFORM_PACKAGE_IDS must list windows-arm64").toContain("windows-arm64")
    expect(buildBinariesPlatforms, "build-binaries PLATFORMS must list windows-arm64").toContain("windows-arm64")
    expect(matrixLists.length, "publish-platform.yml must define both build and publish matrices").toBe(2)
    for (const matrixList of matrixLists) {
      expect(matrixList, "every publish-platform matrix must list windows-arm64").toContain("windows-arm64")
      expect(matrixList, "publish-platform matrix must match build-binaries PLATFORMS exactly").toEqual(
        buildBinariesPlatforms,
      )
    }
    expect(publishIds, "PLATFORM_PACKAGE_IDS must match build-binaries PLATFORMS exactly").toEqual(
      buildBinariesPlatforms,
    )
    expect(publishYmlLists.length, "publish.yml must enumerate platforms in 2 PLATFORMS arrays + 2 prepared-source version-bump loops").toBe(4)
    for (const publishYmlList of publishYmlLists) {
      expect(publishYmlList, "every publish.yml platform list must match build-binaries PLATFORMS exactly").toEqual(
        buildBinariesPlatforms,
      )
    }
  })

  test("matches the canonical platform set in optionalDependencies and on-disk platform packages", () => {
    // #given
    const rootManifest: { optionalDependencies?: Record<string, string> } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    )
    const buildBinariesPlatforms = PLATFORMS.map((entry) => entry.platform).sort()
    const platformPrefix = "oh-my-opencode-"

    const optionalDependencyPlatforms = Object.keys(rootManifest.optionalDependencies ?? {})
      .filter((name) => name.startsWith(platformPrefix))
      .map((name) => name.slice(platformPrefix.length))
      .sort()

    const onDiskPlatforms = readdirSync(new URL("../packages/", import.meta.url))
      .filter((name) => name.startsWith(platformPrefix))
      .map((name) => name.slice(platformPrefix.length))
      .sort()

    // #when / #then
    expect(
      optionalDependencyPlatforms,
      "root optionalDependencies must list every canonical platform package",
    ).toEqual(buildBinariesPlatforms)
    expect(
      onDiskPlatforms,
      "packages/ must contain a directory for every canonical platform package",
    ).toEqual(buildBinariesPlatforms)
  })
})

describe("release binary asset lane in the platform publish workflow", () => {
  test("builds every available engine with the pinned target before compiled payload staging", () => {
    // Given the actual GitHub Actions job graph and the canonical target fixture.
    const stepsSchema = z.array(z.object({ name: z.string().optional(), run: z.string().optional(), if: z.string().optional() }))
    const workflow = z.object({ jobs: z.object({
      "desktop-engine": z.object({ strategy: z.object({ matrix: z.object({ include: z.array(z.object({
        host: z.string(), rust_target: z.string(), binary: z.string(),
      })) }) }), steps: stepsSchema }),
      build: z.object({ needs: z.literal("desktop-engine"), steps: stepsSchema }),
    }) }).parse(load(readFileSync(publishPlatformWorkflowPath, "utf8")))
    const engine = workflow.jobs["desktop-engine"]
    const build = workflow.jobs.build
    const step = (steps: z.infer<typeof stepsSchema>, name: string) => {
      const index = steps.findIndex((candidate) => candidate.name === name)
      const value = steps.at(index)
      if (index < 0 || value === undefined) throw new Error(`missing workflow step: ${name}`)
      return { index, value }
    }

    // When the four artifact producers and the twelve platform consumers are resolved.
    const install = step(engine.steps, "Install pinned Rust toolchain and target")
    const cargo = step(engine.steps, "Build desktop engine")
    const asset = step(engine.steps, "Stage desktop engine release asset")
    const resolve = step(build.steps, "Resolve desktop engine availability")
    const download = step(build.steps, "Download desktop engine for compiled payload")
    const stage = step(build.steps, "Stage target-specific Rust engine for compiled payload")
    const compile = step(build.steps, "Build release binary")

    // Then toolchain, triple, artifact transport and staging preserve the Cargo output path.
    expect(install.value.run).toContain("rust-toolchain.toml")
    expect(install.value.run).toContain('rustup toolchain install "$toolchain"')
    expect(install.value.run).toContain('rustup target add "${{ matrix.rust_target }}"')
    expect(install.index).toBeLessThan(cargo.index)
    expect(cargo.value.run).toContain('--target "${{ matrix.rust_target }}"')
    expect(cargo.index).toBeLessThan(asset.index)
    expect(asset.value.run).toContain('target/${{ matrix.rust_target }}/release/${{ matrix.binary }}')
    expect(resolve.index).toBeLessThan(download.index)
    expect(download.index).toBeLessThan(stage.index)
    expect(stage.index).toBeLessThan(compile.index)
    expect(download.value.if).toBe("steps.desktop-engine-target.outputs.host != ''")
    expect(stage.value.if).toBe(download.value.if)
    expect(stage.value.run).toContain('cp ".omo/desktop-engine-assets/$ENGINE_ASSET" "$ENGINE_SOURCE"')
    expect(compile.value.run).toContain("script/build-omo-binary.ts")
    expect(build.steps.some((candidate) => candidate.run?.includes("cargo build"))).toBe(false)
    expect(engine.strategy.matrix.include.map((entry) => entry.host)).toEqual([...DESKTOP_ENGINE_RELEASE_HOSTS])
    for (const target of DESKTOP_ENGINE_TARGETS) {
      if (!target.available) {
        expect(target.host).toBeNull()
        expect(target.source).toBeNull()
        continue
      }
      const producer = engine.strategy.matrix.include.find((entry) => entry.host === target.host)
      expect(producer).toBeDefined()
      expect(target.source).toBe(`target/${producer?.rust_target}/release/${producer?.binary}`)
    }
  })

  test("uploads one engine artifact per canonical host without baseline duplicates", () => {
    // Given the dedicated four-host build matrix.
    const workflow = readFileSync(publishPlatformWorkflowPath, "utf8")
    const engineJob = sliceWorkflowSection(workflow, "  desktop-engine:\n", "  build:\n")

    // When its host list is compared to the release asset contract, each asset has one producer.
    const hosts = [...engineJob.matchAll(/^\s+- \{ host: ([a-z0-9-]+), runner:/gm)].map((match) => match[1])
    expect(hosts).toEqual([...DESKTOP_ENGINE_RELEASE_HOSTS])
    expect(new Set(hosts).size).toBe(4)
    expect(engineJob).toContain("name: desktop-engine-${{ matrix.host }}")
  })

  test("runs the staged locator proof for changes to the release target fixture", () => {
    // Given a fixture change on either CI event.
    const workflow = readFileSync(new URL("../.github/workflows/desktop-engine.yml", import.meta.url), "utf8")
    const triggers = sliceWorkflowSection(workflow, "on:\n", "concurrency:\n")
    const proof = sliceWorkflowSection(workflow, "      - name: Prove staged desktop engine resolution and selftest\n", "      - name: Verify release asset assembly without publishing\n")

    // When the event paths are evaluated, both push and PR cover the fixture and target resolver.
    expect(triggers.match(/"script\/release-desktop-engine-fixture\.json"/g)).toHaveLength(2)
    expect(triggers.match(/"script\/release-desktop-engine-target\.ts"/g)).toHaveLength(2)
    expect(proof).toContain("bun script/desktop-engine-ci-proof.ts")
  })

  test("copies the canonical release artifact into the exact target-specific Rust source", () => {
    // Given the x64 Darwin cross-target and an artifact downloaded without a Rust target layout.
    const root = mkdtempSync(join(tmpdir(), "omo-engine-stage-"))
    try {
      const workflow = readFileSync(publishPlatformWorkflowPath, "utf8")
      const stage = runBlock(workflow, "      - name: Stage target-specific Rust engine for compiled payload\n", "      - name: Build release binary\n")
      const source = "target/x86_64-apple-darwin/release/senpi-desktop-engine"
      const asset = "senpi-desktop-engine-darwin-x64"
      const download = join(root, ".omo", "desktop-engine-assets")
      mkdirSync(download, { recursive: true })
      writeFileSync(join(download, asset), "x64 cross-target binary")

      // When the actual workflow staging step runs, only the declared triple receives the bytes.
      const result = spawnSync("bash", ["-e", "-c", stage], {
        cwd: root,
        env: { ...process.env, ENGINE_ASSET: asset, ENGINE_SOURCE: source },
        encoding: "utf8",
      })
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(root, source), "utf8")).toBe("x64 cross-target binary")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rebuilds a baseline binary when its shared engine asset is absent", () => {
    // Given an existing omo baseline binary but no Darwin x64 engine release asset.
    const root = mkdtempSync(join(tmpdir(), "omo-engine-release-check-"))
    try {
      const workflow = readFileSync(publishPlatformWorkflowPath, "utf8")
      const check = runBlock(workflow, "      - name: Check release assets\n", "      - name: Resolve desktop engine availability\n")
        .replaceAll("${{ matrix.platform }}", "darwin-x64-baseline")
      const gh = join(root, "gh")
      writeFileSync(gh, "#!/bin/bash\nif [ \"$1\" = release ] && [ \"$2\" = view ]; then cat \"$ASSET_NAMES_FILE\"; else exit 1; fi\n")
      chmodSync(gh, 0o755)
      const names = join(root, "asset-names")
      const output = join(root, "output")
      const env = {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        VERSION: "5.0.0",
        OMO_AI_VERSION: "5.0.0",
        ASSET_NAMES_FILE: names,
        GITHUB_OUTPUT: output,
      }

      // When only the executable exists, the real workflow shell must request a build.
      writeFileSync(names, "omo-darwin-x64-baseline\n")
      const missing = spawnSync("bash", ["-e", "-c", check], { cwd: new URL("..", import.meta.url), env, encoding: "utf8" })
      expect(missing.status, missing.stderr).toBe(0)
      expect(readFileSync(output, "utf8")).toContain("binary_exists=false")

      // When the shared engine is also present, the release bytes are reused.
      writeFileSync(names, "omo-darwin-x64-baseline\nsenpi-desktop-engine-darwin-x64\n")
      writeFileSync(output, "")
      const complete = spawnSync("bash", ["-e", "-c", check], { cwd: new URL("..", import.meta.url), env, encoding: "utf8" })
      expect(complete.status, complete.stderr).toBe(0)
      expect(readFileSync(output, "utf8")).toContain("binary_exists=true")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("verifies precisely twelve launchers and four engines on reruns without publishing", () => {
    // Given a synthetic release with canonical names and independently computed hashes.
    const root = mkdtempSync(join(tmpdir(), "omo-engine-assets-"))
    try {
      const assets = join(root, "assets")
      mkdirSync(assets)
      const binaries = PLATFORMS.map(({ platform }) => `omo-${platform}${platform.startsWith("windows-") ? ".exe" : ""}`)
      const engines = DESKTOP_ENGINE_RELEASE_HOSTS.map((host) => desktopEngineReleaseAssetName(host))
      if (engines.some((asset) => asset === null)) throw new Error("release host without asset name")
      const checksum = (name: string): string => {
        const bytes = `test executable ${name}\n`
        writeFileSync(join(assets, name), bytes)
        return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`
      }
      writeFileSync(join(assets, "SHA256SUMS"), `${binaries.map(checksum).join("\n")}\n`)
      writeFileSync(join(assets, "senpi-desktop-engine-checksums.txt"), `${engines.map((name) => checksum(name ?? "")).join("\n")}\n`)
      const gh = join(root, "gh")
      writeFileSync(gh, "#!/bin/bash\n[ \"$1\" = release ] && [ \"$2\" = download ] || exit 1\ncp \"$ASSET_SOURCE_DIR\"/* \"${@: -1}/\"\n")
      chmodSync(gh, 0o755)
      if (spawnSync("bash", ["-c", "command -v shasum"]).status !== 0) {
        const shasum = join(root, "shasum")
        writeFileSync(shasum, "#!/bin/bash\n[ \"$1\" = -a ] && [ \"$2\" = 256 ] || exit 2\nshift 2\nexec sha256sum \"$@\"\n")
        chmodSync(shasum, 0o755)
      }
      const workflow = readFileSync(publishWorkflowPath, "utf8")
      const verify = runBlock(workflow, "      - name: Verify uploaded assets\n", "      - name: Delete draft release\n")
      const execute = () => spawnSync("bash", ["-e", "-c", verify], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, VERSION: "5.0.0", ASSET_SOURCE_DIR: assets },
        encoding: "utf8",
      })

      // When every release asset exists, the actual workflow verification passes.
      const complete = execute()
      expect(complete.status, complete.stderr).toBe(0)
      expect(complete.stdout).toContain("Verified 18/18 release assets")

      // When the engine asset is absent, a skip_platform rerun cannot go green.
      unlinkSync(join(assets, "senpi-desktop-engine-darwin-x64"))
      const missing = execute()
      expect(missing.status).not.toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
