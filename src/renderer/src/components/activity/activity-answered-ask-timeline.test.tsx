// @vitest-environment happy-dom

// A settled parent whose subagent asks and is answered. Its done keeps the turn's own end time,
// which the blocked ask postdates, so the Activity row must read the pane's row for its state and
// order the timeline by when each switch was seen, not by the states' own times.

import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import { makeRepo, makeWorktree } from './ActivityPrototypePage-test-fixtures'
import { activityThreadRowCopy, activityThreadStatusId } from './activity-thread-presentation'
import { clearActivityThread } from './activity-clear-completed'
import { countActivityUnread } from './useActivityUnreadCount'
import { useAgentPaneThreads } from './use-agent-pane-threads'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState> & { testRuntimeOwner?: string | null }) => void
}

const mocks = vi.hoisted(() => {
  const hoisted: { store: TestStore | null; subscribeStatus: Mock; unsubscribe: Mock } = {
    store: null,
    subscribeStatus: vi.fn(),
    unsubscribe: vi.fn()
  }
  return hoisted
})

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ?? null
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { StructuredAgentSessionStatusBridge } from '../native-chat/StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'

const structuredTab = {
  id: 'structured-tab-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Claude Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'claude'
} satisfies Tab

const SETTLED = 22_000
const ASKED = 27_000
const ANSWERED = 28_500

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'claude',
    status: 'idle',
    hostExecutionOwned: true,
    latestPrompt: 'fan out',
    statusStartedAt: SETTLED,
    updatedAt: SETTLED,
    ...overrides
  }
}

function store(): TestStore {
  if (!mocks.store) {
    throw new Error('store missing')
  }
  return mocks.store
}

function paneKey(): string {
  const [key] = Object.keys(store().getState().agentStatusByPaneKey)
  if (!key) {
    throw new Error('status row missing')
  }
  return key
}

function acknowledge(at: number): void {
  store().setState({ acknowledgedAgentsByPaneKey: { [paneKey()]: at } })
}

/** The Activity page's own pipeline over the store the bridge wrote. */
function renderActivity() {
  return renderHook(() =>
    useAgentPaneThreads({
      query: '',
      readFilter: 'all',
      groupBy: 'none',
      selectedPaneKey: null,
      showChildAgents: true
    })
  )
}

function thread(activity: ReturnType<typeof renderActivity>) {
  const [only, ...rest] = activity.result.current.allThreads
  expect(rest).toHaveLength(0)
  if (!only) {
    throw new Error('activity thread missing')
  }
  return only
}

async function connect(): Promise<(event: AgentSessionStatusEvent) => void> {
  render(<StructuredAgentSessionStatusBridge />)
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
  const emit: (event: AgentSessionStatusEvent) => void = mocks.subscribeStatus.mock.calls[0]?.[1]
  return (event) => act(() => emit(event))
}

describe("an answered subagent ask on a settled parent's Activity row", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    vi.spyOn(Date, 'now').mockReturnValue(ANSWERED + 1_000)
    const worktree = makeWorktree()
    store().setState({
      agentStatusByPaneKey: {},
      acknowledgedAgentsByPaneKey: {},
      activityClearedAtByPaneKey: {},
      retainedAgentsByPaneKey: {},
      testRuntimeOwner: null,
      repos: [makeRepo()],
      worktreesByRepo: { [worktree.repoId]: [worktree] },
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it('reads done, lists Blocked then done, and leaves the answer read', async () => {
    const emit = await connect()
    emit({ type: 'snapshot', sessions: [summary()] })
    acknowledge(SETTLED + 1_000)
    emit({
      type: 'status',
      session: summary({ status: 'attention', statusStartedAt: ASKED, updatedAt: ASKED })
    })
    // The user reads the ask and answers it; the parent returns to its own turn's end.
    acknowledge(ASKED + 500)
    emit({ type: 'status', session: summary({ updatedAt: ANSWERED }) })

    const row = thread(renderActivity())
    expect(activityThreadStatusId(row)).toBe('done')
    expect(activityThreadRowCopy(row).needsAttention).toBe(false)
    // Newest first: the answer's done, the ask, then the turn's original done.
    expect(row.events.map((event) => event.state)).toEqual(['done', 'blocked', 'done'])
    expect(row.events.map((event) => [event.state, event.timestamp, event.observedAt])).toEqual([
      ['done', SETTLED, ANSWERED],
      ['blocked', ASKED, ASKED],
      ['done', SETTLED, SETTLED]
    ])
    expect(row.latestEvent?.observedAt).toBe(ANSWERED)
    // Unread keys on the turn's own end, which the user had already read.
    expect(row.events.map((event) => event.unread)).toEqual([false, false, false])
    expect(row.unread).toBe(false)
    expect(countActivityUnread(store().getState())).toBe(0)

    // Clearing the answered row must also pass the ask, which is dated after the done.
    act(() => {
      expect(clearActivityThread(row)).toBe(true)
    })
    expect(renderActivity().result.current.allThreads).toHaveLength(0)
  })

  it('keeps each answered done between the asks around it', async () => {
    const asks = [ASKED, ASKED + 400, ASKED + 800]
    const emit = await connect()
    emit({ type: 'snapshot', sessions: [summary()] })
    for (const askedAt of asks) {
      emit({
        type: 'status',
        session: summary({ status: 'attention', statusStartedAt: askedAt, updatedAt: askedAt })
      })
      emit({ type: 'status', session: summary({ updatedAt: askedAt + 200 }) })
    }

    // Every done repeats the turn's end, so only when each was seen keeps them apart and in order;
    // the oldest of the six falls to the per-pane cap.
    expect(thread(renderActivity()).events.map((event) => [event.state, event.observedAt])).toEqual(
      [
        ['done', ASKED + 1_000],
        ['blocked', ASKED + 800],
        ['done', ASKED + 600],
        ['blocked', ASKED + 400],
        ['done', ASKED + 200]
      ]
    )
  })

  it('reads done after a clear hid that done, while the later ask stays listed', async () => {
    const emit = await connect()
    emit({ type: 'snapshot', sessions: [summary()] })
    acknowledge(SETTLED + 1_000)
    const beforeAsk = renderActivity()
    let cleared = false
    act(() => {
      cleared = clearActivityThread(thread(beforeAsk))
    })
    expect(cleared).toBe(true)
    beforeAsk.unmount()
    expect(store().getState().activityClearedAtByPaneKey).toEqual({ [paneKey()]: SETTLED })

    emit({
      type: 'status',
      session: summary({ status: 'attention', statusStartedAt: ASKED, updatedAt: ASKED })
    })
    acknowledge(ASKED + 500)
    emit({ type: 'status', session: summary({ updatedAt: ANSWERED }) })

    const row = thread(renderActivity())
    // The cleared done stays cleared; only the ask, seen after the clear, is listed.
    expect(row.events.map((event) => event.state)).toEqual(['blocked'])
    expect(activityThreadStatusId(row)).toBe('done')
    expect(activityThreadRowCopy(row).needsAttention).toBe(false)
    expect(row.unread).toBe(false)
    expect(countActivityUnread(store().getState())).toBe(0)

    // Once a second ask moves the answered done into history, it stays cleared there too.
    emit({
      type: 'status',
      session: summary({
        status: 'attention',
        statusStartedAt: ANSWERED + 200,
        updatedAt: ANSWERED + 200
      })
    })
    expect(thread(renderActivity()).events.map((event) => event.state)).toEqual([
      'blocked',
      'blocked'
    ])
  })
})
