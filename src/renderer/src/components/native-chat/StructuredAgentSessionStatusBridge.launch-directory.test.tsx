// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

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
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'

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

function emit(event: AgentSessionStatusEvent): void {
  const call = mocks.subscribeStatus.mock.calls.at(-1)
  if (!call) {
    throw new Error('status feed not subscribed')
  }
  const send: (event: AgentSessionStatusEvent) => void = call[1]
  act(() => send(event))
}

function pins(): AppState['structuredSessionLaunchDirectoryByTabId'] {
  return mocks.store?.getState().structuredSessionLaunchDirectoryByTabId ?? {}
}

describe('StructuredAgentSessionStatusBridge pinned launch directory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.store?.setState({
      structuredSessionLaunchDirectoryByTabId: {},
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it('keeps the host-published pinned folder for the tab and drops it when the tab goes', async () => {
    const view = render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    emit({ type: 'snapshot', sessions: [summary({ launchDirectory: '/home/me/original' })] })

    expect(pins()).toEqual({
      [floatingTab.id]: { sessionId: 'session-1', launchDirectory: '/home/me/original' }
    })

    act(() => mocks.store?.setState({ unifiedTabsByWorktree: {} }))
    view.rerender(<StructuredAgentSessionStatusBridge />)
    expect(pins()).toEqual({})
  })

  it('records nothing when an older host omits the field', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    emit({ type: 'snapshot', sessions: [summary()] })

    expect(pins()).toEqual({})
  })

  it('never records a path published by a remote runtime', async () => {
    // The tab records the paired host that owns the chat.
    mocks.store?.setState({
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          { ...floatingTab, executionHostId: toRuntimeExecutionHostId('env-1') }
        ]
      }
    })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    emit({ type: 'snapshot', sessions: [summary({ launchDirectory: '/srv/remote/floating' })] })

    // The summary itself landed; only its path was withheld.
    expect(Object.keys(mocks.store?.getState().agentStatusByPaneKey ?? {})).toHaveLength(1)
    expect(pins()).toEqual({})
  })
})
