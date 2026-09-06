// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import type { Tab } from '../../../../shared/tab-types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  removeAgentStatus: vi.fn(),
  setAgentStatus: vi.fn(),
  store: null as null | {
    getState: () => Record<string, unknown>
    setState: (state: Record<string, unknown>) => void
  },
  subscribeStatus: vi.fn(),
  subscribeTranscript: vi.fn(),
  supportsCapability: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create<{
    agentStatusByPaneKey: Record<string, Record<string, unknown>>
    removeAgentStatus: (paneKey: string) => void
    setAgentStatus: (...args: unknown[]) => void
    testRuntimeOwner: string | null
    unifiedTabsByWorktree: Record<string, Tab[]>
  }>((set, get) => ({
    agentStatusByPaneKey: {},
    removeAgentStatus: (paneKey) => {
      mocks.removeAgentStatus(paneKey)
      if (!get().agentStatusByPaneKey[paneKey]) {
        return
      }
      const next = { ...get().agentStatusByPaneKey }
      delete next[paneKey]
      set({ agentStatusByPaneKey: next })
    },
    setAgentStatus: (...args) => {
      mocks.setAgentStatus(...args)
      const [paneKey, payload, terminalTitle, , routing, metadata] = args as [
        string,
        Record<string, unknown>,
        string,
        unknown,
        Record<string, unknown>,
        Record<string, unknown>
      ]
      set((state) => ({
        agentStatusByPaneKey: {
          ...state.agentStatusByPaneKey,
          [paneKey]: {
            ...payload,
            ...routing,
            ...metadata,
            paneKey,
            terminalTitle,
            updatedAt: Date.now(),
            stateStartedAt: Date.now(),
            stateHistory: []
          }
        }
      }))
    },
    testRuntimeOwner: null,
    unifiedTabsByWorktree: {}
  }))
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ?? null
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: mocks.subscribeTranscript,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import {
  getStructuredAgentSessionTabs,
  StructuredAgentSessionStatusBridge
} from './StructuredAgentSessionStatusBridge'
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

const providerSession = { key: 'session_id', id: '01a002e9-9a1c-7d42-a642-e481f64446f1' } as const

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'codex',
    status: 'working',
    latestPrompt: 'hello',
    providerSession,
    updatedAt: 1,
    ...overrides
  }
}

function statuses(): Record<string, unknown>[] {
  return Object.values(mocks.store?.getState().agentStatusByPaneKey ?? {})
}

/** The host side of the most recent status subscription. */
function feed(index = 0): { target: unknown; emit: (event: AgentSessionStatusEvent) => void } {
  const call = mocks.subscribeStatus.mock.calls[index]
  if (!call) {
    throw new Error('status feed not subscribed')
  }
  return { target: call[0], emit: call[1] as (event: AgentSessionStatusEvent) => void }
}

describe('StructuredAgentSessionStatusBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
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

  it('reuses the structured-tab projection for an unchanged tab map', () => {
    const secondStructuredTab = {
      ...structuredTab,
      id: 'structured-tab-2',
      entityId: 'session-2'
    }
    const tabsByWorktree: Record<string, Tab[]> = {
      'wt-1': [structuredTab],
      'wt-2': [secondStructuredTab]
    }

    const first = getStructuredAgentSessionTabs(tabsByWorktree)
    const second = getStructuredAgentSessionTabs(tabsByWorktree)

    expect(second).toBe(first)
    expect(second).toEqual([structuredTab, secondStructuredTab])

    const nextTabsByWorktree = {
      ...tabsByWorktree,
      'wt-3': [{ ...structuredTab, id: 'structured-tab-3', entityId: 'session-3' }]
    }
    expect(getStructuredAgentSessionTabs(nextTabsByWorktree)).toEqual([
      structuredTab,
      secondStructuredTab,
      nextTabsByWorktree['wt-3'][0]
    ])
  })

  it('projects the host status feed without opening a transcript reader', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    expect(feed().target).toEqual({ kind: 'local' })
    expect(mocks.subscribeTranscript).not.toHaveBeenCalled()

    act(() => feed().emit({ type: 'snapshot', sessions: [summary()] }))

    expect(statuses()).toEqual([
      expect.objectContaining({
        state: 'working',
        prompt: 'hello',
        agentType: 'codex',
        sessionBoundary: false,
        tabId: structuredTab.id,
        worktreeId: 'wt-1',
        terminalTitle: 'Codex Chat',
        terminalResumeEligible: false,
        providerSession
      })
    ])
  })

  // Hiddenness is the host's side of this: see structured-agent-session-subscribers.test.ts,
  // which drives an unsubscribed journal through the feed. Here the transport is a mock, so
  // only the summary-to-store mapping is under test.
  it('maps each host status onto the sidebar agent state', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed().emit({ type: 'snapshot', sessions: [summary()] }))
    expect(statuses()).toEqual([expect.objectContaining({ state: 'working' })])

    act(() => feed().emit({ type: 'status', session: summary({ status: 'idle', updatedAt: 2 }) }))
    expect(statuses()).toEqual([expect.objectContaining({ state: 'done', sessionBoundary: true })])

    act(() =>
      feed().emit({ type: 'status', session: summary({ status: 'attention', updatedAt: 3 }) })
    )
    expect(statuses()).toEqual([expect.objectContaining({ state: 'blocked' })])
  })

  it('shows no status before a persisted turn', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    act(() => feed().emit({ type: 'snapshot', sessions: [summary({ status: null })] }))
    expect(mocks.setAgentStatus).not.toHaveBeenCalled()

    act(() => feed().emit({ type: 'status', session: summary({ updatedAt: 2 }) }))
    expect(statuses()).toEqual([expect.objectContaining({ state: 'working' })])
  })

  it('keeps the status map reference stable for repeated equal summaries', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed().emit({ type: 'snapshot', sessions: [summary()] }))
    const before = mocks.store?.getState().agentStatusByPaneKey

    act(() => {
      for (let updatedAt = 2; updatedAt <= 12; updatedAt += 1) {
        feed().emit({ type: 'status', session: summary({ updatedAt }) })
      }
    })

    expect(mocks.setAgentStatus).toHaveBeenCalledOnce()
    expect(mocks.store?.getState().agentStatusByPaneKey).toBe(before)
  })

  it('drops the status and the feed when the last structured tab closes', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed().emit({ type: 'snapshot', sessions: [summary()] }))
    expect(statuses()).toHaveLength(1)

    act(() => mocks.store?.setState({ unifiedTabsByWorktree: { 'wt-1': [] } }))

    expect(statuses()).toEqual([])
    await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledOnce())
  })

  it('reconnects after the host ends the stream', async () => {
    vi.useFakeTimers()
    try {
      render(<StructuredAgentSessionStatusBridge />)
      await act(() => Promise.resolve())
      expect(mocks.subscribeStatus).toHaveBeenCalledOnce()

      act(() => feed().emit({ type: 'end' }))
      await act(() => vi.advanceTimersByTimeAsync(300))

      expect(mocks.unsubscribe).toHaveBeenCalledOnce()
      expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keys the feed by the worktree runtime environment', async () => {
    mocks.store?.setState({ testRuntimeOwner: 'env-1' })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    expect(feed().target).toEqual({ kind: 'environment', environmentId: 'env-1' })
  })

  it('does not project an unknown provider as Codex', async () => {
    mocks.store?.setState({
      unifiedTabsByWorktree: {
        'wt-1': [{ ...structuredTab, agentSessionAgent: 'gemini' }]
      }
    })
    render(<StructuredAgentSessionStatusBridge />)
    await act(() => Promise.resolve())

    expect(mocks.subscribeStatus).not.toHaveBeenCalled()
    expect(mocks.setAgentStatus).not.toHaveBeenCalled()
  })
})
