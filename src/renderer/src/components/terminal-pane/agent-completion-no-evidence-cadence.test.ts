// Regression guard: bound the volume of cadence process inspections a visible,
// idle terminal with NO agent evidence drives on hosts where each inspection is
// a whole-process-table scan (local Windows forks powershell.exe/CIM — the
// scan-cost analogue of #6288). Pre-fix a single visible idle shell inspected
// every 2s forever (~30 scans/min); with the no-evidence tier it inspects every
// 15s, and pane activity (output/title/hook) or agent evidence re-arms the hot
// cadence so agent-start detection stays event-driven and agent-finish
// detection is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from './agent-completion-coordinator'
import { resetAgentProcessInspectionQueueForTests } from './agent-process-inspection-queue'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
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
    getSettings: () => null,
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
    // Math.random = 0.5 makes the ±10% jitter factor exactly 1.0, so tick
    // counts below are exact.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    resetAgentProcessInspectionQueueForTests()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('bounds a visible idle pane with no agent evidence to the 15s cadence on a costly host', async () => {
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess)

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)

    // 60s / 15s = 4. Pre-fix (2s idle cadence) this was 30.
    expect(inspectProcess).toHaveBeenCalledTimes(4)
  })

  it('keeps the full 2s idle cadence on hosts where inspection is cheap', async () => {
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess, {
      isProcessInspectionCostly: () => false
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)

    // 60s / 2s = 30: POSIX/SSH/remote panes must not be relaxed.
    expect(inspectProcess).toHaveBeenCalledTimes(30)
  })

  it('keeps the full cadence when the coordinator has no cost source', async () => {
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess, {
      isProcessInspectionCostly: undefined
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(inspectProcess).toHaveBeenCalledTimes(30)
  })

  it('escalates to the hot cadence when PTY output appears mid-interval', async () => {
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess)

    coordinator.startProcessTracking()
    // 14s into the 15s no-evidence interval: nothing has run yet.
    await vi.advanceTimersByTimeAsync(14_000)
    expect(inspectProcess).not.toHaveBeenCalled()

    // Output (e.g. the user launched an agent) must re-arm the idle cadence
    // instead of waiting out the remaining ~1s + another 15s round.
    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(inspectProcess).toHaveBeenCalledTimes(1)
  })

  it('escalates to the hot cadence when a title change appears mid-interval', async () => {
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess)

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(14_000)
    expect(inspectProcess).not.toHaveBeenCalled()

    // A generic (non-agent) title change still signals shell activity.
    coordinator.observeTitle('~/projects/app')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(inspectProcess).toHaveBeenCalledTimes(1)
  })

  it('decays back to the 15s cadence when activity stops without agent evidence', async () => {
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess)

    coordinator.startProcessTracking()
    coordinator.observeOutputActivity()
    // Hot window: 2s cadence while within 10s of the last activity.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(inspectProcess).toHaveBeenCalledTimes(5)

    // No further activity and no evidence: the next 45s allow only the polls
    // armed at the relaxed cadence (t=25s, 40s, 55s).
    await vi.advanceTimersByTimeAsync(45_000)
    expect(inspectProcess).toHaveBeenCalledTimes(8)
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

  it('does not accelerate the relaxed cadence when inspections keep erroring', async () => {
    const inspectProcess = vi.fn(async () => {
      throw new Error('scan failed')
    })
    const { coordinator } = createCoordinator(inspectProcess)

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)

    // The error backoff ceiling (10s) must not undercut the 15s tier: erroring
    // scans would otherwise poll MORE often than healthy ones (15s → 10s).
    expect(inspectProcess).toHaveBeenCalledTimes(4)
  })

  it('keeps a recognized agent on the full active cadence on a costly host', async () => {
    const inspectProcess = vi.fn(async () => processResult('codex'))
    const { coordinator } = createCoordinator(inspectProcess)

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(60_000)

    // ~60s / 750ms ≈ 78: agent-finish detection must not be relaxed.
    expect(inspectProcess.mock.calls.length).toBeGreaterThanOrEqual(70)
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

    // Agent exits with no completion title/hook — only the poll can notice.
    // Two consecutive idle samples at the 750ms active cadence confirm it.
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
