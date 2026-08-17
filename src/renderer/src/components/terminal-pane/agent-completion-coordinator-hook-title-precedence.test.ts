import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  createDeferred,
  flushAsyncTicks,
  HOOK_DONE_QUIET_MS,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

describe('agent completion coordinator', () => {
  useAgentCompletionCoordinatorLifecycle()

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

    result = processResult('codex')
    vi.advanceTimersByTime(2_000)
    await flushAsyncTicks()
    result = processResult('zsh', false)
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()
    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
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
})
