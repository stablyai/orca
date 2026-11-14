// Bound costly-host idle scans without relaxing active-agent completion detection; pane activity re-arms hot cadence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { resetAgentCompletionCoordinatorIdentitiesForTest } from './agent-completion-identity-store'
import { resetAgentProcessInspectionQueueForTests } from './process-inspection/agent-process-inspection-queue'

import type { TerminalProcessInspection as RuntimeTerminalProcessInspection } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'

function processResult(
  foregroundProcess: string | null,
  hasChildProcesses = foregroundProcess !== null
): RuntimeTerminalProcessInspection {
  return { foregroundProcess, hasChildProcesses }
}

function createCoordinator(
  inspectProcess: AgentCompletionCoordinatorOptions['inspectProcess'],
  overrides: Partial<AgentCompletionCoordinatorOptions> = {}
) {
  const dispatchCompletion = vi.fn()
  const coordinator = createAgentCompletionCoordinator({
    paneKey: 'tab-1:leaf-1',
    getPtyId: () => 'pty-1',
    inspectProcess,
    dispatchCompletion,
    isLive: () => true,
    shouldPollProcessCadence: () => true,
    isProcessInspectionCostly: () => true,
    ...overrides
  })
  return { coordinator, dispatchCompletion }
}

describe('agent completion no-evidence inspection cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Pin jitter to 1.0 so poll counts are exact.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    resetAgentProcessInspectionQueueForTests()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('leaves a hidden noisy pane fully unpolled in the shipped option shape', async () => {
    // Why: production sets no `shouldPollNoEvidenceProcessCadence`, so the
    // activity re-arm has to stay under the visibility/tracking gate — a
    // background `npm run dev` pane must not resume 3s host scans (#6288).
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess, {
      shouldPollProcessCadence: () => false,
      shouldPollNoEvidenceProcessCadence: undefined
    })

    coordinator.startProcessTracking()
    for (let tick = 0; tick < 12; tick += 1) {
      coordinator.observeOutputActivity()
      await vi.advanceTimersByTimeAsync(5_000)
    }

    expect(inspectProcess).not.toHaveBeenCalled()
  })

  it('keeps cadence disarmed and the done quiet window intact when tracking never starts', async () => {
    // Why: the hook-notification coordinator (agent-hook-completion-notifications)
    // never calls startProcessTracking. Pre-gate, hook evidence armed stub polls
    // whose null inspections cleared workingStatusObserved ~2s later, silently
    // bypassing the designed done quiet window. The gate makes hook-only
    // coordinators purely push-driven: no polls, quiet window preserved.
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator, dispatchCompletion } = createCoordinator(inspectProcess)

    coordinator.observeHookStatus({ state: 'working', prompt: '', agentType: 'codex' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(inspectProcess).not.toHaveBeenCalled()

    coordinator.observeHookStatus({ state: 'done', prompt: '', agentType: 'codex' })
    expect(dispatchCompletion).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('still detects an unannounced agent exit promptly after escalating from the relaxed tier', async () => {
    let foregroundProcess: string | null = null
    const inspectProcess = vi.fn(async () => processResult(foregroundProcess))
    const { coordinator, dispatchCompletion } = createCoordinator(inspectProcess)

    coordinator.startProcessTracking()
    // Idle at the relaxed cadence, then an agent starts and prints output.
    await vi.advanceTimersByTimeAsync(20_000)
    foregroundProcess = 'codex'
    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(inspectProcess).toHaveBeenCalled()

    // With no title/hook end signal, sustained process absence must still confirm completion at active cadence.
    foregroundProcess = null
    const callsAtExit = inspectProcess.mock.calls.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(inspectProcess.mock.calls.length).toBeGreaterThan(callsAtExit)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })
})
