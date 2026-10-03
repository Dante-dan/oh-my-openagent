import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

import type { TmuxCommandResult } from "../runner"

const staleSessionSweepSpecifier = import.meta.resolve("./stale-session-sweep")
const environmentSpecifier = import.meta.resolve("./environment")
const loggerSpecifier = import.meta.resolve("../../logger")
const runnerSpecifier = import.meta.resolve("../runner")
const sessionKillSpecifier = import.meta.resolve("./session-kill")
const tmuxPathResolverSpecifier = import.meta.resolve("../../../tools/interactive-bash/tmux-path-resolver")

const runTmuxCommandMock = mock(async (): Promise<TmuxCommandResult> => ({
	success: true,
	output: "",
	stdout: "",
	stderr: "",
	exitCode: 0,
}))
const killTmuxSessionIfExistsMock = mock(async (): Promise<boolean> => true)
const isInsideTmuxMock = mock((): boolean => true)
const getTmuxPathMock = mock(async (): Promise<string | undefined> => "sh")
const logMock = mock(() => undefined)
const deadPid = process.pid + 1
const livePid = process.pid + 2
const deadSession = `omo-agents-${deadPid}`
const liveSession = `omo-agents-${livePid}`

async function loadSweepStaleOmoAgentSessions(): Promise<typeof import("./stale-session-sweep").sweepStaleOmoAgentSessions> {
	const module = await import(`${staleSessionSweepSpecifier}?test=${crypto.randomUUID()}`)
	return module.sweepStaleOmoAgentSessions
}

function registerModuleMocks(): void {
	mock.module(environmentSpecifier, () => ({
		isInsideTmux: isInsideTmuxMock,
		isNativeTmux: isInsideTmuxMock,
		isTmuxPaneCompatible: isInsideTmuxMock,
	}))
	mock.module(loggerSpecifier, () => ({ log: logMock }))
	mock.module(runnerSpecifier, () => ({ runTmuxCommand: runTmuxCommandMock }))
	mock.module(sessionKillSpecifier, () => ({ killTmuxSessionIfExists: killTmuxSessionIfExistsMock }))
	mock.module(tmuxPathResolverSpecifier, () => ({ getTmuxPath: getTmuxPathMock }))
}

describe("sweepStaleOmoAgentSessions runtime runner integration", () => {
	beforeEach(() => {
		registerModuleMocks()
		runTmuxCommandMock.mockClear()
		killTmuxSessionIfExistsMock.mockClear()
		isInsideTmuxMock.mockClear()
		getTmuxPathMock.mockClear()
		logMock.mockClear()

		runTmuxCommandMock.mockResolvedValue({
			success: true,
			output: `${deadSession}\n${liveSession}`,
			stdout: `${deadSession}\n${liveSession}`,
			stderr: "",
			exitCode: 0,
		})
		killTmuxSessionIfExistsMock.mockResolvedValue(true)
		isInsideTmuxMock.mockReturnValue(true)
		getTmuxPathMock.mockResolvedValue("sh")
	})

	it("#given dead and live sessions listed by tmux #when sweeping #then only kills the dead session through the shared runner", async () => {
		// given
		const processKillSpy = spyOn(process, "kill").mockImplementation((pid) => {
			if (pid === deadPid) {
				throw Object.assign(new Error("No such process"), { code: "ESRCH" })
			}
			return true
		})

		try {
			const sweepStaleOmoAgentSessions = await loadSweepStaleOmoAgentSessions()

			// when
			const result = await sweepStaleOmoAgentSessions()

			// then
			expect(result).toBe(1)
			expect(runTmuxCommandMock.mock.calls).toEqual([
				["sh", ["list-sessions", "-F", "#{session_name}"]],
			])
			expect(processKillSpy.mock.calls).toEqual([[deadPid, 0], [livePid, 0]])
			expect(killTmuxSessionIfExistsMock.mock.calls).toEqual([[deadSession]])
		} finally {
			processKillSpy.mockRestore()
		}
	})
})
