import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordAgentFinishDropped } = vi.hoisted(() => ({ recordAgentFinishDropped: vi.fn() }))
vi.mock('@/attention/agent-finish-drop-breadcrumb', () => ({ recordAgentFinishDropped }))

import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'

// #40340: the crumb must name a swallowed new turn end, never a revision of one already announced.
describe('turn-end-not-counted breadcrumb', () => {
  useAgentCompletionCoordinatorLifecycle()
  beforeEach(() => recordAgentFinishDropped.mockClear())

  function hookCoordinator() {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      statusLane: 'hook',
      getPtyId: () => 'pty-1',
      inspectProcess: vi.fn(),
      dispatchCompletion,
      isLive: () => true
    })
    coordinator.observeHookStatus({
      state: 'working',
      prompt: 'first turn',
      agentType: 'claude',
      stateStartedAt: 2_000
    })
    const done = { state: 'done' as const, prompt: 'first turn', agentType: 'claude' }
    coordinator.observeHookStatus({ ...done, stateStartedAt: 2_400, turnCompletedAt: 2_500 })
    vi.runAllTimers()
    return { coordinator, dispatchCompletion, done }
  }

  it('records nothing for a revision of the announced end', () => {
    const { coordinator, dispatchCompletion, done } = hookCoordinator()
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    coordinator.observeHookStatus({
      ...done,
      stateStartedAt: 2_400,
      turnCompletedAt: 2_500,
      turnEndedAt: 2_600
    })

    expect(recordAgentFinishDropped).not.toHaveBeenCalled()
  })

  it('records a different end swallowed with no working state in between', () => {
    const { coordinator, done } = hookCoordinator()

    coordinator.observeHookStatus({ ...done, stateStartedAt: 3_400, turnCompletedAt: 3_500 })

    expect(recordAgentFinishDropped).toHaveBeenCalledWith('turn-end-not-counted', {
      paneKey: 'tab-1:leaf-1'
    })
  })
})
