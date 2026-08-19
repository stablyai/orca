/**
 * Memory-leak regression: lastCompletionIdentityByPaneKey must not retain an entry
 * per genuinely-torn-down coordinator.
 *
 * `dispatchCompletion` does `lastCompletionIdentityByPaneKey.set(options.paneKey, …)`
 * on every agent completion. `paneKey` is `${tabId}:${leafUUID}` — a never-reused
 * per-pane UUID, so the key space is unbounded. The map is module-scoped on purpose
 * so it survives a live-stream remount (dispose-then-recreate with the same paneKey
 * while the PTY/hook stream stays live). But `dispose()` cleared only local timers
 * and never the map, so on genuine teardown (PTY gone) the identity leaked — one
 * entry per closed pane for the renderer session. The fix evicts on dispose only
 * when the pane is no longer live, preserving the cross-remount dedup.
 */
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
    getSettings: () => null,
    inspectProcess: vi.fn(),
    dispatchCompletion: vi.fn(),
    isLive: () => live.value
  }
}

// A working->done hook sequence with finite stateStartedAt makes the coordinator
// write a completion identity into the module map (the leaking write).
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
    // The map is genuinely exercised by the completion.
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(1)

    // Genuine teardown: the PTY is gone.
    live.value = false
    coordinator.dispose()
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(0)
  })

  it('does not retain an identity per torn-down pane across many panes', () => {
    for (let i = 0; i < 200; i++) {
      const live = { value: true }
      const coordinator = driveCompletion(`tab-1:leaf-${i}`, live)
      live.value = false
      coordinator.dispose()
    }
    expect(getAgentCompletionCoordinatorIdentityCountForTest()).toBe(0)
  })

  it('retains the identity across a live remount (dispose while still live)', () => {
    // Cross-remount dedup: the pane remounts (dispose-then-recreate) while the
    // stream stays live, so the identity must survive the dispose.
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
