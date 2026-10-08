// @vitest-environment happy-dom

// The sidebar row follows the host's Stopping both ways, even when nothing else on the summary
// moved: a Stop that settles, then binds no turn, changes only that field.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
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
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ?? null,
  getExecutionHostIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ? `runtime:${state.testRuntimeOwner}` : 'local'
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
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex'
} satisfies Tab

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'codex',
    status: 'working',
    hostExecutionOwned: true,
    latestPrompt: 'work on this',
    updatedAt: 5_000,
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

describe("the sidebar row's Stopping", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.store?.setState({
      agentStatusByPaneKey: {},
      testRuntimeOwner: null,
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it('takes Stopping on and off when it is the only field that moved', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    const emit: (event: AgentSessionStatusEvent) => void = mocks.subscribeStatus.mock.calls[0]?.[1]

    act(() => emit({ type: 'status', session: summary({ stopping: true }) }))
    expect(row().mainAgent).toMatchObject({ state: 'working', stopping: true })

    act(() => emit({ type: 'status', session: summary() }))
    expect(row().state).toBe('working')
    expect(row().mainAgent).not.toHaveProperty('stopping')
  })
})
