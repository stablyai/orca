// @vitest-environment happy-dom

// The row's state clock, as the host dates it. A subagent's rows move the summary's `updatedAt`
// but never its `statusStartedAt`, so a settled parent must keep its completion stamp and stay
// read while its child works on; an older host that publishes no clock keeps the old dating.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import { countActivityUnread } from '../activity/useActivityUnreadCount'

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

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
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
const ACKNOWLEDGED = 23_000

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'claude',
    status: 'idle',
    hostExecutionOwned: true,
    latestPrompt: 'fan out',
    updatedAt: SETTLED,
    ...overrides
  }
}

function row(): AgentStatusEntry {
  const [entry] = Object.values(mocks.store?.getState().agentStatusByPaneKey ?? {})
  if (!entry) {
    throw new Error('status row missing')
  }
  return entry
}

function acknowledge(at: number): void {
  mocks.store?.setState({ acknowledgedAgentsByPaneKey: { [row().paneKey]: at } })
}

function unread(): number {
  const state = mocks.store?.getState()
  if (!state) {
    throw new Error('store missing')
  }
  return countActivityUnread(state, ACKNOWLEDGED + 60_000)
}

async function connect(): Promise<(event: AgentSessionStatusEvent) => void> {
  render(<StructuredAgentSessionStatusBridge />)
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
  const emit: (event: AgentSessionStatusEvent) => void = mocks.subscribeStatus.mock.calls[0]?.[1]
  return (event) => act(() => emit(event))
}

describe("the structured row's state clock", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.store?.setState({
      agentStatusByPaneKey: {},
      acknowledgedAgentsByPaneKey: {},
      testRuntimeOwner: null,
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it('keeps a settled parent read while its subagent writes, until its own next turn ends', async () => {
    const emit = await connect()
    emit({ type: 'snapshot', sessions: [summary({ statusStartedAt: SETTLED })] })
    expect(row()).toMatchObject({ state: 'done', stateStartedAt: SETTLED })
    acknowledge(ACKNOWLEDGED)
    expect(unread()).toBe(0)

    // The child's rows move the evidence clock, and a host may still republish for them.
    for (const updatedAt of [24_000, 25_000, 26_000]) {
      emit({ type: 'status', session: summary({ statusStartedAt: SETTLED, updatedAt }) })
    }
    expect(row()).toMatchObject({ state: 'done', updatedAt: 26_000, stateStartedAt: SETTLED })
    expect(unread()).toBe(0)

    emit({
      type: 'status',
      session: summary({ status: 'working', statusStartedAt: 30_000, updatedAt: 30_000 })
    })
    emit({ type: 'status', session: summary({ statusStartedAt: 31_000, updatedAt: 31_000 }) })
    expect(row()).toMatchObject({ state: 'done', stateStartedAt: 31_000 })
    expect(unread()).toBe(1)
  })

  it("keeps the old dating for an older host's summary, which carries no clock", async () => {
    const emit = await connect()
    emit({ type: 'snapshot', sessions: [summary()] })
    acknowledge(ACKNOWLEDGED)
    expect(unread()).toBe(0)
    emit({ type: 'status', session: summary({ updatedAt: 26_000 }) })
    expect(row()).toMatchObject({ state: 'done', stateStartedAt: 26_000 })
    expect(unread()).toBe(1)
  })

  it("dates a subagent's approval at the ask and leaves the parent's completion where it was", async () => {
    const emit = await connect()
    emit({ type: 'snapshot', sessions: [summary({ statusStartedAt: SETTLED })] })
    acknowledge(ACKNOWLEDGED)

    emit({
      type: 'status',
      session: summary({ status: 'attention', statusStartedAt: 27_000, updatedAt: 27_000 })
    })
    expect(row()).toMatchObject({
      state: 'blocked',
      stateStartedAt: 27_000,
      mainAgent: { state: 'blocked', stateStartedAt: 27_000 }
    })
    expect(unread()).toBe(1)

    // Answered: the parent is idle again, still dated by its own last turn.
    acknowledge(28_000)
    emit({ type: 'status', session: summary({ statusStartedAt: SETTLED, updatedAt: 28_500 }) })
    expect(row()).toMatchObject({ state: 'done', stateStartedAt: SETTLED })
    expect(agentEntryCompletionAt(row())).toBe(SETTLED)
    expect(unread()).toBe(0)
  })

  it('leaves a row child work holds open on its own continuity, and settles it on the parent clock', async () => {
    const emit = await connect()
    const child = { id: 'child-1', kind: 'agent', state: 'working' } as const
    emit({
      type: 'snapshot',
      sessions: [summary({ status: 'working', statusStartedAt: 10_000, updatedAt: 10_000 })]
    })
    emit({
      type: 'status',
      session: summary({ statusStartedAt: SETTLED, updatedAt: 24_000, backgroundTasks: [child] })
    })
    // Still working as far as the row shows, so that state keeps the clock it started with.
    expect(row()).toMatchObject({
      state: 'working',
      stateStartedAt: 10_000,
      mainAgent: { state: 'done', stateStartedAt: SETTLED }
    })

    emit({
      type: 'status',
      session: summary({
        statusStartedAt: SETTLED,
        updatedAt: 26_000,
        backgroundTasks: [{ ...child, state: 'done' }]
      })
    })
    expect(row()).toMatchObject({ state: 'done', stateStartedAt: SETTLED })
  })
})
