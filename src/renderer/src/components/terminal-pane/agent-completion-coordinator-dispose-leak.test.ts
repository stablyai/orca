/** Evict completion identities on genuine teardown, but retain same-pane live-remount dedup without leaking never-reused leaf UUIDs. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest,
  getAgentCompletionCoordinatorIdentityCountForTest
} from './agent-completion-coordinator'
import type {
  AgentCompletionCoordinatorOptions,
  AgentCompletionStatusSnapshot
} from './agent-completion-coordinator-types'

const HOOK_DONE_QUIET_MS = 1_500

function makeOptions(paneKey: string, live: { value: boolean }): AgentCompletionCoordinatorOptions {
  return {
    paneKey,
    getPtyId: () => 'pty-1',
    inspectProcess: vi.fn(),
    dispatchCompletion: vi.fn(),
    isLive: () => live.value
  }
}

// Complete a stamped working→done turn to populate the shared identity map.
function driveCompletion(
  paneKey: string,
  live: { value: boolean }
): ReturnType<typeof createAgentCompletionCoordinator> {
  const coordinator = createAgentCompletionCoordinator(makeOptions(paneKey, live))
  coordinator.observeHookStatus({
    state: 'working',
    prompt: '',
    agentType: 'codex',
    stateStartedAt: 1000
  } as AgentCompletionStatusSnapshot)
  coordinator.observeHookStatus({
    state: 'done',
    prompt: '',
    agentType: 'codex',
    stateStartedAt: 2000
  } as AgentCompletionStatusSnapshot)
  vi.advanceTimersByTime(HOOK_DONE_QUIET_MS)
  return coordinator
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

  it('writes an identity on completion and clears it on genuine teardown', () => {
    const live = { value: true }
    const coordinator = driveCompletion('tab-1:leaf-x', live)
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(1)

    live.value = false
    coordinator.dispose()
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(0)
  })

  it('retains the identity across a live remount (dispose while still live)', () => {
    // Retain identity across remount while the same pane stream stays live.
    const live = { value: true }
    const coordinator = driveCompletion('tab-1:leaf-remount', live)
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(1)

    coordinator.dispose() // isLive() still true -> remount, not teardown
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(1)
  })

  it('clears per-coordinator working boundaries on reset and dispose', () => {
    const live = { value: true }
    const coordinator = createAgentCompletionCoordinator(
      makeOptions('tab-1:leaf-working-boundary', live)
    )
    const working = {
      state: 'working' as const,
      prompt: '',
      agentType: 'claude' as const,
      stateStartedAt: 1_000
    }

    coordinator.observeHookStatus(working)
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(1)
    coordinator.resetCompletionState()
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(0)

    coordinator.observeHookStatus(working)
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(1)
    coordinator.dispose()
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(0)
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
