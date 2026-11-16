import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import type * as RuntimeCapabilityProofModule from '@/runtime/rpc/compatibility/runtime-capability-proof'
// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../../../shared/agent-session/agent-session-wire'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '@/store/types'

import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState>) => void
}

const mocks = vi.hoisted(() => {
  const hoisted: {
    store: TestStore | null
    subscribeStatus: ReturnType<typeof vi.fn>
    supportsCapability: ReturnType<typeof vi.fn>
    unsubscribe: ReturnType<typeof vi.fn>
    applyStatus: ReturnType<typeof vi.fn<(update: unknown) => void>>
  } = {
    store: null,
    subscribeStatus: vi.fn(),
    supportsCapability: vi.fn(),
    unsubscribe: vi.fn(),
    applyStatus: vi.fn()
  }
  return hoisted
})

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  const useAppStore = createTestStore()
  const { transactAgentStatuses } = useAppStore.getState()
  useAppStore.setState({
    transactAgentStatuses: (operation) =>
      transactAgentStatuses((transaction) =>
        operation({
          ...transaction,
          apply: (update) => {
            mocks.applyStatus(update)
            return transaction.apply(update)
          }
        })
      )
  })
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeCapabilityProofModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: vi.fn()
}))

vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { useAppStore } from '@/store'

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/native-chat/status/structured-agent-session-status-feed'

const floatingTab = {
  id: 'floating-chat-1',
  worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
  groupId: 'floating-group',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex',
  executionHostId: LOCAL_EXECUTION_HOST_ID
} satisfies Tab

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
    agent: 'codex',
    status: 'idle',
    latestPrompt: 'hello',
    updatedAt: 1,
    ...overrides
  }
}

function statuses() {
  return Array.from(useAppStore.getState().agentStatusByPaneKey.values())
}
function feed(index = 0): { target: unknown; emit: (event: AgentSessionStatusEvent) => void } {
  const call = mocks.subscribeStatus.mock.calls[index]
  return { target: call[0], emit: call[1] }
}

// Observe actual collection work without replacing the private members or groups.

describe('StructuredAgentSessionStatusBridge pinned launch directory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.store?.setState({
      structuredSessionLaunchDirectoryByTabId: {},
      structuredChatSleptAtByPaneKey: {},
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it('rekeys an older unstamped tab when its worktree owner arrives', async () => {
    const legacyTab = { ...floatingTab, worktreeId: 'wt-1', executionHostId: undefined }
    useAppStore.setState({ unifiedTabsByWorktree: { 'wt-1': [legacyTab] } })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    expect(feed().target).toEqual({ kind: 'local' })
    act(() => feed().emit({ type: 'snapshot', sessions: [summary({ workspaceId: 'wt-1' })] }))
    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          repo: [
            makeWorktree({
              id: 'wt-1',
              repoId: 'repo',
              hostId: 'runtime:env-1',
              runtimeOwnerEnvironmentId: 'env-1'
            })
          ]
        }
      })
    )
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
    expect(feed(1).target).toEqual({ kind: 'environment', environmentId: 'env-1' })
    act(() =>
      feed(1).emit({
        type: 'snapshot',
        sessions: [summary({ workspaceId: 'wt-1', updatedAt: 20 })]
      })
    )
    expect(statuses()[0].updatedAt).toBe(20)
    act(() =>
      feed().emit({ type: 'status', session: summary({ workspaceId: 'wt-1', updatedAt: 30 }) })
    )
    expect(statuses()[0].updatedAt).toBe(20)
  })
})
