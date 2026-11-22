import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  HOOK_DONE_QUIET_MS,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

describe('agent completion coordinator', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('suppresses the same hook completion replay after fresh work starts', () => {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
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

  it('suppresses stale title completion replay after a pane remount until fresh work appears', () => {
    const dispatchCompletion = vi.fn()
    const firstCoordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
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
})
