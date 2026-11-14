import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import type * as RuntimeCapabilityProofModule from '@/runtime/rpc/compatibility/runtime-capability-proof'
// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../../../shared/agent-session/agent-session-wire'

import type { Tab } from '../../../../../../shared/tab-types'
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
  } = {
    store: null,
    subscribeStatus: vi.fn(),
    supportsCapability: vi.fn(),
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

import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'codex',
    status: 'idle',
    latestPrompt: 'hello',
    updatedAt: 1,
    ...overrides
  }
}

function feed(index = 0): { target: unknown; emit: (event: AgentSessionStatusEvent) => void } {
  const calls = mocks.subscribeStatus.mock.calls
  const call = calls[index < 0 ? calls.length + index : index]
  return { target: call[0], emit: call[1] }
}

function statusFor(tabId: string, sessionId: string) {
  return useAppStore
    .getState()
    .agentStatusByPaneKey.get(structuredAgentSessionPaneKey(tabId, sessionId))
}

// Real tab actions annotate their writes, so these reach the bridge's addressed reconciliation.
describe('StructuredAgentSessionStatusBridge with tab actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.store?.setState({
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
      structuredChatSleptAtByPaneKey: {},
      structuredSessionLaunchDirectoryByTabId: {},
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      layoutByWorktree: {}
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it('rebinds an unstamped chat to its new owner host without changing membership', async () => {
    useAppStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'chat-1',
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
        ]
      }
    })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed().emit({ type: 'snapshot', sessions: [summary({ updatedAt: 2 })] }))
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
    act(() => feed(1).emit({ type: 'snapshot', sessions: [summary({ updatedAt: 20 })] }))
    act(() => feed().emit({ type: 'status', session: summary({ updatedAt: 30 }) }))
    expect(Array.from(useAppStore.getState().agentStatusByPaneKey.keys())).toEqual([
      structuredAgentSessionPaneKey('chat-1', 'session-1')
    ])
    expect(statusFor('chat-1', 'session-1')?.updatedAt).toBe(20)
  })
})
