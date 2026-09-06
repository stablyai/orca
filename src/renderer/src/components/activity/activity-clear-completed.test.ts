import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { ActivityEvent, AgentPaneThread } from './activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

const mockStore = vi.hoisted(() => {
  const state = {
    activityClearedAtByPaneKey: {} as Record<string, number>,
    agentStatusByPaneKey: {} as Record<string, RetainedAgentEntry['entry']>,
    retainedAgentsByPaneKey: {} as Record<string, RetainedAgentEntry>,
    retentionSuppressedPaneKeys: {} as Record<string, true>,
    applyActivityClearedAt: vi.fn((patch: Record<string, number | null>) => {
      const next = { ...state.activityClearedAtByPaneKey }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          delete next[key]
        } else {
          next[key] = value
        }
      }
      state.activityClearedAtByPaneKey = next
    }),
    dismissRetainedAgents: vi.fn((paneKeys: readonly string[]) => {
      const next = { ...state.retainedAgentsByPaneKey }
      for (const key of paneKeys) {
        if (state.agentStatusByPaneKey[key]) {
          state.retentionSuppressedPaneKeys[key] = true
        }
        delete next[key]
      }
      state.retainedAgentsByPaneKey = next
    }),
    clearRetentionSuppressedPaneKeys: vi.fn((paneKeys: string[]) => {
      for (const key of paneKeys) {
        delete state.retentionSuppressedPaneKeys[key]
      }
    }),
    retainAgents: vi.fn((entries: RetainedAgentEntry[]) => {
      const next = { ...state.retainedAgentsByPaneKey }
      for (const retained of entries) {
        next[retained.entry.paneKey] = retained
      }
      state.retainedAgentsByPaneKey = next
    })
  }
  return state
})

const toastSpy = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStore }
}))
vi.mock('sonner', () => ({ toast: toastSpy }))

import {
  CLEAR_COMPLETED_EVICTION_FALLBACK_MS,
  clearCompletedActivity,
  flushPendingClearCompletedEvictions,
  isClearableActivityThread,
  planClearCompletedActivity
} from './activity-clear-completed'

function makeThread(paneKey: string, overrides: Partial<AgentPaneThread> = {}): AgentPaneThread {
  return {
    paneKey,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 5_000,
    agentType: 'claude',
    unread: false,
    paneTitle: `Agent ${paneKey}`,
    responsePreview: '',
    events: [],
    ...overrides
  }
}

function doneEvent(interrupted: boolean): ActivityEvent {
  return {
    id: 'evt',
    state: 'done',
    timestamp: 5_000,
    worktree: makeWorktree(),
    repo: null,
    entry: { interrupted } as ActivityEvent['entry'],
    tab: makeTab(),
    agentType: 'claude',
    agentAlive: false,
    unread: false
  }
}

const workingThread = makeThread('t-working:1', { currentAgentState: 'working' })
const blockedThread = makeThread('t-blocked:1', { currentAgentState: 'blocked' })
const waitingThread = makeThread('t-waiting:1', { currentAgentState: 'waiting' })
const doneThread = makeThread('t-done:1', { latestEvent: doneEvent(false) })
const interruptedThread = makeThread('t-interrupted:1', { latestEvent: doneEvent(true) })

function makeRetained(paneKey: string): RetainedAgentEntry {
  return {
    entry: {
      state: 'done',
      prompt: 'retained run',
      updatedAt: 5_000,
      stateStartedAt: 5_000,
      paneKey,
      stateHistory: [],
      agentType: 'claude'
    },
    worktreeId: 'wt-1',
    tab: makeTab(),
    agentType: 'claude',
    startedAt: 5_000
  }
}

describe('isClearableActivityThread', () => {
  it('clears only completed and interrupted threads', () => {
    expect(isClearableActivityThread(doneThread)).toBe(true)
    expect(isClearableActivityThread(interruptedThread)).toBe(true)
    expect(isClearableActivityThread(workingThread)).toBe(false)
    expect(isClearableActivityThread(blockedThread)).toBe(false)
    expect(isClearableActivityThread(waitingThread)).toBe(false)
  })
})

