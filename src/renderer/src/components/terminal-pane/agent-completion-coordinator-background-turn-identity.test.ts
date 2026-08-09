import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  HOOK_DONE_QUIET_MS,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'

describe('agent completion coordinator', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('pairs a background all-clear with the turn it announced even after a working title blip', () => {
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
    // Why: Claude's lead Stop ended the turn while a background subagent kept the pane `working`.
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_000_000,
      turnCompletedAt: 1_700_000_005_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    // Why: a working spinner in the title resets the pane's completion-identity record, so the
    // all-clear below can only be recognized by the turn end time it repeats — not by the pane's
    // pinned stateStartedAt, which moved when the row finally reported `done` (#13245).
    vi.advanceTimersByTime(2_000)
    coordinator.observeTitleWorking()

    coordinator.observeHookStatus({
      state: 'done',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_700_000_050_000,
      turnCompletedAt: 1_700_000_005_000
    })
    vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })
})
