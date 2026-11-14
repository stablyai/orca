/** Evict completion identities on genuine teardown, but retain same-pane live-remount dedup without leaking never-reused leaf UUIDs. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  resetAgentCompletionCoordinatorIdentitiesForTest,
  getAgentCompletionCoordinatorIdentityCountForTest
} from './agent-completion-identity-store'
import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'

function makeOptions(paneKey: string, live: { value: boolean }): AgentCompletionCoordinatorOptions {
  return {
    paneKey,
    getPtyId: () => 'pty-1',
    inspectProcess: vi.fn(),
    dispatchCompletion: vi.fn(),
    isLive: () => live.value
  }
}

describe('agent completion coordinator identity map stays bounded (leak regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetAgentCompletionCoordinatorIdentitiesForTest()
  })

  afterEach(() => {
    resetAgentCompletionCoordinatorIdentitiesForTest()
    vi.useRealTimers()
  })

  it('retains stamped replay state when a mounted sibling disposes before remount', () => {
    const paneKey = 'tab-1:leaf-production-remount'
    const dispatchCompletion = vi.fn()
    const hookLive = { value: true }
    const paneLive = { value: true }
    const hookCoordinator = createAgentCompletionCoordinator({
      ...makeOptions(paneKey, hookLive),
      dispatchCompletion
    })
    const paneCoordinator = createAgentCompletionCoordinator({
      ...makeOptions(paneKey, paneLive),
      dispatchCompletion
    })

    hookCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_000
    })
    hookCoordinator.observeHookStatus({
      state: 'working',
      prompt: 'review the PR',
      agentType: 'claude',
      stateStartedAt: 1_000,
      turnCompletedAt: 2_000
    })
    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    paneLive.value = false
    paneCoordinator.dispose()
    const remountedLive = { value: true }
    const remounted = createAgentCompletionCoordinator({
      ...makeOptions(paneKey, remountedLive),
      dispatchCompletion
    })
    vi.advanceTimersByTime(2_000)
    remounted.observeTitleWorking()
    remounted.observeClassifiedTitleCompletion('Claude done')

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)

    hookLive.value = false
    remountedLive.value = false
    hookCoordinator.dispose()
    remounted.dispose()
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(0)
  })
})
