import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  HOOK_DONE_QUIET_MS,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

describe('agent completion coordinator stamped turn boundary', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('ignores a turn end time that cannot name a turn', () => {
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
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000
    })
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: Number.NaN
    })

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('does not announce a gated Stop for a turn it never saw start', () => {
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
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('does not announce the all-clear after first seeing a stamped turn tail', () => {
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
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    firstCoordinator.dispose()

    const remounted = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    remounted.observeHookStatus({
      state: 'done',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_055_000,
      turnCompletedAt: 1_700_000_005_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('announces a gated Stop immediately and treats the later all-clear as the same turn', () => {
    const dispatchCompletion = vi.fn()
    const dispatchHookLifecycle = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      dispatchHookLifecycle,
      isLive: () => true
    })

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000
    })
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      lastAssistantMessage: 'Which cells need hand-verification?',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        source: 'hook',
        quietedHookDone: false,
        agentStatus: expect.objectContaining({
          state: 'done',
          lastAssistantMessage: 'Which cells need hand-verification?',
          stateStartedAt: 1_700_000_005_000,
          turnCompletedAt: 1_700_000_005_000
        })
      })
    )
    expect(dispatchHookLifecycle).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'working', turnCompletedAt: 1_700_000_005_000 })
    )

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'review the PR',
      agentType: 'claude',
      lastAssistantMessage: 'Which cells need hand-verification?',
      stateStartedAt: 1_700_000_055_000,
      turnCompletedAt: 1_700_000_005_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchHookLifecycle).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'done', turnCompletedAt: 1_700_000_005_000 })
    )
  })

  it.each(['before', 'after'] as const)(
    'does not let a sibling OSC all-clear arriving %s the host stamp duplicate it',
    (allClearOrder) => {
      const dispatchCompletion = vi.fn()
      const localCoordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-1:leaf-1',
        getPtyId: () => 'pty-1',
        getSettings: () => null,
        inspectProcess: vi.fn(),
        dispatchCompletion,
        isLive: () => true
      })
      const hostCoordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-1:leaf-1',
        getPtyId: () => 'pty-1',
        getSettings: () => null,
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
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    const hostCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
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

  it('keeps sibling tail suppression after the host stamped all-clear arrives first', () => {
    const dispatchCompletion = vi.fn()
    const localCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    const hostCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
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
    hostCoordinator.observeHookStatus({
      state: 'done',
      prompt: 'first turn',
      agentType: 'claude',
      stateStartedAt: 3_000,
      turnCompletedAt: 2_500
    })
    localCoordinator.observeHookStatus({
      state: 'done',
      prompt: 'first turn',
      agentType: 'claude',
      stateStartedAt: 5_500
    })
    localCoordinator.observeHookStatus({
      state: 'done',
      prompt: 'first turn',
      agentType: 'claude',
      stateStartedAt: 5_500
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('releases a stamped tail when its host reports a new same-state turn', () => {
    const dispatchCompletion = vi.fn()
    const localCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    const hostCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
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

    hostCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'second turn',
      agentType: 'claude',
      stateStartedAt: 2_000
    })
    localCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'second turn',
      agentType: 'claude',
      stateStartedAt: 5_000
    })
    localCoordinator.observeHookStatus({
      state: 'done',
      prompt: 'second turn',
      agentType: 'claude',
      stateStartedAt: 5_500
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })
})
