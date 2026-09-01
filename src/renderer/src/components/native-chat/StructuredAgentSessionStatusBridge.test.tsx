// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  removeAgentStatus: vi.fn(),
  setAgentStatus: vi.fn(),
  store: null as null | {
    getState: () => Record<string, unknown>
    setState: (state: Record<string, unknown>) => void
  },
  subscribe: vi.fn(),
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

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))

import {
  getStructuredAgentSessionTabs,
  StructuredAgentSessionStatusBridge
} from './StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionReadOwnersForTests } from './structured-agent-session-read-owner'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'

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

const userItem = {
  itemId: 'item-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
} as const

const historyResult = {
  ok: true,
  providerSession: { key: 'session_id', id: '01a002e9-9a1c-7d42-a642-e481f64446f1' },
  page: {
    sessionId: 'session-1',
    epoch: 'epoch-1',
    fence: 1,
    direction: 'tail',
    items: [userItem],
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: { epoch: 'epoch-1', sequence: 1 },
      newest: { epoch: 'epoch-1', sequence: 1 },
      nextCursor: { epoch: 'epoch-1', sequence: 1 }
    },
    liveCursor: { epoch: 'epoch-1', sequence: 1 },
    hasOlder: false,
    hasNewer: false
  }
}

function ActiveSessionRead(): null {
  useStructuredAgentSessionRead({
    sessionId: structuredTab.entityId,
    target: { kind: 'local' },
    isVisible: true
  })
  return null
}

function ActiveComposition(): React.JSX.Element {
  return (
    <>
      <ActiveSessionRead />
      <StructuredAgentSessionStatusBridge />
    </>
  )
}

describe('StructuredAgentSessionStatusBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionReadOwnersForTests()
    mocks.call.mockResolvedValue(historyResult)
    mocks.subscribe.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.store?.setState({
      agentStatusByPaneKey: {},
      testRuntimeOwner: null,
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionReadOwnersForTests()
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

  it('keeps restored inactive tabs transport-neutral', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await act(() => Promise.resolve())

    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.setAgentStatus).not.toHaveBeenCalled()
  })

  it('shares the visible pane subscriber with status projection', async () => {
    render(<ActiveComposition />)

    await waitFor(() => expect(mocks.setAgentStatus).toHaveBeenCalledOnce())
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.subscribe).toHaveBeenCalledOnce()
    expect(mocks.setAgentStatus.mock.calls[0]?.[5]).toEqual({
      providerSession: historyResult.providerSession,
      terminalResumeEligible: false
    })
  })

  it('keeps the status map reference stable for coalesced assistant deltas', async () => {
    render(<ActiveComposition />)
    await waitFor(() => expect(mocks.setAgentStatus).toHaveBeenCalledOnce())
    const before = mocks.store?.getState().agentStatusByPaneKey
    const onEvent = mocks.subscribe.mock.calls[0]?.[2] as (event: unknown) => void

    act(() => {
      for (let sequence = 2; sequence <= 12; sequence += 1) {
        onEvent({
          type: 'batch',
          sessionId: 'session-1',
          batch: {
            cursor: { epoch: 'epoch-1', sequence },
            items: [
              {
                itemId: 'assistant-1',
                revision: sequence,
                sequence,
                observedAt: sequence,
                body: {
                  kind: 'message',
                  role: 'assistant',
                  blocks: [{ type: 'text', text: `delta-${sequence}` }]
                }
              }
            ],
            removedItemIds: [],
            submissions: []
          }
        })
      }
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)))

    expect(mocks.setAgentStatus).toHaveBeenCalledOnce()
    expect(mocks.store?.getState().agentStatusByPaneKey).toBe(before)
  })

  it('does not project an unknown provider as Codex', async () => {
    mocks.store?.setState({
      unifiedTabsByWorktree: {
        'wt-1': [{ ...structuredTab, agentSessionAgent: 'gemini' }]
      }
    })
    render(<StructuredAgentSessionStatusBridge />)
    await act(() => Promise.resolve())

    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.setAgentStatus).not.toHaveBeenCalled()
  })
})
