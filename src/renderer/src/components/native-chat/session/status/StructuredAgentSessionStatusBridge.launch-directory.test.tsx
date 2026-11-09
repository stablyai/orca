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
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/native-chat/status/structured-agent-session-status-feed'

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

function pins(): AppState['structuredSessionLaunchDirectoryByTabId'] {
  return mocks.store?.getState().structuredSessionLaunchDirectoryByTabId ?? {}
}

function statuses() {
  return Object.values(useAppStore.getState().agentStatusByPaneKey)
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
      agentStatusByPaneKey: {},
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it('keeps shared leases and a later host reintroduced synchronously by feed release', async () => {
    const local = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    const remote = getStructuredAgentSessionStatusFeed({
      kind: 'environment',
      environmentId: 'paired'
    })
    const released = [vi.fn(), vi.fn()]
    mocks.subscribeStatus
      .mockResolvedValueOnce({ unsubscribe: released[0] })
      .mockResolvedValueOnce({ unsubscribe: released[1] })
    const remoteLease = vi.spyOn(remote, 'activate')
    const tabs: Tab[] = [
      floatingTab,
      { ...floatingTab, id: 'second', entityId: 'session-2' },
      { ...floatingTab, id: 'remote', entityId: 'session-3', executionHostId: 'runtime:paired' }
    ]
    useAppStore.setState({ unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs } })
    const view = render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
    act(() => {
      feed(0).emit({
        type: 'snapshot',
        sessions: tabs.slice(0, 2).map((tab) =>
          summary({
            sessionId: tab.entityId,
            hostExecutionOwned: true,
            sleptAt: 5,
            launchDirectory: '/project'
          })
        )
      })
      feed(1).emit({
        type: 'snapshot',
        sessions: [summary({ sessionId: 'session-3', sleptAt: 7 })]
      })
    })
    act(() =>
      useAppStore.setState({
        unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs.slice(1) }
      })
    )
    expect(released.every((release) => release.mock.calls.length === 0)).toBe(true)
    expect(statuses()).toHaveLength(2)
    expect(pins().second?.sessionId).toBe('session-2')
    expect(pins()[floatingTab.id]).toBeUndefined()
    let reenter = true
    const stop = local.subscribe(() => {
      if (!reenter) {
        return
      }
      reenter = false
      useAppStore.setState({
        unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [tabs[2]] }
      })
    })
    try {
      act(() =>
        useAppStore.setState({ unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [] } })
      )
      expect(reenter).toBe(false)
      expect(released[0]).toHaveBeenCalledOnce()
      expect(released[1]).not.toHaveBeenCalled()
      expect(remoteLease).toHaveBeenCalledOnce()
      act(() =>
        feed(1).emit({
          type: 'status',
          session: summary({ sessionId: 'session-3', status: 'working', updatedAt: 900 })
        })
      )
      expect(statuses()).toEqual([expect.objectContaining({ updatedAt: 900, state: 'working' })])
      expect(pins()).toEqual({})
      expect(Object.values(useAppStore.getState().structuredChatSleptAtByPaneKey)).toEqual([null])
      view.unmount()
      expect(released[1]).toHaveBeenCalledOnce()
    } finally {
      stop()
      remoteLease.mockRestore()
    }
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
