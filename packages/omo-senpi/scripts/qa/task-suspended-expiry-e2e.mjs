// Canonical live coverage for #9350. The timestamp advances the existing 30-minute
// deadline; the harness, child sessions, store and parent delivery remain real.
// This lane covers graceful suspension. Host-kill coverage must be recorded separately.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSandbox } from "./drive.mjs"
import { childSessionHasAssistant, childSessionText, findTaskByName, pollUntil, seedResumeProject, sessionIdFromEvents, taskStateDir } from "./resume-e2e-runtime.mjs"
import { happyRun1Script, resumeOmoConfig, resumeProbeScript } from "./task-resume-e2e-scenarios.mjs"
import { startRun, verdict, writeLaneLog } from "./task-resume-e2e.mjs"

export async function runSuspendedExpiryLane(ctx, { killHost = false } = {}) {
  const sandbox = createSandbox()
  ctx.sandboxes.push(sandbox)
  seedResumeProject(sandbox, resumeOmoConfig())
  const release1 = join(sandbox.root, "expiry-release-1")
  const run1 = startRun(ctx, sandbox, happyRun1Script(release1))
  const seeded = await pollUntil(() => childSessionHasAssistant(sandbox, findTaskByName(sandbox, "midchild")?.task_id ?? ""), Boolean, 60_000)
  const hostPid = findTaskByName(sandbox, "midchild")?.host_pid
  if (killHost && seeded && typeof hostPid === "number") process.kill(hostPid, "SIGINT")
  else writeFileSync(release1, "go\n")
  const result1 = await run1.completion
  writeLaneLog(ctx, "expiry-run1", result1)
  const parked = findTaskByName(sandbox, "midchild")
  ctx.checks.suspended_expiry_setup = verdict(seeded && (killHost || result1.status === 0) && parked?.residency_state === "persisted_only")
  if (parked === undefined || parked.residency_state !== "persisted_only") return
  const partialBefore = childSessionText(sandbox, parked.task_id)
  const path = join(taskStateDir(sandbox), "tasks", `${parked.task_id}.json`)
  const record = JSON.parse(readFileSync(path, "utf8"))
  record.suspended_at = new Date(Date.now() - 30 * 60_000 - 1_000).toISOString()
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
  // A disabled reattach lane is an explicit product configuration, not a mocked lifecycle.
  writeFileSync(join(sandbox.cwd, ".omo", "omo.json"), `${JSON.stringify(resumeOmoConfig({ reattach_on_reconcile: false }))}\n`)
  const release2 = join(sandbox.root, "expiry-release-2")
  const run2 = startRun(ctx, sandbox, resumeProbeScript(release2), sessionIdFromEvents(result1.events))
  const failed = await pollUntil(() => findTaskByName(sandbox, "midchild"), value => value?.status === "error", 60_000)
  writeFileSync(release2, "go\n")
  const result2 = await run2.completion
  writeLaneLog(ctx, "expiry-run2", result2)
  const reason = "failed: suspended_unresumable"
  ctx.checks.suspended_expiry_terminal_lane_released = verdict(result2.status === 0 && failed?.status === "error" && failed?.residency_state === "disposed" && failed?.error_message?.includes(reason))
  ctx.checks.suspended_expiry_partial_retained = verdict(partialBefore.length > 0 && childSessionText(sandbox, parked.task_id) === partialBefore)
  const notices = result2.events.filter(event => event.type === "message_end" && Array.isArray(event.message?.details) && event.message.details.some(item => item.customType === "senpi-task.completion" && item.details?.some(detail => detail.task_id === parked.task_id && detail.final_response?.includes(reason))))
  ctx.checks.suspended_expiry_one_parent_result = verdict(notices.length === 1)
  ctx.capture.suspendedExpiry = { taskId: parked.task_id, thresholdAdvancedByRecordTimestamp: true, parentResultCount: notices.length, hostKillPerformed: killHost && typeof hostPid === "number", hostSignal: killHost ? "SIGINT" : undefined, hostPid }
}
