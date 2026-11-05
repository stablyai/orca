// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session/agent-session-wire'
import { buildSubagentChildRows } from '../sidebar/workspace-card/activity/worktree-subagent-child-rows'
import { hasSleepableWorkspaceActivity } from '../sidebar/workspace-actions/context-menu/workspace-lineage-menu-actions'
import { resolveAttention } from '../../../../shared/sidebar-list/smart-attention'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  setAgentStatus: vi.fn(),
  store: ((): {
    getState: () => AppState
    setState: (state: Partial<AppState>) => void
  } | null => null)(),
  subscribeStatus: vi.fn(),
  subscribeTranscript: vi.fn(),
  supportsCapability: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  const { setAgentStatus, transactAgentStatuses } = useAppStore.getState()
  useAppStore.setState({
    transactAgentStatuses: (operation) =>
      transactAgentStatuses((transaction) =>
        operation({
          ...transaction,
          apply: (update) => {
            if (update.kind === undefined || update.kind === 'status') {
              mocks.setAgentStatus(update)
            }
            return transaction.apply(update)
          }
        })
      ),
    setAgentStatus: (...args) => {
      mocks.setAgentStatus(...args)
      setAgentStatus(...args)
    }
  })
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: mocks.subscribeTranscript,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { useAppStore } from '@/store'

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
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.store?.setState({
      agentStatusByPaneKey: {},
      repos: [],
      worktreesByRepo: {},
      activeWorkspaceExecutionHostId: null,
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
    vi.useRealTimers()
  })

  // Test summary projection here; structured-agent-session-subscribers.test.ts covers real unsubscribed host liveness.
  it('keeps host-held working evidence active past the normal freshness window', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    const updatedAt = Date.now() - 30 * 60 * 1000 - 1
    act(() => feed().emit({ type: 'status', session: summary({ updatedAt }) }))
    const entry = statuses()[0]
    expect(entry).toEqual(expect.objectContaining({ state: 'working', structuredHostOwned: true }))
    expect(isExplicitAgentStatusFresh(entry, Date.now(), 30 * 60 * 1000)).toBe(true)
  })

  // Match hook semantics: live children keep the lead working; background shells keep it monitoring.
  it('keeps an idle session working while a subagent runs, and monitoring while a shell runs', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    act(() =>
      feed().emit({
        type: 'snapshot',
        sessions: [
          summary({
            status: 'idle',
            updatedAt: 1,
            backgroundTasks: [
              { id: 'child-1', kind: 'agent', state: 'working' },
              { id: 'shell-1', kind: 'command', state: 'working' }
            ]
          })
        ]
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({ state: 'working', workingMode: undefined, stateStartedAt: 1 })
    ])

    act(() =>
      feed().emit({
        type: 'status',
        session: summary({
          status: 'idle',
          updatedAt: 2,
          backgroundTasks: [
            { id: 'child-1', kind: 'agent', state: 'done' },
            { id: 'shell-1', kind: 'command', state: 'working' }
          ]
        })
      })
    )
    // Monitoring is its own displayed state, so its clock starts when the label does.
    expect(statuses()).toEqual([
      expect.objectContaining({ state: 'working', workingMode: 'monitoring', stateStartedAt: 2 })
    ])

    act(() =>
      feed().emit({
        type: 'status',
        session: summary({
          status: 'idle',
          updatedAt: 3,
          backgroundTasks: [
            { id: 'child-1', kind: 'agent', state: 'done' },
            { id: 'shell-1', kind: 'command', state: 'done' }
          ]
        })
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({ state: 'done', workingMode: undefined, stateStartedAt: 3 })
    ])
  })

  // A user turn restarts the working clock; a monitor’s age is not turn duration.
  it('restarts the state clock when monitoring becomes a real turn', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    act(() =>
      feed().emit({
        type: 'snapshot',
        sessions: [
          summary({
            status: 'idle',
            updatedAt: 1,
            backgroundTasks: [{ id: 'shell-1', kind: 'command', state: 'working' }]
          })
        ]
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({ state: 'working', workingMode: 'monitoring', stateStartedAt: 1 })
    ])

    act(() =>
      feed().emit({
        type: 'status',
        session: summary({
          status: 'working',
          updatedAt: 2_700_001,
          backgroundTasks: [{ id: 'shell-1', kind: 'command', state: 'working' }]
        })
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({
        state: 'working',
        workingMode: undefined,
        stateStartedAt: 2_700_001
      })
    ])
  })

  it('requires fresh parent evidence as well as a reconfirmed feed after reconnect', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    const live = summary({ backgroundTasks: [{ id: 'child', kind: 'agent', state: 'working' }] })
    let parentIsFresh = false
    const childState = () =>
      buildSubagentChildRows({
        parentEntry: statuses()[0],
        tab: structuredTab as never,
        parentIsFresh
      })[0]?.state
    act(() => feed().emit({ type: 'snapshot', sessions: [live] }))
    expect(childState()).toBe('unverifiable')
    parentIsFresh = true
    expect(childState()).toBe('working')
    act(() => feed().emit({ type: 'end' }))
    expect(childState()).toBe('unverifiable')
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
    act(() => feed(1).emit({ type: 'snapshot', sessions: [] }))
    expect(childState()).toBe('unverifiable')
    act(() => feed(1).emit({ type: 'status', session: live }))
    expect(childState()).toBe('working')
    parentIsFresh = false
    expect(childState()).toBe('unverifiable')
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

  it.each(['claude', 'codex'] as const)(
    'sorts restored %s completions by host time and advances identical turns',
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
      expect(statuses()).toEqual([
        expect.objectContaining({ stateStartedAt: now - 50, updatedAt: now - 50 })
      ])
      expect(
        resolveAttention([{ kind: 'hook', entry: statuses()[0], hasLivePty: false }], now)
      ).toEqual({ cls: 2, attentionTimestamp: now - 50 })
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
    expect(statuses()).toEqual([
      expect.objectContaining({ state: 'done', updatedAt: 200, stateStartedAt: 200 })
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

  it('keeps the host-fed chat row through Sleep and offers Sleep until its host marks the chat slept', async () => {
    const state = (): AppState => useAppStore.getState()
    const sleepable = (): boolean => hasSleepableWorkspaceActivity('wt-1', state())
    mocks.store?.setState({
      unifiedTabsByWorktree: { 'wt-1': [{ ...structuredTab, executionHostId: 'local' }] }
    })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed().emit({ type: 'status', session: summary({ status: 'idle', updatedAt: 2 }) }))
    const paneKey = statuses()[0].paneKey
    mocks.store?.setState({ acknowledgedAgentsByPaneKey: { [paneKey]: 3 } })
    expect(sleepable()).toBe(true)

    // Sleep's terminal teardown drops the worktree's rows before the host's revoke reaches the feed.
    act(() => state().dropAgentStatusByWorktree('wt-1', { shutdownReason: 'manual-sleep' }))
    expect(state().agentStatusByPaneKey[paneKey]).toEqual(
      expect.objectContaining({ state: 'done', structuredHostOwned: true })
    )
    act(() =>
      feed().emit({
        type: 'status',
        session: summary({ status: 'idle', updatedAt: 2, hostExecutionOwned: undefined })
      })
    )
    expect(statuses()).toEqual([expect.objectContaining({ state: 'done' })])
    expect(statuses()[0].structuredHostOwned).toBeUndefined()
    expect(state().acknowledgedAgentsByPaneKey).toEqual({ [paneKey]: 3 })
    // The host let go: only its Sleep mark stops offering Sleep, and the chat running again wakes it.
    expect(sleepable()).toBe(true)
    const slept = summary({
      status: 'idle',
      updatedAt: 2,
      hostExecutionOwned: undefined,
      sleptAt: 5
    })
    act(() => feed().emit({ type: 'status', session: slept }))
    expect(state().structuredChatSleptAtByPaneKey).toEqual({ [paneKey]: 5 })
    expect(sleepable()).toBe(false)
    act(() => feed().emit({ type: 'status', session: summary({ updatedAt: 3, sleptAt: 5 }) }))
    expect(Object.values(state().structuredChatSleptAtByPaneKey)).toEqual([null])
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
})

describe('the main agent fact the bridge writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.store?.setState({
      agentStatusByPaneKey: {},
      repos: [],
      worktreesByRepo: {},
      activeWorkspaceExecutionHostId: null,
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it('stamps the main agent beside the folded state, with its verdict and its own clock', async () => {
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())

    act(() =>
      feed().emit({
        type: 'snapshot',
        sessions: [
          summary({
            status: 'idle',
            updatedAt: 1,
            turnOutcome: 'cancellation',
            backgroundTasks: [{ id: 'shell-1', kind: 'command', state: 'working' }]
          })
        ]
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 1 }
      })
    ])

    // Draining shells settle monitoring without changing the main agent’s already-ended duration.
    act(() =>
      feed().emit({
        type: 'status',
        session: summary({ status: 'idle', updatedAt: 2, turnOutcome: 'cancellation' })
      })
    )
    expect(statuses()).toEqual([
      expect.objectContaining({
        state: 'done',
        stateStartedAt: 2,
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 1 }
      })
    ])
  })
})
