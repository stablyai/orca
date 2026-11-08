import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  HOOK_DONE_QUIET_MS,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

describe('agent completion coordinator stamped turn boundary', () => {
  useAgentCompletionCoordinatorLifecycle()

  it.each(['before', 'after'] as const)(
    'does not let a sibling OSC all-clear arriving %s the host stamp duplicate it',
    (allClearOrder) => {
      const dispatchCompletion = vi.fn()
      const localCoordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-1:leaf-1',
        getPtyId: () => 'pty-1',
        inspectProcess: vi.fn(),
        dispatchCompletion,
        isLive: () => true
      })
      const hostCoordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-1:leaf-1',
        getPtyId: () => 'pty-1',
        inspectProcess: vi.fn(),
        dispatchCompletion,
        isLive: () => true
      })

      localCoordinator.observeHookStatus({
        state: 'working',
        prompt: 'review the PR',
        agentType: 'claude',
        stateStartedAt: 5_000
      })
      hostCoordinator.observeHookStatus({
        state: 'working',
        prompt: 'review the PR',
        agentType: 'claude',
        stateStartedAt: 2_000
      })
      if (allClearOrder === 'before') {
        localCoordinator.observeHookStatus({
          state: 'done',
          prompt: 'review the PR',
          agentType: 'claude',
          stateStartedAt: 5_500
        })
      }
      hostCoordinator.observeHookStatus({
        state: 'working',
        prompt: 'review the PR',
        agentType: 'claude',
        lastAssistantMessage: 'Review complete.',
        stateStartedAt: 2_000,
        turnCompletedAt: 2_500
      })
      expect(dispatchCompletion).toHaveBeenCalledTimes(1)

      if (allClearOrder === 'after') {
        localCoordinator.observeHookStatus({
          state: 'done',
          prompt: 'review the PR',
          agentType: 'claude',
          stateStartedAt: 5_500
        })
      }
      vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    }
  )

  it('does not consume a fresh turn as the all-clear for an earlier stamped tail', () => {
    const dispatchCompletion = vi.fn()
    const localCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    const hostCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    localCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'first turn',
      agentType: 'claude',
      stateStartedAt: 5_000
    })
    hostCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'first turn',
      agentType: 'claude',
      stateStartedAt: 2_000
    })
    hostCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'first turn',
      agentType: 'claude',
      stateStartedAt: 2_000,
      turnCompletedAt: 2_500
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    localCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'second turn',
      agentType: 'claude',
      stateStartedAt: 6_000
    })
    localCoordinator.observeHookStatus({
      state: 'done',
      prompt: 'second turn',
      agentType: 'claude',
      stateStartedAt: 6_500
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })
})