describe('clearCompletedActivity', () => {
  beforeEach(() => {
    mockStore.activityClearedAtByPaneKey = {}
    mockStore.agentStatusByPaneKey = {}
    mockStore.retainedAgentsByPaneKey = { 't-done:1': makeRetained('t-done:1') }
    mockStore.retentionSuppressedPaneKeys = {}
    vi.stubGlobal('window', {
      api: { agentStatus: { dropPersisted: vi.fn(), dropPersistedBatch: vi.fn() } }
    })
  })

  afterEach(() => {
    // Drain any eviction left pending by a test that never closed its toast.
    flushPendingClearCompletedEvictions()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  function lastToastOptions(): {
    action: { label: string; onClick: () => void }
    onDismiss: () => void
    onAutoClose: () => void
  } {
    return toastSpy.mock.calls.at(-1)?.[1]
  }

  it('plans cutoffs and retained removals for completed threads only', () => {
    const plan = planClearCompletedActivity(
      [workingThread, blockedThread, doneThread, interruptedThread],
      mockStore
    )
    expect(plan.clearedThreadCount).toBe(2)
    expect(plan.cutoffPatch).toEqual({ 't-done:1': 5_000, 't-interrupted:1': 5_000 })
    expect(plan.restorePatch).toEqual({ 't-done:1': null, 't-interrupted:1': null })
    expect(plan.retainedSnapshots.map((r) => r.entry.paneKey)).toEqual(['t-done:1'])
  })

  it('stamps cutoffs, dismisses retained snapshots, and defers the disk drop to toast close', () => {
    const cleared = clearCompletedActivity([workingThread, doneThread, interruptedThread])
    expect(cleared).toBe(true)
    expect(mockStore.activityClearedAtByPaneKey).toEqual({
      't-done:1': 5_000,
      't-interrupted:1': 5_000
    })
    expect(mockStore.dismissRetainedAgents).toHaveBeenCalledWith(['t-done:1'])
    const drop = (
      window as unknown as {
        api: { agentStatus: { dropPersistedBatch: ReturnType<typeof vi.fn> } }
      }
    ).api.agentStatus.dropPersistedBatch
    expect(drop).not.toHaveBeenCalled()

    lastToastOptions().onAutoClose()
    expect(drop).toHaveBeenCalledTimes(1)
    expect(drop).toHaveBeenCalledWith([
      expect.objectContaining({ paneKey: 't-done:1', receivedAt: 5_000, stateStartedAt: 5_000 })
    ])
    // A later dismiss must not double-drop.
    lastToastOptions().onDismiss()
    expect(drop).toHaveBeenCalledTimes(1)
  })

  it('undo restores prior cutoffs and re-retains snapshots, and skips the disk drop', () => {
    mockStore.activityClearedAtByPaneKey = { 't-done:1': 1_111 }
    clearCompletedActivity([doneThread, interruptedThread])
    expect(mockStore.activityClearedAtByPaneKey).toEqual({
      't-done:1': 5_000,
      't-interrupted:1': 5_000
    })
    expect(mockStore.retainedAgentsByPaneKey['t-done:1']).toBeUndefined()

    lastToastOptions().action.onClick()
    expect(mockStore.activityClearedAtByPaneKey).toEqual({ 't-done:1': 1_111 })
    expect(mockStore.retainedAgentsByPaneKey['t-done:1']).toBeDefined()

    lastToastOptions().onAutoClose()
    const drop = (
      window as unknown as {
        api: { agentStatus: { dropPersistedBatch: ReturnType<typeof vi.fn> } }
      }
    ).api.agentStatus.dropPersistedBatch
    expect(drop).not.toHaveBeenCalled()
  })

  it('undo restores a completed live row and removes the suppressor created by clear', () => {
    const retained = mockStore.retainedAgentsByPaneKey['t-done:1']
    mockStore.agentStatusByPaneKey['t-done:1'] = retained.entry
    mockStore.activityClearedAtByPaneKey = { 't-done:1': 1_111 }

    clearCompletedActivity([doneThread])
    expect(mockStore.activityClearedAtByPaneKey['t-done:1']).toBe(5_000)
    expect(mockStore.retentionSuppressedPaneKeys['t-done:1']).toBe(true)

    lastToastOptions().action.onClick()

    expect(mockStore.activityClearedAtByPaneKey['t-done:1']).toBe(1_111)
    expect(mockStore.retentionSuppressedPaneKeys['t-done:1']).toBeUndefined()
    expect(mockStore.retainedAgentsByPaneKey['t-done:1']).toBeUndefined()
  })

  it('undo removes the suppressor even after an identity-only live entry replacement', () => {
    // A runtime orchestration merge replaces the live entry object without a state
    // change; the suppressor undo must key on the turn, not on object identity.
    const retained = mockStore.retainedAgentsByPaneKey['t-done:1']
    mockStore.agentStatusByPaneKey['t-done:1'] = retained.entry

    clearCompletedActivity([doneThread])
    expect(mockStore.retentionSuppressedPaneKeys['t-done:1']).toBe(true)
    mockStore.agentStatusByPaneKey['t-done:1'] = { ...retained.entry }

    lastToastOptions().action.onClick()

    expect(mockStore.retentionSuppressedPaneKeys['t-done:1']).toBeUndefined()
  })

  it('undo keeps the suppressor when the live row has moved to a new turn', () => {
    const retained = mockStore.retainedAgentsByPaneKey['t-done:1']
    mockStore.agentStatusByPaneKey['t-done:1'] = retained.entry

    clearCompletedActivity([doneThread])
    mockStore.agentStatusByPaneKey['t-done:1'] = {
      ...retained.entry,
      stateStartedAt: retained.entry.stateStartedAt + 1
    }

    lastToastOptions().action.onClick()

    expect(mockStore.retentionSuppressedPaneKeys['t-done:1']).toBe(true)
  })

  it('does not restore a cleared snapshot over a newer retained run', () => {
    clearCompletedActivity([doneThread])
    const newer = makeRetained('t-done:1')
    newer.entry.prompt = 'newer run'
    mockStore.retainedAgentsByPaneKey['t-done:1'] = newer

    lastToastOptions().action.onClick()

    expect(mockStore.retainedAgentsByPaneKey['t-done:1']).toBe(newer)
    expect(mockStore.activityClearedAtByPaneKey['t-done:1']).toBeUndefined()
  })

  it('stamps a real cutoff for a thread with no usable timestamp', () => {
    // A zero cutoff is dropped by the hydrate sanitizer and the clear would replay after restart.
    const unstamped = makeThread('t-done:1', { latestEvent: doneEvent(false), latestTimestamp: 0 })
    const plan = planClearCompletedActivity([unstamped], mockStore, 42_000)
    expect(plan.cutoffPatch).toEqual({ 't-done:1': 42_000 })
  })

  it('evicts after the fallback window when no toast close callback ever fires', () => {
    vi.useFakeTimers()
    try {
      clearCompletedActivity([doneThread])
      const drop = (
        window as unknown as {
          api: { agentStatus: { dropPersistedBatch: ReturnType<typeof vi.fn> } }
        }
      ).api.agentStatus.dropPersistedBatch
      expect(drop).not.toHaveBeenCalled()

      vi.advanceTimersByTime(CLEAR_COMPLETED_EVICTION_FALLBACK_MS)
      expect(drop).toHaveBeenCalledTimes(1)

      lastToastOptions().onDismiss()
      expect(drop).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('undo cancels the fallback eviction timer', () => {
    vi.useFakeTimers()
    try {
      clearCompletedActivity([doneThread])
      lastToastOptions().action.onClick()
      vi.advanceTimersByTime(CLEAR_COMPLETED_EVICTION_FALLBACK_MS)
      const drop = (
        window as unknown as {
          api: { agentStatus: { dropPersistedBatch: ReturnType<typeof vi.fn> } }
        }
      ).api.agentStatus.dropPersistedBatch
      expect(drop).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to per-identity drops when the batch API is absent', () => {
    const dropOne = vi.fn()
    vi.stubGlobal('window', { api: { agentStatus: { dropPersisted: dropOne } } })
    clearCompletedActivity([doneThread])
    lastToastOptions().onAutoClose()
    expect(dropOne).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no thread is clearable', () => {
    expect(clearCompletedActivity([workingThread, blockedThread])).toBe(false)
    expect(toastSpy).not.toHaveBeenCalled()
    expect(mockStore.applyActivityClearedAt).not.toHaveBeenCalled()
  })

  it('pagehide flush evicts a clear whose undo toast is still open', () => {
    clearCompletedActivity([doneThread])
    const drop = (
      window as unknown as {
        api: { agentStatus: { dropPersistedBatch: ReturnType<typeof vi.fn> } }
      }
    ).api.agentStatus.dropPersistedBatch
    expect(drop).not.toHaveBeenCalled()

    // Quit/reload path: the toast's close callbacks never fire.
    flushPendingClearCompletedEvictions()
    expect(drop).toHaveBeenCalledTimes(1)

    // The flushed eviction is consumed; later toast close must not double-drop.
    lastToastOptions().onAutoClose()
    expect(drop).toHaveBeenCalledTimes(1)
  })

  it('pagehide flush skips a clear that was undone', () => {
    clearCompletedActivity([doneThread])
    lastToastOptions().action.onClick()
    flushPendingClearCompletedEvictions()
    const drop = (
      window as unknown as {
        api: { agentStatus: { dropPersistedBatch: ReturnType<typeof vi.fn> } }
      }
    ).api.agentStatus.dropPersistedBatch
    expect(drop).not.toHaveBeenCalled()
  })
})
