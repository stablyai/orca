/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { resetAgentProcessInspectionQueueForTests } from './agent-process-inspection-queue'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

async function flushAsyncTicks(count = 4): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

function processResult(foregroundProcess: string | null): RuntimeTerminalProcessInspection {
  return { foregroundProcess, hasChildProcesses: foregroundProcess !== null }
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
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    expect(inspectProcess).toHaveBeenCalledTimes(1)
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
      agentType: 'codex'
    })
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'first task',
      agentType: 'codex'
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1_000)
    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'second task',
      agentType: 'codex'
    })

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
    'pi',
    'omp',
    'droid',
    'grok',
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
})
