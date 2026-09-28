# Auto-update test mock isolation (PR #8695)

The change removes a top-level `mock.module("./checker/latest-version")` from `hook.test.ts`. The hook tests inject `runBackgroundUpdateCheck` directly, so that module mock does not exercise production hook behavior. Bun retained it across test files and made five `checker.test.ts` registry cases receive the hook test's `3.0.1` stub.

## Verification

- Before the removal, Bun 1.4.2 running `hook.test.ts` and `checker.test.ts` together with `--randomize --seed=1` produced 10 passes and 5 failures in `getLatestVersion` (recorded in the issue-tracker CI investigation event on 2026-09-28).
- After the removal and after merging current `dev`, the same two-file command from `/private/tmp` produced 15 passes, 0 failures, 49 assertions. This checks the cross-file ordering failure rather than only either file in isolation.
- `bun test` for `script/publish-release-platform-workflow.test.ts` after the `dev` merge produced 15 passes, 0 failures, 99 assertions, including the PR's propagation-budget assertion.
- The `dev` merge conflict was resolved by retaining both the PR's release assertions and upstream's Windows ARM64 assertions. The merged workflow test above verifies both sets.

The repository test preload could not finish locally: its vendored lsp-daemon bootstrap needed `npm`, which was not on the repository-selected PATH. The `opencode-qa` common self-check was attempted; it reported a missing `opencode` binary, so no live OpenCode harness result is claimed. No production hook implementation changed. Remote CI remains the full-suite check.
