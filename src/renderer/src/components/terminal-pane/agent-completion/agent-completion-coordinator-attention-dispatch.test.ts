import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  flushAsyncTicks,
  HOOK_DONE_QUIET_MS,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

describe('agent completion coordinator', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('cancels a pending done timer when a waiting state arrives before the quiet window', () => {
    const dispatchCompletion = vi.fn()
    const dispatchAttention = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
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

    // Attention arriving within the quiet window must cancel provisional completion.
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

  it('settles foreground misses after Codex pauses before reporting a sustained exit', async () => {
    // Attention hooks prove liveness even when process inspection misses a foreground handoff.
    let foreground: string | null = 'codex'
    const dispatchAttention = vi.fn()
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(async () => processResult(foreground)),
      dispatchCompletion,
      dispatchAttention,
      isLive: () => true
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks()

    foreground = null
    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsyncTicks()
    expect(dispatchCompletion).not.toHaveBeenCalled()

    const turn = { prompt: 'apply patch', agentType: 'codex' as const }
    coordinator.observeHookStatus({
      state: 'waiting',
      ...turn,
      toolName: 'exec_command',
      toolInput: 'rm -rf build'
    })
    expect(dispatchAttention).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks()

    expect(dispatchAttention).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    await flushAsyncTicks()

    expect(dispatchCompletion).toHaveBeenCalledExactlyOnceWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })
})
