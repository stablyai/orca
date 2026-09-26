// @vitest-environment happy-dom

// End to end for A1: a frame off the host's turn-completion stream lights the unread indicators
// and sends one OS notification for a structured chat whose transcript is not on screen.
// Everything between the wire and the store is real here — the renderer feed, the neutral
// attention policy, the structured surface adapter, the store reducers and the delivery tail — so
// only the transport and the preload bridge are mocks.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentJournalTurnOutcome } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../../shared/agent-session-wire'
import type { NotificationDispatchRequest } from '../../../../shared/notification-settings-types'
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
  statusEmitters: ((event: AgentSessionStatusEvent) => void)[]
  subscribeCompletions: Mock
  subscribeStatus: Mock
  supportsCapability: Mock
  unsubscribe: Mock
}

const mocks = vi.hoisted<BridgeMocks>(() => ({
  store: null,
  emitters: [],
  statusEmitters: [],
  subscribeCompletions: vi.fn(),
  subscribeStatus: vi.fn(),
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
  subscribeStructuredAgentSessionTurnCompletions: mocks.subscribeCompletions,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { StructuredAgentSessionAttentionBridge } from './StructuredAgentSessionAttentionBridge'
import { resetStructuredAgentSessionTurnCompletionFeedsForTests } from '@/runtime/structured-agent-session-turn-completion-feed'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'
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

function turnCompletion(
  sessionId = SESSION,
  outcome: AgentJournalTurnOutcome = 'success'
): AgentSessionTurnCompletion {
  return {
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

function completionFrame(
  sessionId = SESSION,
  outcome: AgentJournalTurnOutcome = 'success'
): AgentSessionTurnCompletionEvent {
  return { type: 'completion', completion: turnCompletion(sessionId, outcome) }
}

/** A host that predates the outcome field, which the current wire type makes required. */
function completionFrameWithoutOutcome(): AgentSessionTurnCompletionEvent {
  const completion = turnCompletion()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an older sender omits a field the wire type requires, which no checked type can express.
  delete (completion as { outcome?: AgentJournalTurnOutcome }).outcome
  return { type: 'completion', completion }
}

/** Every request the renderer handed the preload notification bridge, in order. */
const dispatched: NotificationDispatchRequest[] = []
/** Every retirement an acknowledgement asked main for, in order. */
const dismissed: { ids: string[]; paneKeys?: string[] }[] = []

/** The single dispatch a settled turn is allowed to make. */
function onlyDispatch(): NotificationDispatchRequest {
  expect(dispatched).toHaveLength(1)
  const request = dispatched[0]
  if (!request) {
    throw new Error('unreachable: length asserted above')
  }
  return request
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
    dispatched.length = 0
    dismissed.length = 0
    // happy-dom makes globalThis the window, so this is `window.api` as the delivery tail reads it.
    vi.stubGlobal('api', {
      // Settling a working row queues a PR refresh that reads this.
      gh: {},
      notifications: {
        dispatch: (request: NotificationDispatchRequest) => {
          dispatched.push(request)
          return Promise.resolve({ delivered: true })
        },
        dismiss: (ids: string[], paneKeys?: string[]) => {
          dismissed.push({ ids, paneKeys })
          return Promise.resolve({ dismissed: 0 })
        }
      }
    })
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.emitters.length = 0
    mocks.statusEmitters.length = 0
    mocks.subscribeStatus.mockImplementation(
      (_target: unknown, emit: (event: AgentSessionStatusEvent) => void) => {
        mocks.statusEmitters.push(emit)
        return Promise.resolve({ unsubscribe: vi.fn() })
      }
    )
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
    vi.unstubAllGlobals()
    resetStructuredAgentSessionTurnCompletionFeedsForTests()
    resetStructuredAgentSessionStatusFeedsForTests()
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
    expect(onlyDispatch()).toMatchObject({
      source: 'agent-task-complete',
      surface: 'agent-session',
      worktreeId: WORKSPACE,
      paneKey: CHAT_SUBJECT,
      agentState: 'done',
      agentTurnOutcome: 'success'
    })
  })

  // A settled turn is news whichever way it settled, exactly as the CLI lane treats one. The
  // difference is wording, which main picks from the verdict.
  it.each(['failure', 'cancellation'] as const)(
    'lights the indicators and hands main the %s the host reports',
    async (outcome) => {
      render(<StructuredAgentSessionAttentionBridge />)
      await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())

      act(() => hostStream()(completionFrame(SESSION, outcome)))

      expect(indicators()).toEqual({
        workspaceBold: true,
        paneDot: 'agent-completion',
        tabDot: 'agent-completion'
      })
      expect(onlyDispatch()).toMatchObject({ agentState: 'done', agentTurnOutcome: outcome })
    }
  )

  // The row's start moves after the banner is minted: a completion can outrun the settled
  // re-projection (working -> done), and a settled row is re-stamped with no history entry by any
  // later journal row, such as the status note a cancel appends (done -> done).
  it.each(['working', 'done'] as const)(
    'retires the banner it raised after a %s row moves its start',
    async (rowStateAtDispatch) => {
      mocks.store
        ?.getState()
        .setAgentStatus(
          CHAT_SUBJECT,
          { state: rowStateAtDispatch, prompt: 'Stop that', agentType: 'claude' },
          'Chat',
          { updatedAt: 1_000, stateStartedAt: 1_000 },
          { tabId: CHAT_TAB, worktreeId: WORKSPACE }
        )
      render(<StructuredAgentSessionAttentionBridge />)
      await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())

      act(() => hostStream()(completionFrame(SESSION, 'cancellation')))
      const raised = onlyDispatch()
      expect(raised).toMatchObject({ paneKey: CHAT_SUBJECT, notificationId: expect.any(String) })
      mocks.store
        ?.getState()
        .setAgentStatus(
          CHAT_SUBJECT,
          { state: 'done', prompt: 'Stop that', agentType: 'claude' },
          'Chat',
          { updatedAt: 2_000, stateStartedAt: 2_000, allowOlderTimestamp: true },
          { tabId: CHAT_TAB, worktreeId: WORKSPACE }
        )
      expect(mocks.store?.getState().agentStatusByPaneKey[CHAT_SUBJECT]?.stateStartedAt).toBe(2_000)

      mocks.store?.getState().acknowledgeAgents([CHAT_SUBJECT])

      // The id rebuilt from the moved row can no longer name the banner; main retires it by the
      // subject it was announced under, which is what this request must carry.
      expect(dismissed.flatMap(({ ids }) => ids)).not.toContain(raised.notificationId)
      expect(dismissed.flatMap(({ paneKeys }) => paneKeys ?? [])).toContain(CHAT_SUBJECT)
    }
  )

  // Remote clients receive the status and completion streams over separate sockets, unordered, so
  // the wording must come from the completion alone. The mirror is set to disagree in each case.
  function mirrorStatus(status: 'idle' | 'attention'): void {
    mocks.statusEmitters[0]?.({
      type: 'status',
      session: {
        sessionId: SESSION,
        workspaceId: 'host-side-workspace',
        agent: 'claude',
        status,
        latestPrompt: 'Ship it',
        updatedAt: 1
      }
    })
  }

  it.each([
    { awaitingUser: true, mirror: 'idle', agentState: 'blocked' },
    { awaitingUser: undefined, mirror: 'attention', agentState: 'done' }
  ] as const)(
    'words awaitingUser=$awaitingUser as $agentState whatever the status mirror says ($mirror)',
    async ({ awaitingUser, mirror, agentState }) => {
      const stopStatus = getStructuredAgentSessionStatusFeed({ kind: 'local' }).activate()
      render(<StructuredAgentSessionAttentionBridge />)
      await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())
      await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
      const completion = turnCompletion()

      act(() => {
        mirrorStatus(mirror)
        hostStream()({
          type: 'completion',
          completion: awaitingUser ? { ...completion, awaitingUser } : completion
        })
      })

      expect(indicators().paneDot).toBe('agent-completion')
      expect(onlyDispatch()).toMatchObject({ agentState, agentTurnOutcome: 'success' })
      stopStatus()
    }
  )

  it('lights nothing for a turn whose outcome the host never stated', async () => {
    render(<StructuredAgentSessionAttentionBridge />)
    await waitFor(() => expect(mocks.subscribeCompletions).toHaveBeenCalledOnce())

    act(() => hostStream()(completionFrameWithoutOutcome()))

    expect(indicators()).toEqual({ workspaceBold: false, paneDot: undefined, tabDot: undefined })
    expect(dispatched).toEqual([])
  })

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
