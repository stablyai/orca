import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  HOOK_DONE_QUIET_MS,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

describe('agent completion coordinator stamped turn replay', () => {
  useAgentCompletionCoordinatorLifecycle()

  it.each(['pty-first', 'host-first'] as const)(
    'releases stamped fallback dedupe when the next turn arrives %s',
    (workingOrder) => {
      const dispatchCompletion = vi.fn()
      const localCoordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-1:leaf-1',
        statusLane: 'pty',
        getPtyId: () => 'pty-1',
        getSettings: () => null,
        inspectProcess: vi.fn(),
        dispatchCompletion,
        isLive: () => true
      })
      const hostCoordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-1:leaf-1',
        statusLane: 'hook',
        getPtyId: () => 'pty-1',
        getSettings: () => null,
        inspectProcess: vi.fn(),
        dispatchCompletion,
        isLive: () => true
      })
      const observeHostNextTurn = () =>
        hostCoordinator.observeHookStatus({
          state: 'working',
          prompt: 'second turn',
          agentType: 'claude',
          stateStartedAt: 2_000
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

      if (workingOrder === 'pty-first') {
        localCoordinator.observeTitleWorking()
        observeHostNextTurn()
      } else {
        observeHostNextTurn()
        localCoordinator.observeTitleWorking()
      }
      localCoordinator.observeClassifiedTitleCompletion('Claude done')

      expect(dispatchCompletion).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['before', 'after'] as const)(
    'keeps sibling tail replay suppression when the pane remounts %s its all-clear',
    (remountOrder) => {
      const dispatchCompletion = vi.fn()
      const createLocalCoordinator = () =>
        createAgentCompletionCoordinator({
          paneKey: 'tab-1:leaf-1',
          statusLane: 'pty',
          getPtyId: () => 'pty-1',
          getSettings: () => null,
          inspectProcess: vi.fn(),
          dispatchCompletion,
          isLive: () => true
        })
      const localCoordinator = createLocalCoordinator()
      const hostCoordinator = createAgentCompletionCoordinator({
        paneKey: 'tab-1:leaf-1',
        statusLane: 'hook',
        getPtyId: () => 'pty-1',
        getSettings: () => null,
        inspectProcess: vi.fn(),
        dispatchCompletion,
        isLive: () => true
      })
      const localAllClear = {
        state: 'done' as const,
        prompt: 'first turn',
        agentType: 'claude' as const,
        stateStartedAt: 5_500
      }

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

      if (remountOrder === 'after') {
        localCoordinator.observeHookStatus(localAllClear)
      }
      localCoordinator.dispose()
      const remounted = createLocalCoordinator()
      remounted.observeHookStatus(localAllClear)
      vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

      expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    }
  )

  it('does not replay a stamped turn or its all-clear after a working title blip', () => {
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
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    coordinator.observeTitleWorking()

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_050_000,
      turnCompletedAt: 1_700_000_005_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchHookLifecycle).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'done', turnCompletedAt: 1_700_000_005_000 })
    )
  })

  it('does not double-fire after a live remount between the gated Stop and the all-clear', () => {
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
      stateStartedAt: 1_700_000_000_000
    })
    firstCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
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

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('keeps stamped replay suppression through a working title and live remount', () => {
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
      stateStartedAt: 1_700_000_000_000
    })
    firstCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    firstCoordinator.observeTitleWorking()
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

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })

  it('does not let a pane title duplicate another coordinator stamped completion', () => {
    const dispatchCompletion = vi.fn()
    const hookCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    const paneCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })

    hookCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000
    })
    hookCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2_000)
    paneCoordinator.observeTitleWorking()
    paneCoordinator.observeClassifiedTitleCompletion('Claude done')

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    hookCoordinator.observeHookStatus({
      state: 'done',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_055_000,
      turnCompletedAt: 1_700_000_005_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    paneCoordinator.observeTitleWorking()
    paneCoordinator.observeClassifiedTitleCompletion('Claude done')

    expect(dispatchCompletion).toHaveBeenCalledTimes(2)
  })

  it('does not let a vetoed gated Stop swallow the later all-clear', () => {
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
    coordinator.observeClassifiedTitleCompletion('Claude done')
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_055_000,
      turnCompletedAt: 1_700_000_005_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })
})
