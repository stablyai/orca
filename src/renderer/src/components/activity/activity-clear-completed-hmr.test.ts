// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { ActivityEvent, AgentPaneThread } from './activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

const mockStore = vi.hoisted(() => {
  const activityClearedAtByPaneKey: Record<string, number> = {}
  const agentStatusByPaneKey: Record<string, RetainedAgentEntry['entry']> = {}
  const retainedAgentsByPaneKey: Record<string, RetainedAgentEntry> = {}
  const retentionSuppressedPaneKeys: Record<string, true> = {}
  const state = {
    activityClearedAtByPaneKey,
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    retentionSuppressedPaneKeys,
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
  disposePendingClearCompletedEvictionListener,
  clearCompletedActivity,
  flushPendingClearCompletedEvictions
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
    observedAt: 5_000,
    worktree: makeWorktree(),
    repo: null,
    entry: { ...makeRetained('t-done:1').entry, interrupted },
    tab: makeTab(),
    agentType: 'claude',
    agentAlive: false,
    unread: false
  }
}

const doneThread = makeThread('t-done:1', { latestEvent: doneEvent(false) })

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

const drop = vi.fn()
const domWindow = window
beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(domWindow, { api: { agentStatus: { dropPersistedBatch: drop } } })
  mockStore.retainedAgentsByPaneKey = { 't-done:1': makeRetained('t-done:1') }
  mockStore.activityClearedAtByPaneKey = {}
  mockStore.retentionSuppressedPaneKeys = {}
})
afterEach(() => {
  flushPendingClearCompletedEvictions()
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('preserves the pending pagehide flush through HMR and removes the listener when drained', () => {
  const remove = vi.spyOn(domWindow, 'removeEventListener')
  try {
    clearCompletedActivity([doneThread])
    disposePendingClearCompletedEvictionListener()
    expect(remove).not.toHaveBeenCalledWith('pagehide', flushPendingClearCompletedEvictions)
    domWindow.dispatchEvent(new Event('pagehide'))
    expect(drop).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('pagehide', flushPendingClearCompletedEvictions)
  } finally {
    remove.mockRestore()
  }
})

it('preserves Undo after HMR without dropping the restored persisted row', () => {
  clearCompletedActivity([doneThread])
  disposePendingClearCompletedEvictionListener()
  const options = toastSpy.mock.calls.at(-1)?.[1]
  options.action.onClick()
  domWindow.dispatchEvent(new Event('pagehide'))
  vi.advanceTimersByTime(CLEAR_COMPLETED_EVICTION_FALLBACK_MS)
  expect(drop).not.toHaveBeenCalled()
  expect(mockStore.retainedAgentsByPaneKey['t-done:1']).toBeDefined()
})

it('releases the retired listener when its fallback settles and supports a late stale handler', () => {
  const remove = vi.spyOn(domWindow, 'removeEventListener')
  try {
    clearCompletedActivity([doneThread])
    disposePendingClearCompletedEvictionListener()
    vi.advanceTimersByTime(CLEAR_COMPLETED_EVICTION_FALLBACK_MS)
    expect(drop).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('pagehide', flushPendingClearCompletedEvictions)
    mockStore.retainedAgentsByPaneKey = { 't-done:1': makeRetained('t-done:1') }
    clearCompletedActivity([doneThread])
    domWindow.dispatchEvent(new Event('pagehide'))
    expect(drop).toHaveBeenCalledTimes(2)
  } finally {
    remove.mockRestore()
  }
})
