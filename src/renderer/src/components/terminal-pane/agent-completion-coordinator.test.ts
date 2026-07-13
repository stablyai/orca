/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from './agent-completion-coordinator'
import { resetAgentProcessInspectionQueueForTests } from './agent-process-inspection-queue'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

async function flushAsyncTicks(count = 4): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

function processResult(
  foregroundProcess: string | null,
  hasChildProcesses = foregroundProcess !== null
): RuntimeTerminalProcessInspection {
  return { foregroundProcess, hasChildProcesses }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve
  })
  return { promise, resolve: resolveDeferred }
}

function createRejectableDeferred<T>(): {
  promise: Promise<T>
  reject: (reason?: unknown) => void
} {
  let rejectDeferred!: (reason?: unknown) => void
  const promise = new Promise<T>((_resolve, reject) => {
    rejectDeferred = reject
  })
  return { promise, reject: rejectDeferred }
}

const HOOK_DONE_QUIET_MS = 1_500

describe('agent completion coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    resetAgentProcessInspectionQueueForTests()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not schedule cadence process inspections for hidden idle panes', () => {
    const inspectProcess = vi.fn(async () => processResult(null))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => false
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(10_000)

    expect(inspectProcess).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the process-exit backstop after hidden panes gain agent evidence', async () => {
    const inspectProcess = vi.fn(async () => processResult('codex'))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => false
    })

    coordinator.startProcessTracking()
    expect(vi.getTimerCount()).toBe(0)

    coordinator.observeTitle('Codex working')
    // Why: hidden panes poll the backstop at the throttled 3s cadence, not the
    // 2s idle / 750ms active cadence reserved for visible panes.
    vi.advanceTimersByTime(3_000)
    await flushAsyncTicks()

    expect(inspectProcess).toHaveBeenCalledTimes(1)
  })

  // Why: regression guard for the hidden-pane throttle (follow-up to #6288 /
  // PR #6667). A hidden pane with a live agent kept polling the OS process
  // table at full 750ms cadence purely as a backstop, wasting idle CPU on
  // shared SSH relays. It now polls at the 3s hidden cadence. Pre-fix this
  // counted ~78 inspections over 60s; post-fix ~20. The assertion fails on the
  // pre-fix code (>25) and passes after, so it locks in the reduction.
  it('throttles a hidden agent pane to the 3s backstop cadence over a 60s window', async () => {
    const inspectProcess = vi.fn(async () => processResult('codex'))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => false
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(60_000)

    const hiddenCalls = inspectProcess.mock.calls.length
    // ~60_000 / 3_000 = 20 (jitter pinned to 1.0 via the Math.random spy).
    expect(hiddenCalls).toBeGreaterThanOrEqual(15)
    expect(hiddenCalls).toBeLessThanOrEqual(25)
  })

  it('keeps a visible agent pane at full 750ms cadence over a 60s window', async () => {
    const inspectProcess = vi.fn(async () => processResult('codex'))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(60_000)

    // ~60_000 / 750 ≈ 78; the hidden throttle must not regress visible panes.
    expect(inspectProcess.mock.calls.length).toBeGreaterThanOrEqual(70)
  })

  it('re-arms full cadence immediately when a throttled hidden pane becomes visible', async () => {
    let visible = false
    const inspectProcess = vi.fn(async () => processResult('codex'))
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => visible
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    // First hidden poll runs and arms the next 3s backstop timer.
    await vi.advanceTimersByTimeAsync(3_000)
    const callsBeforeFlip = inspectProcess.mock.calls.length
    expect(callsBeforeFlip).toBeGreaterThanOrEqual(1)

    // 600ms into the 3s hidden interval: no new inspection yet.
    await vi.advanceTimersByTimeAsync(600)
    expect(inspectProcess.mock.calls.length).toBe(callsBeforeFlip)

    // Becoming visible (lifecycle calls startProcessTracking) must drop the slow
    // pending timer and re-arm at full cadence rather than wait out the ~2.4s left.
    visible = true
    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(900)

    expect(inspectProcess.mock.calls.length).toBeGreaterThan(callsBeforeFlip)
  })

  it('still detects an unannounced process exit while hidden, at the slower cadence', async () => {
    let foregroundProcess: string | null = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      isLive: () => true,
      shouldPollProcessCadence: () => false
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(3_000)

    // Agent exits with no completion title/hook — only the poll can notice.
    foregroundProcess = null
    // First idle sample requires a repeat before announcing (no dispatch yet).
    await vi.advanceTimersByTimeAsync(3_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Second idle sample confirms the exit ~2 hidden polls (~6s) after it happened.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('clears process evidence after agent exit so later non-agent spinner titles do not notify', async () => {
    let foregroundProcess: string | null = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    coordinator.observeTitle('⠋ codex')
    coordinator.observeTitle('codex done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    foregroundProcess = 'zsh'
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    dispatchCompletion.mockClear()
    coordinator.observeTitle('⠋ experimental-agent-observability')
    coordinator.observeTitle('experimental-agent-observability')
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('does not dispatch process-exit while an agent terminal still has child processes', async () => {
    let result = processResult('codex')
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => result),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    result = processResult('zsh', true)
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()

    result = processResult('zsh', false)
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()

    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('does not mark an agent-to-agent process replacement as terminal idle', async () => {
    let foregroundProcess = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(2_000)

    foregroundProcess = 'claude'
    await vi.advanceTimersByTimeAsync(750)

    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false
    })
  })

  it('suppresses replacement completion before coordinator state mutation', async () => {
    let foregroundProcess = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      shouldSuppressProcessReplacementCompletion: () => true,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(2_000)

    foregroundProcess = 'claude'
    await vi.advanceTimersByTimeAsync(750)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.observeTitle('Claude done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('Claude done')
  })

  it('suppresses confirmed process exit when the owner vetoes the exited process', async () => {
    let foregroundProcess: string | null = 'codex'
    const dispatchCompletion = vi.fn()
    const shouldSuppressConfirmedProcessExitCompletion = vi.fn(() => true)
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      shouldSuppressConfirmedProcessExitCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    coordinator.observeTitle('Codex working')
    await vi.advanceTimersByTimeAsync(2_000)

    foregroundProcess = null
    await vi.advanceTimersByTimeAsync(1_500)

    expect(shouldSuppressConfirmedProcessExitCompletion).toHaveBeenCalledWith({
      agent: 'codex',
      processName: 'codex'
    })
    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('suppresses process-exit backstop after a title completion already notified the turn', async () => {
    let foregroundProcess: string | null = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    coordinator.observeTitle('⠋ codex')
    coordinator.observeTitle('codex done')
    foregroundProcess = null
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex done')
  })

  it('does not dispatch a cwd title after an explicit agent working title if the shell owns the pane', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult('zsh')),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/orca-e2e-repo')
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('does not validate a pending cwd title with an already in-flight inspection', async () => {
    const staleInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const freshInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const inspectProcess = vi
      .fn()
      .mockReturnValueOnce(staleInspection.promise)
      .mockReturnValueOnce(freshInspection.promise)
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/orca-e2e-repo')
    staleInspection.resolve(processResult('codex'))
    await flushAsyncTicks()

    expect(inspectProcess).toHaveBeenCalledTimes(2)
    expect(dispatchCompletion).not.toHaveBeenCalledWith('/tmp/orca-e2e-repo')

    freshInspection.resolve(processResult('zsh'))
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalledWith('/tmp/orca-e2e-repo')
  })

  it('does not validate a replaced pending title with an older pending-title inspection', async () => {
    const titleAInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const titleBInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const inspectProcess = vi
      .fn()
      .mockReturnValueOnce(titleAInspection.promise)
      .mockReturnValueOnce(titleBInspection.promise)
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/title-a')
    await flushAsyncTicks()

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/title-b')
    titleAInspection.resolve(processResult('codex'))
    await flushAsyncTicks()

    expect(inspectProcess).toHaveBeenCalledTimes(2)
    expect(dispatchCompletion).not.toHaveBeenCalledWith('/tmp/title-b')

    titleBInspection.resolve(processResult('zsh'))
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalledWith('/tmp/title-b')
  })

  it('does not drop a replaced pending title from an older non-agent inspection', async () => {
    const titleAInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const titleBInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const inspectProcess = vi
      .fn()
      .mockReturnValueOnce(titleAInspection.promise)
      .mockReturnValueOnce(titleBInspection.promise)
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/title-a')
    await flushAsyncTicks()

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/title-b')
    titleAInspection.resolve(processResult('zsh'))
    await flushAsyncTicks()

    expect(inspectProcess).toHaveBeenCalledTimes(2)
    expect(dispatchCompletion).not.toHaveBeenCalledWith('/tmp/title-b')

    titleBInspection.resolve(processResult('codex'))
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledWith('/tmp/title-b')
  })

  it('does not dispatch a pending cwd title when process inspection fails', async () => {
    const inspection = createRejectableDeferred<RuntimeTerminalProcessInspection>()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(() => inspection.promise),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/orca-e2e-repo')
    inspection.reject(new Error('inspection failed'))
    await flushAsyncTicks()

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('prefers a later explicit completion title over a pending cwd title', async () => {
    const inspection = createDeferred<RuntimeTerminalProcessInspection>()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(() => inspection.promise),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('/tmp/orca-e2e-repo')
    coordinator.observeTitle('Codex done')
    inspection.resolve(processResult('zsh'))
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('Codex done')
  })

  it('still dispatches a generic completion title after process inspection confirms an agent', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult('codex')),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('Codex working')
    coordinator.observeTitle('Fix flaky e2e tests')
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledWith('Fix flaky e2e tests')
  })

  it('suppresses same-turn title completion after a hook completion already notified', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: '',
      agentType: 'codex'
    })
    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType: 'codex'
    })
    coordinator.observeClassifiedTitleCompletion('codex done')
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        source: 'hook',
        quietedHookDone: true,
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'codex'
        })
      })
    )
  })

  it('ignores stale working title state after a hook completion already notified', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType: 'codex'
    })
    coordinator.observeTitle('⠋ codex')
    coordinator.observeTitle('codex done')

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex')
  })

  it('suppresses delayed title completion after process inspection changes sessions', async () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult('codex')),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType: 'codex'
    })
    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()
    coordinator.observeClassifiedTitleCompletion('codex done')

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex')
  })

  it('suppresses late process-exit backstop after process inspection follows hook completion', async () => {
    let foregroundProcess: string | null = 'codex'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType: 'codex'
    })
    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()
    foregroundProcess = null
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex')
  })

  it('suppresses process-exit in another coordinator after a hook completion notified', async () => {
    const paneKey = 'tab-1:leaf-1'
    const dispatchCompletion = vi.fn()
    const hookCoordinator = createAgentCompletionCoordinator({
      paneKey,
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(null)),
      dispatchCompletion,
      isLive: () => true
    })

    hookCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'say OK only',
      agentType: 'codex'
    })
    hookCoordinator.observeHookStatus({
      state: 'done',
      prompt: 'say OK only',
      agentType: 'codex',
      stateStartedAt: 1_700_000_000_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    let result = processResult('codex')
    const processCoordinator = createAgentCompletionCoordinator({
      paneKey,
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => result),
      dispatchCompletion,
      isLive: () => true
    })

    processCoordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    result = processResult('zsh', false)
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('keeps duplicate done-only hooks inside replay guard suppressed after process inspection', async () => {
    const inspection = createDeferred<RuntimeTerminalProcessInspection>()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(() => inspection.promise),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()
    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType: 'codex'
    })
    inspection.resolve(processResult('codex'))
    await flushAsyncTicks()
    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType: 'codex'
    })

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('can require a fresh working signal after completion state reset', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType: 'codex'
    })
    coordinator.resetCompletionState({ requireFreshWorking: true })
    coordinator.observeClassifiedTitleCompletion('codex done')
    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType: 'codex'
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({
      state: 'working',
      prompt: '',
      agentType: 'codex'
    })
    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType: 'codex'
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })

  it('ignores process inspections that resolve after completion state reset', async () => {
    const inspection = createDeferred<RuntimeTerminalProcessInspection>()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(() => inspection.promise),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    coordinator.resetCompletionState({ requireFreshWorking: true })
    inspection.resolve(processResult('codex'))
    await flushAsyncTicks()
    coordinator.observeTitle('⠋ experimental-agent-observability')
    coordinator.observeTitle('experimental-agent-observability')

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('starts a fresh pending-title inspection after stale inspection resolves', async () => {
    const firstInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const secondInspection = createDeferred<RuntimeTerminalProcessInspection>()
    const inspectProcess = vi
      .fn()
      .mockReturnValueOnce(firstInspection.promise)
      .mockReturnValueOnce(secondInspection.promise)
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()
    coordinator.resetCompletionState({ requireFreshWorking: true })
    coordinator.observeTitle('⠋ experimental-agent-observability')
    coordinator.observeTitle('experimental-agent-observability')
    firstInspection.resolve(processResult('codex'))
    await flushAsyncTicks()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()
    secondInspection.resolve(processResult('codex'))
    await flushAsyncTicks()

    expect(inspectProcess).toHaveBeenCalledTimes(2)
    expect(dispatchCompletion).toHaveBeenCalledWith('experimental-agent-observability')
  })

  it('allows later done-only hook completions from the same long-lived process', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'first task',
      agentType: 'codex',
      stateStartedAt: 1_700_000_000_000
    })
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'first task',
      agentType: 'codex',
      stateStartedAt: 1_700_000_000_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1_000)
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'second task',
      agentType: 'codex',
      stateStartedAt: 1_700_000_010_000
    })

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })

  it('suppresses delayed replays of the same hook completion snapshot', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    const completion = {
      state: 'done' as const,
      prompt: 'same task',
      agentType: 'codex' as const,
      stateStartedAt: 1_700_000_000_000
    }
    coordinator.observeHookStatus(completion)
    vi.advanceTimersByTime(5_000)
    coordinator.observeHookStatus(completion)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('suppresses the same hook completion replay after fresh work starts', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    const completedTurn = {
      state: 'done' as const,
      prompt: 'same task',
      agentType: 'codex' as const,
      stateStartedAt: 1_700_000_000_000
    }
    coordinator.observeHookStatus(completedTurn)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'next task',
      agentType: 'codex',
      stateStartedAt: 1_700_000_010_000
    })
    vi.advanceTimersByTime(5_000)
    coordinator.observeHookStatus(completedTurn)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'next task',
      agentType: 'codex',
      stateStartedAt: 1_700_000_020_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })

  it('suppresses same-agent title replay after hook-backed fresh work starts', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'same task',
      agentType: 'codex',
      stateStartedAt: 1_700_000_000_000
    })
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'same task',
      agentType: 'codex',
      stateStartedAt: 1_700_000_010_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'next task',
      agentType: 'codex',
      stateStartedAt: 1_700_000_020_000
    })
    coordinator.observeClassifiedTitleCompletion('Codex done')

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'next task',
      agentType: 'codex',
      stateStartedAt: 1_700_000_030_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })

  it('suppresses stale title completion replay after a pane remount until fresh work appears', () => {
    const dispatchCompletion = vi.fn()
    const firstCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    firstCoordinator.observeTitleWorking()
    firstCoordinator.observeClassifiedTitleCompletion('Codex done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    firstCoordinator.dispose()

    const remountedCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    remountedCoordinator.observeClassifiedTitleCompletion('Codex done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    remountedCoordinator.observeTitleWorking()
    remountedCoordinator.observeClassifiedTitleCompletion('Codex done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })

  it('suppresses stale title completion replay after a hook completion remount', () => {
    const dispatchCompletion = vi.fn()
    const firstCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    firstCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'ship it',
      agentType: 'codex',
      stateStartedAt: 1_700_000_000_000
    })
    firstCoordinator.observeHookStatus({
      state: 'done',
      prompt: 'ship it',
      agentType: 'codex',
      stateStartedAt: 1_700_000_010_000
    })
    vi.advanceTimersByTime(5_000)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    firstCoordinator.dispose()

    const remountedCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    remountedCoordinator.observeClassifiedTitleCompletion('Codex done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    remountedCoordinator.observeTitleWorking()
    remountedCoordinator.observeClassifiedTitleCompletion('Codex done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })

  it('cancels a hook completion when the same turn resumes work before the quiet window', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS - 1)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        source: 'hook',
        quietedHookDone: true,
        agentStatus: expect.objectContaining({
          state: 'done',
          prompt: 'run the goal',
          agentType: 'codex'
        })
      })
    )
  })

  it('cancels a hook completion when title tracking observes resumed work before quiet', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the goal',
      agentType: 'codex'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)

    coordinator.observeTitleWorking()
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it.each([
    'claude',
    'codex',
    'gemini',
    'opencode',
    'cursor',
    'droid',
    'grok',
    'devin',
    'copilot',
    'hermes'
  ])('recognizes %s hook agent ids even when the binary name differs', (agentType) => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'done',
      prompt: '',
      agentType
    })

    expect(dispatchCompletion).toHaveBeenCalledWith(agentType)
  })

  it.each(['pi', 'omp'])(
    'defers a %s milestone done without prior working through the quiet window',
    (agentType) => {
      const dispatchCompletion = vi.fn()
      const coordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-1:leaf-1',
        getPtyId: () => 'pty-1',
        getSettings: () => null,
        inspectProcess: vi.fn(),
        dispatchCompletion,
        isLive: () => true
      })

      // Pi/OMP emit agent_end ('done') between milestones with no prior 'working';
      // the done must wait out the quiet window instead of firing immediately.
      coordinator.observeHookStatus({
        state: 'done',
        prompt: 'run the mission',
        agentType
      })
      expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)
      vi.advanceTimersByTime(HOOK_DONE_QUIET_MS - 1)
      expect(dispatchCompletion).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
      expect(dispatchCompletion).toHaveBeenCalledWith(
        agentType,
        expect.objectContaining({ source: 'hook', quietedHookDone: true })
      )
    }
  )

  it('suppresses a Pi milestone done when work resumes before the quiet window', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the mission',
      agentType: 'pi'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)

    // Pi resumes (a tool_call mapped to 'working') before the window elapses,
    // which must cancel the premature "finished".
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'run the mission',
      agentType: 'pi'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('still dispatches a Codex done-without-prior-working immediately', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    // Codex only emits 'done' at turn end, so it must keep its immediate dispatch.
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'fix the bug',
      agentType: 'codex'
    })

    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('still fires a pending Pi done when process inspection sees the agent exit first', async () => {
    // Why: a process-exit probe landing inside the quiet window must not tear
    // down agent evidence, or the pending hook 'done' would be silently dropped.
    let foregroundProcess: string | null = 'pi'
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => processResult(foregroundProcess)),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'run the mission',
      agentType: 'pi'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)

    // The agent process disappears mid-window; the cadence poll must not drop
    // the pending completion.
    foregroundProcess = null
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()
    expect(dispatchCompletion).not.toHaveBeenCalled()

    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'pi',
      expect.objectContaining({ source: 'hook' })
    )
  })

  it('notifies once after a Cursor tool-heavy turn, not on each shell hook', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    const turn = {
      prompt: 'fix the bug',
      agentType: 'cursor' as const
    }

    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'working',
      ...turn,
      toolName: 'Shell',
      toolInput: 'pnpm test'
    })
    coordinator.observeHookStatus({
      state: 'working',
      ...turn,
      toolName: 'Read',
      toolInput: '/repo/src/app.ts'
    })
    coordinator.observeHookStatus({
      state: 'working',
      ...turn,
      toolName: 'Shell',
      toolInput: 'git status'
    })

    expect(dispatchCompletion).not.toHaveBeenCalled()

    coordinator.observeHookStatus({ state: 'done', ...turn, lastAssistantMessage: 'Fixed.' })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch completion when waiting states arrive mid-turn', () => {
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    const turn = {
      prompt: 'fix the bug',
      agentType: 'cursor' as const
    }

    // 'waiting' (e.g. a PermissionRequest) is mid-turn, not a completion.
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'Shell',
      toolInput: 'pnpm test'
    })
    coordinator.observeHookStatus({
      state: 'working',
      ...turn,
      toolName: 'Read',
      toolInput: '/repo/src/app.ts'
    })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'Shell',
      toolInput: 'git status'
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(dispatchAttention).toHaveBeenCalledTimes(2)
    expect(dispatchAttention).toHaveBeenLastCalledWith(
      'cursor',
      expect.objectContaining({
        source: 'hook',
        agentStatus: expect.objectContaining({
          state: 'waiting',
          agentType: 'cursor',
          toolInput: 'git status'
        })
      })
    )
  })

  it('suppresses the attention dispatch when shouldSuppressHookCompletion matches', () => {
    // Why: guards the merge seam where the suppressor must short-circuit before
    // the attention path, so auto-approved Codex pauses never notify.
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true,
      shouldSuppressHookCompletion: (payload) =>
        payload.state === 'waiting' || payload.state === 'blocked'
    })

    const turn = {
      prompt: 'implement notifications',
      agentType: 'codex' as const
    }

    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'git status'
    })
    coordinator.observeHookStatus({
      state: 'blocked',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'rm file'
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchAttention).not.toHaveBeenCalled()
    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('does not dispatch completion when a blocked state arrives mid-turn', () => {
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    const turn = {
      prompt: 'fix the bug',
      agentType: 'copilot' as const
    }

    // 'blocked' (e.g. a Copilot elicitation dialog) is mid-turn, not a completion.
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'blocked',
      ...turn,
      toolName: 'Shell',
      toolInput: 'npm install'
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(dispatchAttention).toHaveBeenCalledWith(
      'copilot',
      expect.objectContaining({
        source: 'hook',
        agentStatus: expect.objectContaining({
          state: 'blocked',
          agentType: 'copilot',
          toolInput: 'npm install'
        })
      })
    )
  })

  it('cancels a pending done timer when a waiting state arrives before the quiet window', () => {
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    const turn = {
      prompt: 'fix the bug',
      agentType: 'cursor' as const
    }

    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'done', ...turn, lastAssistantMessage: 'Done.' })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)

    // A permission/elicitation pause arrives before the 1.5s quiet window
    // expires; it must cancel the pending 'done' so no completion fires.
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'Shell',
      toolInput: 'pnpm test'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(dispatchAttention).toHaveBeenCalledWith(
      'cursor',
      expect.objectContaining({
        source: 'hook',
        agentStatus: expect.objectContaining({
          state: 'waiting',
          agentType: 'cursor',
          toolInput: 'pnpm test'
        })
      })
    )
  })

  it('cancels a pending done timer when a suppressed attention state arrives before the quiet window', () => {
    // Why: a suppressed Codex auto-approval pause must still cancel a provisional
    // 'done' so the quiet-window timer never fires a false completion notification.
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true,
      shouldSuppressHookCompletion: (payload) =>
        payload.state === 'waiting' || payload.state === 'blocked'
    })

    const turn = {
      prompt: 'implement notifications',
      agentType: 'codex' as const
    }

    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'done', ...turn, lastAssistantMessage: 'Done.' })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(true)

    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'git status'
    })
    expect(coordinator.hasPendingHookDoneCompletion()).toBe(false)
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(dispatchAttention).not.toHaveBeenCalled()
  })

  it('still dispatches completion on done after an intervening waiting state in the same turn', () => {
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    const turn = {
      prompt: 'fix the bug',
      agentType: 'cursor' as const
    }

    // Realistic flow: the agent pauses for a permission prompt mid-turn, resumes,
    // then genuinely finishes. The intervening attention state must surface as
    // attention only and must not suppress the final completion. This fails if
    // 'waiting' is treated as a completion state (issue #5698).
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'Shell',
      toolInput: 'pnpm test'
    })
    coordinator.observeHookStatus({ state: 'working', ...turn })
    coordinator.observeHookStatus({ state: 'done', ...turn, lastAssistantMessage: 'Done.' })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchAttention).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('keeps a generic title completion pending long enough for the first remote inspection', async () => {
    const inspection = createDeferred<RuntimeTerminalProcessInspection>()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'remote:terminal-1',
      getSettings: () => ({ activeRuntimeEnvironmentId: 'env-1' }),
      inspectProcess: vi.fn(() => inspection.promise),
      dispatchCompletion,
      isLive: () => true
    })

    coordinator.observeTitle('⠋ experimental-agent-observability')
    coordinator.observeTitle('experimental-agent-observability')
    vi.advanceTimersByTime(10_500)
    inspection.resolve(processResult('codex'))
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledWith('experimental-agent-observability')
  })

  it('does not mutate completion state when hook completion is suppressed', () => {
    const dispatchCompletion = vi.fn()
    const shouldSuppressHookCompletion = vi.fn(
      (payload: { state: string }) => payload.state === 'waiting' || payload.state === 'blocked'
    )
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true,
      shouldSuppressHookCompletion
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'implement notifications',
      agentType: 'codex'
    })
    coordinator.observeHookStatus({
      state: 'waiting',
      prompt: 'implement notifications',
      agentType: 'codex',
      toolName: 'exec_command',
      toolInput: 'git status'
    })

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(shouldSuppressHookCompletion).toHaveBeenCalled()

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'implement notifications',
      agentType: 'codex',
      stateStartedAt: 1_700_000_010_000,
      lastAssistantMessage: 'Done.'
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        source: 'hook',
        quietedHookDone: true,
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'codex'
        })
      })
    )
  })
})
