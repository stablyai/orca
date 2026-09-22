// @vitest-environment happy-dom

// End to end for A1: a frame off the host's turn-completion stream lights the unread indicators
// for a structured chat whose transcript is not on screen. Everything between the wire and the
// store is real here — the renderer feed, the neutral attention policy, the structured surface
// adapter and the store reducers — so only the transport itself is a mock.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentJournalTurnOutcome } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../../../shared/agent-session-wire'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState> & { testRuntimeOwner?: string | null }) => void
}
type BridgeMocks = {
  store: TestStore | null
  emitters: ((event: AgentSessionTurnCompletionEvent) => void)[]
  subscribeCompletions: Mock
  supportsCapability: Mock
  unsubscribe: Mock
}

const mocks = vi.hoisted<BridgeMocks>(() => ({
  store: null,
  emitters: [],
  subscribeCompletions: vi.fn(),
  supportsCapability: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
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
  subscribeStructuredAgentSessionTurnCompletions: mocks.subscribeCompletions
}))

import { StructuredAgentSessionAttentionBridge } from './StructuredAgentSessionAttentionBridge'
import { resetStructuredAgentSessionTurnCompletionFeedsForTests } from '@/runtime/structured-agent-session-turn-completion-feed'
import {
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'

// Worktree ids encode their repo (`repoId::path`); the unread reducer buckets by that prefix.
const WORKSPACE = 'repo1::/tmp/wt'
const GROUP = 'group-1'
const CHAT_TAB = 'chat-tab'
const SESSION = 'session-1'
const CHAT_SUBJECT = structuredAgentSessionPaneKey(CHAT_TAB, SESSION)

function chatTab(overrides: Partial<Tab> = {}): Tab {
  return makeUnifiedTab({
    id: CHAT_TAB,
    worktreeId: WORKSPACE,
    groupId: GROUP,
    contentType: 'agent-session',
    entityId: SESSION,
    agentSessionAgent: 'claude',
    ...overrides
  })
}

function completionFrame(
  sessionId = SESSION,
  outcome: AgentJournalTurnOutcome = 'success'
): AgentSessionTurnCompletionEvent {
  return {
    type: 'completion',
    completion: {
      scope: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'host-side-workspace',
        workspaceKind: 'git-worktree'
      },
      sessionId,
      turnId: `turn-for-${sessionId}`,
      outcome,
      completedAt: 1
    }
  }
}

/** The host side of a turn-completion subscription the bridge opened. */
function hostStream(index = 0): (event: AgentSessionTurnCompletionEvent) => void {
  const emit = mocks.emitters[index]
  if (!emit) {
    throw new Error(`completion stream ${index} not subscribed; opened ${mocks.emitters.length}`)
  }
  return emit
}

function indicators(): Record<string, unknown> {
  const state = mocks.store?.getState()
  return {
    workspaceBold: state?.worktreesByRepo.repo1?.[0]?.isUnread === true,
    paneDot: state?.unreadAgentCompletionPanes[CHAT_SUBJECT],
    tabDot: state?.unreadTerminalTabs[CHAT_TAB]
  }
}

describe('StructuredAgentSessionAttentionBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    mocks.emitters.length = 0
    mocks.subscribeCompletions.mockImplementation(
      (_target: unknown, emit: (event: AgentSessionTurnCompletionEvent) => void) => {
        mocks.emitters.push(emit)
        return Promise.resolve({ unsubscribe: mocks.unsubscribe })
      }
    )
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.store?.setState({
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1' })] },
      unifiedTabsByWorktree: { [WORKSPACE]: [chatTab()] },
      groupsByWorktree: {
        [WORKSPACE]: [
          makeTabGroup({
            id: GROUP,
            worktreeId: WORKSPACE,
            activeTabId: CHAT_TAB,
            tabOrder: [CHAT_TAB]
          })
        ]
      },
      activeGroupIdByWorktree: { [WORKSPACE]: GROUP },
      // The user is working elsewhere — the case the dot exists for.
      activeWorktreeId: 'other-workspace',
      unreadTerminalTabs: {},
      unreadTerminalPanes: {},
      unreadAgentCompletionPanes: {},
      testRuntimeOwner: null,
      // The attention dispatch reads exactly one field; GlobalSettings has no test factory.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only field read.
      settings: { experimentalTerminalAttention: true } as GlobalSettings
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
  })

  it('lights the unread indicators when the host reports a successful turn', async () => {
    render(<StructuredAgentSessionAttentionBridge />)
    await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())
    expect(indicators()).toEqual({ workspaceBold: false, paneDot: undefined, tabDot: undefined })

    act(() => hostStream()(completionFrame()))

    expect(indicators()).toEqual({
      workspaceBold: true,
      paneDot: 'agent-completion',
      tabDot: 'agent-completion'
    })
  })

  it.each(['failure', 'cancellation'] as const)(
    'lights nothing for a %s the host reports',
    async (outcome) => {
      render(<StructuredAgentSessionAttentionBridge />)
      await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())

      act(() => hostStream()(completionFrame(SESSION, outcome)))

      expect(indicators()).toEqual({ workspaceBold: false, paneDot: undefined, tabDot: undefined })
    }
  )

  it('ignores a completion for another session on the same host', async () => {
    render(<StructuredAgentSessionAttentionBridge />)
    await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())

    act(() => hostStream()(completionFrame('session-elsewhere')))

    expect(indicators()).toEqual({ workspaceBold: false, paneDot: undefined, tabDot: undefined })
  })

  it('shares one host stream across tabs and routes each completion to its own tab', async () => {
    const secondTab = chatTab({ id: 'chat-tab-2', entityId: 'session-2' })
    mocks.store?.setState({ unifiedTabsByWorktree: { [WORKSPACE]: [chatTab(), secondTab] } })
    render(<StructuredAgentSessionAttentionBridge />)
    await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())

    act(() => hostStream()(completionFrame('session-2')))

    const state = mocks.store?.getState()
    expect(state?.unreadAgentCompletionPanes).toEqual({
      [structuredAgentSessionPaneKey('chat-tab-2', 'session-2')]: 'agent-completion'
    })
  })

  it('does not subscribe a remote host that lacks the capability', async () => {
    mocks.supportsCapability.mockResolvedValue(false)
    mocks.store?.setState({ testRuntimeOwner: 'env-1' })
    render(<StructuredAgentSessionAttentionBridge />)
    await act(() => Promise.resolve())

    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-1',
      'agent-session.turn-completion.v1'
    )
    expect(mocks.subscribeCompletions).not.toHaveBeenCalled()
  })

  it('drops the host stream when the last structured tab closes', async () => {
    render(<StructuredAgentSessionAttentionBridge />)
    await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())

    act(() => mocks.store?.setState({ unifiedTabsByWorktree: { [WORKSPACE]: [] } }))

    await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledOnce())
  })

  it('replays nothing after a reconnect, so a completion missed while down stays missed', async () => {
    vi.useFakeTimers()
    try {
      render(<StructuredAgentSessionAttentionBridge />)
      await act(() => Promise.resolve())
      expect(mocks.subscribeCompletions).toHaveBeenCalledOnce()

      act(() => hostStream()({ type: 'end' }))
      await act(() => vi.advanceTimersByTimeAsync(5_000))
      expect(mocks.subscribeCompletions).toHaveBeenCalledTimes(2)

      // The reopened stream starts empty. Nothing lights until the host sends something NEW,
      // which is the whole recovery contract: live-only, no catch-up, no replayed dot.
      expect(indicators()).toEqual({ workspaceBold: false, paneDot: undefined, tabDot: undefined })
      act(() => hostStream(1)(completionFrame()))
      expect(indicators().paneDot).toBe('agent-completion')
    } finally {
      vi.useRealTimers()
    }
  })
})
