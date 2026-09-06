// Regression guard: bound the volume of cadence process inspections a visible,
// idle terminal with NO agent evidence drives on hosts where each inspection is
// expensive — local Windows forks a powershell.exe/CIM whole-process-table scan
// (the scan-cost analogue of #6288), and a remote/SSH pane pays a host round
// trip plus a host-side foreground scan. Pre-fix a single visible idle shell
// inspected every 2s forever (~30 scans/min); with the no-evidence tier it
// inspects every 15s, and pane activity (output/title/hook) or agent evidence
// re-arms the hot cadence so agent-start detection stays event-driven and
// agent-finish detection is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from './agent-completion-coordinator'
import { resetAgentProcessInspectionQueueForTests } from './agent-process-inspection-queue'
import { isAgentProcessInspectionCostly } from './agent-process-inspection-cost'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

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

  it('bounds a visible idle remote pane through the shipped cost predicate', async () => {
    // Why: a remote inspection is an RPC round trip to the execution host plus a
    // host-side foreground scan — the costliest inspection shape here — yet it
    // was excluded from the no-evidence tier on every client platform.
    const sshPtyId = toAppSshPtyId('target-1', 'pty-1')
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess, {
      getPtyId: () => sshPtyId,
      isProcessInspectionCostly: () => isAgentProcessInspectionCostly(MAC_UA, sshPtyId)
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)

    // 60s / 15s = 4 host round trips. Pre-fix (2s idle cadence) this was 30.
    expect(inspectProcess).toHaveBeenCalledTimes(4)
  })

  it('re-arms the remote pane to the 2s cadence on the first byte of PTY output', async () => {
    // Why: agent-start detection on a remote pane must stay event-driven, not
    // wait out the relaxed interval.
    const runtimePtyId = toRemoteRuntimePtyId('term_1', 'env-a')
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess, {
      getPtyId: () => runtimePtyId,
      isProcessInspectionCostly: () => isAgentProcessInspectionCostly(MAC_UA, runtimePtyId)
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(14_000)
    expect(inspectProcess).not.toHaveBeenCalled()

    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(inspectProcess).toHaveBeenCalledTimes(1)
  })

  it('keeps the full 2s idle cadence on hosts where inspection is cheap', async () => {
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess, {
      isProcessInspectionCostly: () => false
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)

    // 60s / 2s = 30: local POSIX panes (cheap `ps`) must not be relaxed.
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

  it('costs zero idle inspections when the host publishes foreground evidence', async () => {
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess, {
      shouldPollNoEvidenceProcessCadence: () => false
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(inspectProcess).not.toHaveBeenCalled()
  })

  it('starts a bounded hot cadence after output on an evidence-publishing host', async () => {
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess, {
      shouldPollNoEvidenceProcessCadence: () => false
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(inspectProcess).not.toHaveBeenCalled()

    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(12_000)

    // Output arms 2s polls only for the 10s activity window; silence then
    // disarms the host reads again instead of falling back to a slow timer.
    expect(inspectProcess).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(inspectProcess).toHaveBeenCalledTimes(4)
  })

  it('does not re-arm no-evidence scans for output from hidden panes', async () => {
    const inspectProcess = vi.fn(async () => processResult(null, false))
    const { coordinator } = createCoordinator(inspectProcess, {
      shouldPollProcessCadence: () => false,
      shouldPollNoEvidenceProcessCadence: () => false
    })

    coordinator.startProcessTracking()
    coordinator.observeOutputActivity()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(inspectProcess).not.toHaveBeenCalled()
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

describe('isAgentProcessInspectionCostly', () => {
  it('treats remote-execution-host ptys as costly on every client platform', () => {
    for (const userAgent of [MAC_UA, WINDOWS_UA]) {
      expect(isAgentProcessInspectionCostly(userAgent, toAppSshPtyId('target-1', 'pty-1'))).toBe(
        true
      )
      expect(
        isAgentProcessInspectionCostly(userAgent, toRemoteRuntimePtyId('term_1', 'env-a'))
      ).toBe(true)
      expect(isAgentProcessInspectionCostly(userAgent, toRemoteRuntimePtyId('term_1'))).toBe(true)
    }
  })

  it('leaves the local branch unchanged: Windows costly, POSIX cheap', () => {
    expect(isAgentProcessInspectionCostly(WINDOWS_UA, 'worktree-1|pane-1')).toBe(true)
    expect(isAgentProcessInspectionCostly(WINDOWS_UA, null)).toBe(false)
    expect(isAgentProcessInspectionCostly(MAC_UA, 'worktree-1|pane-1')).toBe(false)
    expect(isAgentProcessInspectionCostly(MAC_UA, null)).toBe(false)
  })

  // Why: a bare "ssh:" id names no connection, so it is not evidence the
  // inspection crosses a link (see remote-execution-host-pty.test.ts).
  it('does not relax a POSIX pane for an ssh-prefixed id carrying no relay pty id', () => {
    expect(isAgentProcessInspectionCostly(MAC_UA, 'ssh:target-1')).toBe(false)
  })
})
