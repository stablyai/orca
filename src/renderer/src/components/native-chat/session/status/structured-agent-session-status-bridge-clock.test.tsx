// @vitest-environment happy-dom

// Child updatedAt changes must not reset the parent’s host-dated completion/read stamp; older hosts retain legacy dating.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../../../shared/agent-session/agent-session-wire'

import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { Tab } from '../../../../../../shared/tab-types'
import type { AppState } from '@/store/types'

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
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ? `runtime:${state.testRuntimeOwner}` : 'local'
}))

vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: vi.fn()
}))

vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/native-chat/status/structured-agent-session-status-feed'

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
