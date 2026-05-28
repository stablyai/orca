import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from './agent-status'
import { createTestStore } from './store-test-helpers'

// Why: dropAgentStatus and dismissRetainedAgentsByWorktree mirror the renderer-
// side dismissal to the main-process hook cache via window.api.agentStatus.drop
// so the on-disk last-status file evicts dismissed paneKeys. Without this, a
// dismissed row would re-appear after Orca restart from the hydrated cache.

const originalWindow = (globalThis as { window?: unknown }).window

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window
  } else {
    ;(globalThis as { window?: unknown }).window = originalWindow
  }
})

function stubWindowApi(): { drop: ReturnType<typeof vi.fn> } {
  const drop = vi.fn()
  ;(globalThis as { window?: unknown }).window = {
    api: { agentStatus: { drop } }
  }
  return { drop }
}

describe('dropAgentStatus → IPC fan-out', () => {
  it('fires window.api.agentStatus.drop exactly once after a live-entry drop', () => {
    const { drop } = stubWindowApi()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'p', agentType: 'claude' })

    store.getState().dropAgentStatus('tab-1:0')
    expect(drop).toHaveBeenCalledTimes(1)
    expect(drop).toHaveBeenCalledWith('tab-1:0')
  })

  it('still fires drop on a no-op dismissal so a stale on-disk entry is cleaned up defensively', () => {
    // Why: the renderer cannot know whether the main-process cache has an
    // entry for this paneKey (it might have one from a hydrated session). A
    // no-op renderer dismissal must still propagate so stale on-disk state
    // is purged; the main-process dropStatusEntry is itself idempotent.
    const { drop } = stubWindowApi()
    const store = createTestStore()
    store.getState().dropAgentStatus('tab-missing:0')
    expect(drop).toHaveBeenCalledTimes(1)
    expect(drop).toHaveBeenCalledWith('tab-missing:0')
  })

  it('idempotent: repeated drops on the same paneKey fire the IPC each time', () => {
    // Why: the renderer keeps drop() side-effect free relative to its own
    // state — sending an extra IPC for an already-dropped paneKey is safe
    // because main-side dropStatusEntry is a no-op when the entry is gone.
    // Asserting this contract documents the renderer's hands-off posture.
    const { drop } = stubWindowApi()
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'p', agentType: 'claude' })
    store.getState().dropAgentStatus('tab-1:0')
    store.getState().dropAgentStatus('tab-1:0')
    expect(drop).toHaveBeenCalledTimes(2)
  })
})

describe('dismissRetainedAgentsByWorktree → IPC fan-out', () => {
  it('fires drop once per dismissed paneKey under the worktree', () => {
    const { drop } = stubWindowApi()
    const store = createTestStore()
    const now = Date.now()
    function makeRetained(paneKey: string, worktreeId: string): RetainedAgentEntry {
      const entry: AgentStatusEntry = {
        state: 'done',
        prompt: '',
        updatedAt: now,
        stateStartedAt: now,
        paneKey,
        stateHistory: []
      }
      return {
        entry,
        worktreeId,
        tab: { id: paneKey.split(':')[0], title: 'claude' } as unknown as TerminalTab,
        agentType: 'claude',
        startedAt: now
      }
    }
    store
      .getState()
      .retainAgents([
        makeRetained('tab-a:0', 'wt-target'),
        makeRetained('tab-b:0', 'wt-target'),
        makeRetained('tab-c:0', 'wt-other')
      ])

    store.getState().dismissRetainedAgentsByWorktree('wt-target')
    expect(drop).toHaveBeenCalledTimes(2)
    const calls = drop.mock.calls.map((c) => c[0]).sort()
    expect(calls).toEqual(['tab-a:0', 'tab-b:0'])
    // Why: the other worktree's retained row must remain.
    expect(store.getState().retainedAgentsByPaneKey['tab-c:0']).toBeDefined()
  })

  it('does not fire IPC when no retained entries match the worktree', () => {
    const { drop } = stubWindowApi()
    const store = createTestStore()
    store.getState().dismissRetainedAgentsByWorktree('wt-empty')
    expect(drop).not.toHaveBeenCalled()
  })
})
