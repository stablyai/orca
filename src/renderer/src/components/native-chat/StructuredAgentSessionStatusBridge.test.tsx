// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import { buildSubagentChildRows } from '../sidebar/worktree-subagent-child-rows'
import { resolveAttention } from '../sidebar/smart-attention'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  removeAgentStatus: vi.fn(),
  setAgentStatus: vi.fn(),
  store: null as null | {
    getState: () => AppState
    setState: (state: Partial<AppState> & { testRuntimeOwner?: string | null }) => void
  },
  subscribeStatus: vi.fn(),
  subscribeTranscript: vi.fn(),
  supportsCapability: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  const { setAgentStatus, removeAgentStatus } = useAppStore.getState()
  useAppStore.setState({
    setAgentStatus: (...args) => {
      mocks.setAgentStatus(...args)
      setAgentStatus(...args)
    },
    removeAgentStatus: (paneKey) => {
      mocks.removeAgentStatus(paneKey)
      removeAgentStatus(paneKey)
    }
  })
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
    hostExecutionOwned: true,
    latestPrompt: 'hello',
    providerSession,
    updatedAt: 1,
    ...overrides
  }
}

function statuses(): AgentStatusEntry[] {
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
      // PR 2b: the LOCAL host publishes its own sessions over `agentStatus:set`, so the bridge
      // no longer writes for them. What it still owns is a session on a remote runtime, whose
      // store nothing mirrors down — that is the lane these cases drive.
      testRuntimeOwner: 'env-1',
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
    expect(feed().target).toEqual({ kind: 'environment', environmentId: 'env-1' })
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
  it('keeps host-held working evidence active past the normal freshness window', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    const updatedAt = Date.now() - 30 * 60 * 1000 - 1
    act(() => feed().emit({ type: 'status', session: summary({ updatedAt }) }))
    const entry = statuses()[0]
    expect(entry).toEqual(expect.objectContaining({ state: 'working', structuredHostOwned: true }))
    expect(isExplicitAgentStatusFresh(entry, Date.now(), 30 * 60 * 1000)).toBe(true)
  })

  it('clears host-held evidence when the status stream disconnects', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed().emit({ type: 'status', session: summary() }))
    expect(statuses()).toHaveLength(1)
    act(() => feed().emit({ type: 'end' }))
    expect(statuses()).toHaveLength(1)
    expect(statuses()[0]).not.toHaveProperty('structuredHostOwned')
  })

  it('maps each host status onto the sidebar agent state', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed().emit({ type: 'snapshot', sessions: [summary()] }))
    expect(statuses()).toEqual([expect.objectContaining({ state: 'working' })])

    act(() => feed().emit({ type: 'status', session: summary({ status: 'idle', updatedAt: 2 }) }))
    expect(statuses()).toEqual([
      expect.objectContaining({ state: 'done', sessionBoundary: false, stateStartedAt: 2 })
    ])

    act(() =>
      feed().emit({ type: 'status', session: summary({ status: 'attention', updatedAt: 3 }) })
    )
    expect(statuses()).toEqual([expect.objectContaining({ state: 'blocked' })])
  })

  it('publishes agent-kind background tasks as the sidebar subagent children', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    act(() =>
      feed().emit({
        type: 'snapshot',
        sessions: [
          summary({
            backgroundTasks: [
              {
                id: 'child-1',
                kind: 'agent',
                name: 'deep_review',
                description: 'Review the diff',
                state: 'working',
                startedAt: 500
              },
              // A backgrounded shell is not a subagent; kinds stay distinct.
              { id: 'shell-1', kind: 'command', description: 'sleep 180', state: 'working' }
            ]
          })
        ]
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({
        subagents: [
          {
            id: 'child-1',
            state: 'working',
            startedAt: 500,
            agentType: 'deep_review',
            description: 'Review the diff'
          }
        ]
      })
    ])

    // An unchanged roster must not rewrite the store.
    const writes = mocks.setAgentStatus.mock.calls.length
    act(() =>
      feed().emit({
        type: 'status',
        session: summary({
          backgroundTasks: [
            {
              id: 'child-1',
              kind: 'agent',
              name: 'deep_review',
              description: 'Review the diff',
              state: 'working',
              startedAt: 500
            },
            { id: 'shell-1', kind: 'command', description: 'sleep 180', state: 'working' }
          ]
        })
      })
    )
    expect(mocks.setAgentStatus.mock.calls.length).toBe(writes)

    act(() =>
      feed().emit({
        type: 'status',
        session: summary({
          updatedAt: 2,
          backgroundTasks: [
            { id: 'child-1', kind: 'agent', name: 'deep_review', state: 'waiting', startedAt: 500 }
          ]
        })
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({
        subagents: [expect.objectContaining({ id: 'child-1', state: 'waiting' })]
      })
    ])

    act(() =>
      feed().emit({
        type: 'status',
        session: summary({
          updatedAt: 3,
          backgroundTasks: [{ id: 'child-1', kind: 'agent', state: 'unverifiable' }]
        })
      })
    )
    expect(
      buildSubagentChildRows({
        parentEntry: statuses()[0],
        tab: structuredTab as never,
        parentIsFresh: true
      })[0]?.state
    ).toBe('unverifiable')

    // A summary without tasks ends the fan-out: children clear with it.
    act(() => feed().emit({ type: 'status', session: summary({ status: 'idle', updatedAt: 4 }) }))
    expect(statuses()).toEqual([expect.objectContaining({ subagents: undefined })])
  })

  it('keeps quiet live children authoritative and reconfirms them per session after reconnect', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    const live = summary({ backgroundTasks: [{ id: 'child', kind: 'agent', state: 'working' }] })
    const childState = () =>
      buildSubagentChildRows({
        parentEntry: statuses()[0],
        tab: structuredTab as never,
        parentIsFresh: false
      })[0]?.state
    act(() => feed().emit({ type: 'snapshot', sessions: [live] }))
    // A hook's evidence window has expired, but the host has not retracted its live task.
    expect(childState()).toBe('working')
    act(() => feed().emit({ type: 'end' }))
    expect(childState()).toBe('unverifiable')
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
    act(() => feed(1).emit({ type: 'snapshot', sessions: [] }))
    expect(childState()).toBe('unverifiable')
    act(() => feed(1).emit({ type: 'status', session: live }))
    expect(childState()).toBe('working')
    const writes = mocks.setAgentStatus.mock.calls.length
    act(() => feed(1).emit({ type: 'status', session: live }))
    expect(mocks.setAgentStatus).toHaveBeenCalledTimes(writes)
    act(() => feed(1).emit({ type: 'status', session: summary({ backgroundTasks: [] }) }))
    expect(childState()).toBeUndefined()
  })

  it('carries the model, the running tool line, and the last assistant message', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    act(() =>
      feed().emit({
        type: 'snapshot',
        sessions: [
          summary({
            model: 'gpt-5-codex',
            toolName: 'shell',
            toolInput: 'pnpm test',
            lastAssistantMessage: 'Running the suite now.'
          })
        ]
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({
        model: 'gpt-5-codex',
        toolName: 'shell',
        toolInput: 'pnpm test',
        lastAssistantMessage: 'Running the suite now.'
      })
    ])

    // The tool line describes live work, so a settled turn that omits it must clear it.
    act(() =>
      feed().emit({
        type: 'status',
        session: summary({
          status: 'idle',
          updatedAt: 2,
          model: 'gpt-5-codex',
          lastAssistantMessage: 'Suite is green.'
        })
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({
        state: 'done',
        model: 'gpt-5-codex',
        lastAssistantMessage: 'Suite is green.'
      })
    ])
    expect(statuses()[0]?.toolName).toBeUndefined()
    expect(statuses()[0]?.toolInput).toBeUndefined()

    // Only the message moves here, so the row updates only if the guard compares it.
    act(() =>
      feed().emit({
        type: 'status',
        session: summary({
          status: 'idle',
          updatedAt: 3,
          model: 'gpt-5-codex',
          lastAssistantMessage: 'Suite is green — 412 passed.'
        })
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({ lastAssistantMessage: 'Suite is green — 412 passed.' })
    ])
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
      for (let repeat = 0; repeat < 10; repeat += 1) {
        feed().emit({ type: 'status', session: summary() })
      }
    })

    expect(mocks.setAgentStatus).toHaveBeenCalledOnce()
    expect(mocks.store?.getState().agentStatusByPaneKey).toBe(before)
  })

  it.each(['claude', 'codex'] as const)(
    'sorts restored %s completions by host time and holds the completion across republishes',
    async (agent) => {
      const now = Date.now()
      mocks.store?.setState({
        unifiedTabsByWorktree: { 'wt-1': [{ ...structuredTab, agentSessionAgent: agent }] }
      })
      render(<StructuredAgentSessionStatusBridge />)
      await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
      act(() =>
        feed().emit({
          type: 'snapshot',
          sessions: [summary({ status: 'idle', updatedAt: now - 100 })]
        })
      )
      expect(statuses()).toEqual([
        expect.objectContaining({
          state: 'done',
          sessionBoundary: false,
          stateStartedAt: now - 100,
          updatedAt: now - 100
        })
      ])
      act(() =>
        feed().emit({ type: 'status', session: summary({ status: 'idle', updatedAt: now - 50 }) })
      )
      // A settled session whose journal keeps moving has not completed again: `stateStartedAt` is
      // the start of the state the row is in, and `agentEntryCompletionAt` reads it as the
      // completion. The host writer has always held it; this is the same rule.
      expect(statuses()).toEqual([
        expect.objectContaining({ stateStartedAt: now - 100, updatedAt: now - 50 })
      ])
      expect(
        resolveAttention([{ kind: 'hook', entry: statuses()[0], hasLivePty: false }], now)
      ).toEqual({ cls: 2, attentionTimestamp: now - 100 })
    }
  )

  it('preserves the working age when host metadata advances during the same turn', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed().emit({ type: 'status', session: summary({ updatedAt: 100 }) }))
    act(() =>
      feed().emit({
        type: 'status',
        session: summary({ updatedAt: 200, providerSession: { ...providerSession, id: 'new-id' } })
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({ state: 'working', updatedAt: 200, stateStartedAt: 100 })
    ])
  })

  it('accepts an authoritative older journal age after a host upgrade reconnect', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed().emit({ type: 'status', session: summary({ updatedAt: 800 }) }))
    act(() =>
      feed().emit({ type: 'snapshot', sessions: [summary({ status: 'idle', updatedAt: 900 })] })
    )
    const paneKey = statuses()[0].paneKey
    const history = statuses()[0].stateHistory
    const acknowledged = { [paneKey]: 950 }
    mocks.store?.setState({ acknowledgedAgentsByPaneKey: acknowledged })
    act(() =>
      feed().emit({ type: 'snapshot', sessions: [summary({ status: 'idle', updatedAt: 200 })] })
    )
    // The corrected age is accepted as the row's `updatedAt`; the completion clock stays put
    // because the state did not change, which is what the host writer does for every agent.
    expect(statuses()).toEqual([
      expect.objectContaining({ state: 'done', updatedAt: 200, stateStartedAt: 900 })
    ])
    const before = mocks.store?.getState().agentStatusByPaneKey
    const calls = mocks.setAgentStatus.mock.calls.length
    expect(statuses()[0].stateHistory).toBe(history)
    expect(mocks.store?.getState().acknowledgedAgentsByPaneKey).toBe(acknowledged)
    act(() =>
      feed().emit({ type: 'snapshot', sessions: [summary({ status: 'idle', updatedAt: 200 })] })
    )
    expect(mocks.store?.getState().agentStatusByPaneKey).toBe(before)
    expect(mocks.setAgentStatus).toHaveBeenCalledTimes(calls)
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

  // PR 2a: the host writes this same row through `ingestStructuredStatus`, keyed off the session id
  // alone. A mirrored session that collides with an occupied local id is re-hosted at
  // `${baseId}:history-N` (`web-session-tabs-sync/terminal-surfaces.ts`); keying on that surface id
  // gives one chat two rows once the IPC filter comes off, and the extra `:` makes the key
  // unparseable, which drops it from every sidebar bucket.
  it('keys a disambiguated mirrored surface on the host key for its session', async () => {
    mocks.store?.setState({
      unifiedTabsByWorktree: {
        'wt-1': [{ ...structuredTab, id: `${structuredAgentSessionTabId('session-1')}:history-1` }]
      }
    })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    act(() => feed().emit({ type: 'snapshot', sessions: [summary()] }))

    expect(statuses()).toHaveLength(1)
    expect(statuses()[0].paneKey).toBe(structuredAgentSessionPaneKey('session-1'))
    expect(parsePaneKey(statuses()[0].paneKey)).toMatchObject({
      tabId: structuredAgentSessionTabId('session-1')
    })
  })

  it('keeps one row while two surfaces mirror the same session', async () => {
    const historyTab = {
      ...structuredTab,
      id: `${structuredAgentSessionTabId('session-1')}:history-1`
    }
    mocks.store?.setState({ unifiedTabsByWorktree: { 'wt-1': [structuredTab, historyTab] } })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed().emit({ type: 'snapshot', sessions: [summary()] }))
    expect(statuses()).toHaveLength(1)

    // The surviving surface still owns the shared key, so the departing one must not clear it.
    act(() => mocks.store?.setState({ unifiedTabsByWorktree: { 'wt-1': [historyTab] } }))
    expect(statuses()).toHaveLength(1)

    act(() => mocks.store?.setState({ unifiedTabsByWorktree: { 'wt-1': [] } }))
    expect(statuses()).toEqual([])
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

  // PR 2b: main publishes the row for a locally hosted session and the IPC applicator applies it.
  // A second writer here would race the applicator on one pane key.
  it('writes nothing and opens no feed for a locally hosted session', async () => {
    mocks.store?.setState({ testRuntimeOwner: null })
    render(<StructuredAgentSessionStatusBridge />)
    await act(() => Promise.resolve())

    expect(mocks.subscribeStatus).not.toHaveBeenCalled()
    expect(mocks.setAgentStatus).not.toHaveBeenCalled()
    expect(statuses()).toEqual([])
  })

  // The host drops its own row on `agentSession.close`, but that goes through `dropStatusEntry`,
  // which emits no renderer clear — so the last surface to leave is still what takes this copy
  // out of the store, for a locally hosted session as much as a remote one.
  it('still clears a locally hosted row when its last surface leaves', async () => {
    mocks.store?.setState({
      testRuntimeOwner: null,
      agentStatusByPaneKey: {
        [structuredAgentSessionPaneKey('session-1')]: {
          paneKey: structuredAgentSessionPaneKey('session-1')
        } as AgentStatusEntry
      }
    })
    render(<StructuredAgentSessionStatusBridge />)
    await act(() => Promise.resolve())

    act(() => mocks.store?.setState({ unifiedTabsByWorktree: { 'wt-1': [] } }))

    expect(mocks.removeAgentStatus).toHaveBeenCalledWith(structuredAgentSessionPaneKey('session-1'))
    expect(statuses()).toEqual([])
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
