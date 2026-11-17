import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  createDeferred,
  flushAsyncTicks,
  HOOK_DONE_QUIET_MS,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { TerminalProcessInspection as RuntimeTerminalProcessInspection } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

describe('agent completion coordinator', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('suppresses process-exit in another coordinator after a hook completion notified', async () => {
    const paneKey = 'tab-1:leaf-1'
    const dispatchCompletion = vi.fn()
    const hookCoordinator = createAgentCompletionCoordinator({
      paneKey,
      getPtyId: () => 'pty-1',
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
      inspectProcess: vi.fn(async () => result),
      dispatchCompletion,
      isLive: () => true
    })

    processCoordinator.startProcessTracking()
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()

    result = processResult('zsh', false)
    await vi.advanceTimersByTimeAsync(3_000)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    result = processResult('codex')
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()
    result = processResult('zsh', false)
    await vi.advanceTimersByTimeAsync(3_000)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })

  it('ignores process inspections that resolve after completion state reset', async () => {
    const inspection = createDeferred<RuntimeTerminalProcessInspection>()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
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

    expect(dispatchCompletion).toHaveBeenCalledWith('experimental-agent-observability')
  })
})
