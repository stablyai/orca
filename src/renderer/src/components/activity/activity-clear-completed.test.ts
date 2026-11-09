import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RetainedAgentEntry } from '@/store/slices/agent-status/agent-status-contract'
import type { ActivityEvent, AgentPaneThread } from './activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

const mockStore = vi.hoisted(() => {
  const state = {
    activityClearedAtByPaneKey: {} as Record<string, number>,
    retainedAgentsByPaneKey: {} as Record<string, RetainedAgentEntry>
  }
  return state
})

const toastSpy = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStore }
}))
vi.mock('sonner', () => ({ toast: toastSpy }))

import { isClearableActivityThread, planClearCompletedActivity } from './activity-clear-completed'
import { activityThreadStatusId } from './activity-thread-presentation'

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

function doneEvent(interrupted: boolean, outcome?: 'failure'): ActivityEvent {
  return {
    id: 'evt',
    state: 'done',
    timestamp: 5_000,
    observedAt: 5_000,
    worktree: makeWorktree(),
    repo: null,
    entry: {
      paneKey: 'evt-pane',
      state: 'done',
      prompt: '',
      updatedAt: 5_000,
      stateStartedAt: 5_000,
      stateHistory: [],
      interrupted,
      ...(outcome ? { mainAgent: { state: 'done', outcome, stateStartedAt: 5_000 } } : {})
    },
    tab: makeTab(),
    agentType: 'claude',
    agentAlive: false,
    unread: false
  }
}

const workingThread = makeThread('t-working:1', { currentAgentState: 'working' })
const blockedThread = makeThread('t-blocked:1', { currentAgentState: 'blocked' })
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
  it('reads a live thread whose main agent failed as failed, but keeps it while subagents run', () => {
    const heldEntry = {
      ...doneEvent(false).entry,
      state: 'working' as const,
      mainAgent: { state: 'done' as const, outcome: 'failure' as const, stateStartedAt: 5_000 }
    }
    const held = makeThread('t-held:1', {
      currentAgentState: 'working',
      currentAgentEntry: heldEntry
    })
    expect(activityThreadStatusId(held)).toBe('failed')
    expect(isClearableActivityThread(held)).toBe(false)
    const succeeded = makeThread('t-ok:1', {
      currentAgentState: 'working',
      currentAgentEntry: {
        ...heldEntry,
        mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 5_000 }
      }
    })
    expect(activityThreadStatusId(succeeded)).toBe('working')
  })
})

describe('clearCompletedActivity', () => {
  beforeEach(() => {
    mockStore.activityClearedAtByPaneKey = {}
    mockStore.retainedAgentsByPaneKey = { 't-done:1': makeRetained('t-done:1') }
  })

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

  it('stamps a real cutoff for a thread with no usable timestamp', () => {
    // A zero cutoff is dropped by the hydrate sanitizer and the clear would replay after restart.
    const unstamped = makeThread('t-done:1', { latestEvent: doneEvent(false), latestTimestamp: 0 })
    const plan = planClearCompletedActivity([unstamped], mockStore, 42_000)
    expect(plan.cutoffPatch).toEqual({ 't-done:1': 42_000 })
  })
})
