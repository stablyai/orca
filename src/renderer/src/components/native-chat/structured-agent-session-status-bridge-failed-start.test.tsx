// @vitest-environment happy-dom

// Refused creates publish no host session; bridge launch failures into tab/workspace rows until retry or closure.

import type * as LaunchErrors from '@/lib/structured-agent-session-launch-errors'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult,
  AgentSessionStatusEvent
} from '../../../../shared/agent-session-wire'
import { agentVerdictDisplayMark } from '../../../../shared/agent-main-agent-verdict'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import { structuredAgentSessionAgentStatus } from '../../../../shared/structured-agent-session-agent-status'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import type { AppState } from '@/store/types'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState> & { testRuntimeOwner?: string | null }) => void
}

const mocks = vi.hoisted(() => {
  const hoisted: {
    store: TestStore | null
    call: Mock
    history: Mock
    subscribeStatus: Mock
    unsubscribe: Mock
    createIntent: Mock
    retryIntent: Mock
    restoreIntent: Mock
    launch: Mock
  } = {
    store: null,
    call: vi.fn(),
    history: vi.fn(),
    subscribeStatus: vi.fn(),
    unsubscribe: vi.fn(),
    createIntent: vi.fn(),
    retryIntent: vi.fn(),
    restoreIntent: vi.fn(),
    launch: vi.fn()
  }
  return hoisted
})

import { useAppStore } from '@/store'
mocks.store = useAppStore

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local'
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.history,
  ensureRuntimeEnvironmentCompatible: async () => {}
}))

vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: vi.fn(async () => [])
}))

const launchErrorMocks = vi.hoisted(() => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return { StructuredAgentSessionCreateRefusalError }
})

vi.mock('@/lib/structured-agent-session-launch-errors', async () => ({
  ...(await vi.importActual<typeof LaunchErrors>('@/lib/structured-agent-session-launch-errors')),
  ...launchErrorMocks
}))

vi.mock('@/lib/structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: mocks.launch
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError:
      launchErrorMocks.StructuredAgentSessionCreateRefusalError
  }
})

import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import {
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from '@/lib/structured-agent-session-launch'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import {
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus
} from '../tab-bar/terminal-tab-activity-status'
import { selectWorktreeAgentActivitySummary } from '../sidebar/worktree-agent-activity-summary'
import { countActivityUnread } from '../activity/useActivityUnreadCount'

import { getDefaultSettings } from '../../../../shared/constants'
import {
  sendStructuredAgentSessionMessage,
  resetStructuredAgentSessionSendsForTests
} from './structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'
import {
  getStructuredAgentSessionReadOwner,
  findStructuredAgentSessionReadOwner
} from './structured-agent-session-read-owner'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

async function closeChat(skipRunningProcessConfirm = false): Promise<void> {
  const { createWorkspaceTabCloseCommands } =
    await import('../tab-group/workspace-tab-close-commands')
  createWorkspaceTabCloseCommands({
    worktreeId: WORKTREE_ID,
    groupTabs: [structuredTab]
  }).closeItem(structuredTab.id, { skipRunningProcessConfirm })
}

const WORKTREE_ID = 'wt-1'
const SESSION_ID = 'session-1'
const TAB_CREATED_AT = 1_000
const FAILED_AT = 10 * 60 * 60_000
const PANE_KEY = structuredAgentSessionPaneKey(`structured-agent-session-${SESSION_ID}`, SESSION_ID)

const structuredTab = {
  id: `structured-agent-session-${SESSION_ID}`,
  worktreeId: WORKTREE_ID,
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: SESSION_ID,
  label: 'Claude Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: TAB_CREATED_AT,
  isPinned: false,
  agentSessionAgent: 'claude',
  executionHostId: 'local'
} satisfies Tab

const intent: StructuredAgentSessionLaunchIntent = {
  worktreeId: WORKTREE_ID,
  sessionId: SESSION_ID,
  executionHostId: 'local',
  target: { kind: 'local' },
  agent: 'claude',
  params: {
    envelope: {
      sessionId: SESSION_ID,
      clientOperationId: 'operation-1',
      expectedRuntimeFence: null,
      payloadFingerprint: 'fingerprint-1'
    },
    worktree: `id:${WORKTREE_ID}`,
    agent: 'claude'
  }
}

function store(): TestStore {
  if (!mocks.store) {
    throw new Error('store missing')
  }
  return mocks.store
}

function rows(): AgentStatusEntry[] {
  return Object.values(store().getState().agentStatusByPaneKey)
}

function tabStatus(): string {
  const state = store().getState()
  return resolveTerminalTabActivityStatus({
    tab: { id: structuredTab.id, title: structuredTab.label, launchAgent: 'claude' },
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    agentStatusEpoch: state.agentStatusEpoch
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function connect(): Promise<(event: AgentSessionStatusEvent) => void> {
  render(<StructuredAgentSessionStatusBridge />)
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
  const emit: (event: AgentSessionStatusEvent) => void = mocks.subscribeStatus.mock.calls[0]?.[1]
  // The host never created the session, so it publishes nothing for it.
  act(() => emit({ type: 'snapshot', sessions: [] }))
  return (event) => act(() => emit(event))
}

/** Preserve saved launches/acknowledgments across restart; drop live rows and launch memory. */
async function restart(): Promise<void> {
  const { acknowledgedAgentsByPaneKey } = store().getState()
  cleanup()
  store().setState({ agentStatusByPaneKey: {}, acknowledgedAgentsByPaneKey })
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentSessionStatusFeedsForTests()
  resetTerminalTabActivityFlagsCacheForTest()
  mocks.subscribeStatus.mockClear()
  await connect()
}

function setClock(now: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(now)
}

function acknowledge(at: number): void {
  store().setState({ acknowledgedAgentsByPaneKey: { [PANE_KEY]: at } })
}

function unread(): number {
  return countActivityUnread(store().getState())
}

let failedStarts = 0

async function failStart(): Promise<void> {
  mocks.createIntent.mockReturnValueOnce(intent)
  mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))
  failedStarts += 1
  const launch = startStructuredAgentLaunch(WORKTREE_ID, 'claude', {
    requestId: `request-${failedStarts}`
  })
  await expect(launch.launchResult).rejects.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
  await flush()
}

const completeIdle: AgentSessionHistoryResult = {
  ok: true,
  page: {
    sessionId: SESSION_ID,
    epoch: 'e',
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: { epoch: 'e', sequence: 1 } },
    hasOlder: false,
    hasNewer: false,
    latestTurn: null,
    working: false,
    actionablePromptIds: [],
    backgroundTasks: null,
    nextQueuedMessageId: null
  }
}
const pendingClose = () =>
  useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
async function ready(mode = 'idle'): Promise<void> {
  const emit = await connect()
  emit({
    type: 'status',
    session: {
      sessionId: SESSION_ID,
      workspaceId: WORKTREE_ID,
      agent: 'claude',
      status: mode === 'idle' ? 'idle' : 'working',
      latestPrompt: '',
      updatedAt: 1
    }
  })
  store().setState({
    settings:
      mode === 'null settings'
        ? null
        : {
            ...getDefaultSettings('/tmp/pr-34236'),
            skipCloseTerminalWithRunningProcessConfirm: mode === 'opt-out'
          }
  })
  mocks.history.mockReset().mockResolvedValue(completeIdle)
}

describe('a chat whose start failed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentSessionStatusFeedsForTests()
    resetTerminalTabActivityFlagsCacheForTest()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.retryIntent.mockImplementation((prior: StructuredAgentSessionLaunchIntent) => prior)
    mocks.restoreIntent.mockReturnValue(intent)
    store().setState({
      agentStatusByPaneKey: {},
      acknowledgedAgentsByPaneKey: {},
      retainedAgentsByPaneKey: {},
      unifiedTabsByWorktree: { [WORKTREE_ID]: [structuredTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionSendsForTests()
    vi.useRealTimers()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    resetStructuredAgentSessionStatusFeedsForTests()
    vi.restoreAllMocks()
  })

  it('marks its tab and its workspace row failed', async () => {
    await connect()
    expect(rows()).toEqual([])

    await failStart()

    const [row] = rows()
    expect(row).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done', outcome: 'failure' },
      tabId: structuredTab.id,
      worktreeId: WORKTREE_ID,
      agentType: 'claude'
    })
    expect(row && agentVerdictDisplayMark(row)).toBe('failed')
    expect(tabStatus()).toBe('failed')
    expect(selectWorktreeAgentActivitySummary(store().getState(), WORKTREE_ID).hasFailed).toBe(true)
    const closed = vi.spyOn(store().getState(), 'closeUnifiedTab')
    await closeChat()
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
    expect(closed).toHaveBeenCalledExactlyOnceWith(structuredTab.id)
  })

  it('keeps monitoring-only child work active through the real status writer and close', async () => {
    const emit = await connect()
    emit({
      type: 'status',
      session: {
        sessionId: SESSION_ID,
        workspaceId: WORKTREE_ID,
        agent: 'claude',
        status: 'idle',
        latestPrompt: '',
        updatedAt: 1,
        backgroundTasks: [{ id: 'monitor', kind: 'command', state: 'monitoring' }]
      }
    })
    expect(rows()).toMatchObject([
      { state: 'working', workingMode: 'monitoring', mainAgent: { state: 'done' } }
    ])
    const closed = vi.spyOn(store().getState(), 'closeUnifiedTab')
    await closeChat()
    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
    ).not.toBeNull()
    expect(closed).not.toHaveBeenCalled()
  })

  it.each([undefined, 'ssh:gone'] as const)(
    'retires the raw %s reader on close and purge',
    (host) => {
      for (const remove of ['close', 'purge']) {
        const tab = { ...structuredTab, executionHostId: host }
        store().setState({ unifiedTabsByWorktree: { [WORKTREE_ID]: [tab] } })
        const owner = getStructuredAgentSessionReadOwner(SESSION_ID, null, host ?? '')
        const send = owner.trackSend('unknown')
        send.issue()
        send.settle(true)
        if (remove === 'close') {
          store().getState().closeUnifiedTab(tab.id)
        } else {
          store().getState().purgeWorktreeTerminalState([WORKTREE_ID])
        }
        expect(findStructuredAgentSessionReadOwner(SESSION_ID, null, host ?? '')).toBeUndefined()
      }
    }
  )

  it('drops the mark while a retry starts it, and leaves the started chat to the host', async () => {
    const emit = await connect()
    await failStart()
    expect(rows()).toHaveLength(1)

    let publish: (receipt: { sessionId: string; fence: number }) => void = () => {}
    mocks.launch.mockReturnValueOnce(new Promise((resolve) => (publish = resolve)))
    act(() => {
      retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)
    })
    await flush()
    expect(rows()).toEqual([])

    publish({ sessionId: SESSION_ID, fence: 1 })
    await flush()
    expect(rows()).toEqual([])
    emit({
      type: 'status',
      session: {
        sessionId: SESSION_ID,
        workspaceId: WORKTREE_ID,
        agent: 'claude',
        status: 'working',
        latestPrompt: 'hello',
        updatedAt: 50_000
      }
    })
    expect(rows()).toEqual([expect.objectContaining({ state: 'working' })])
  })

  it('drops the mark when its tab closes', async () => {
    await connect()
    await failStart()
    expect(rows()).toHaveLength(1)

    act(() => store().setState({ unifiedTabsByWorktree: { [WORKTREE_ID]: [] } }))
    await flush()

    expect(rows()).toEqual([])
  })

  it('stays read across a restart once seen, and a later failure is news again', async () => {
    setClock(FAILED_AT)
    await connect()
    await failStart()
    expect(rows()).toEqual([
      expect.objectContaining({ updatedAt: FAILED_AT, stateStartedAt: FAILED_AT })
    ])
    expect(unread()).toBe(1)
    setClock(FAILED_AT + 60_000)
    acknowledge(FAILED_AT + 60_000)
    expect(unread()).toBe(0)

    await restart()
    expect(rows()).toEqual([
      expect.objectContaining({ state: 'done', updatedAt: FAILED_AT, stateStartedAt: FAILED_AT })
    ])
    expect(unread()).toBe(0)
    expect(tabStatus()).toBe('failed')

    setClock(FAILED_AT + 120_000)
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))
    act(() => {
      retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)
    })
    await flush()
    expect(rows()).toEqual([
      expect.objectContaining({
        stateStartedAt: FAILED_AT + 120_000,
        mainAgent: expect.objectContaining({ outcome: 'failure' })
      })
    ])
    expect(unread()).toBe(1)
  })

  it('is unread after a restart when it failed after the chat was last viewed', async () => {
    setClock(FAILED_AT - 60_000)
    await connect()
    // Viewed while it was starting; it failed after the user looked away.
    acknowledge(FAILED_AT - 60_000)
    setClock(FAILED_AT)
    await failStart()
    expect(unread()).toBe(1)

    setClock(FAILED_AT + 60_000)
    await restart()
    expect(rows()).toEqual([expect.objectContaining({ stateStartedAt: FAILED_AT })])
    expect(unread()).toBe(1)
  })

  it('ages like a host-reported failure: a restart does not bring back an old mark', async () => {
    setClock(FAILED_AT)
    await connect()
    await failStart()
    expect(tabStatus()).toBe('failed')

    setClock(FAILED_AT + AGENT_STATUS_STALE_AFTER_MS + 1)
    await restart()
    expect(rows()).toEqual([expect.objectContaining({ updatedAt: FAILED_AT })])
    expect(tabStatus()).not.toBe('failed')
    expect(selectWorktreeAgentActivitySummary(store().getState(), WORKTREE_ID).hasFailed).toBe(
      false
    )
  })

  it('dates a retry that fails again by the new failure', async () => {
    setClock(FAILED_AT)
    await connect()
    await failStart()
    acknowledge(FAILED_AT + 1)
    expect(unread()).toBe(0)

    setClock(FAILED_AT + 60_000)
    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))
    act(() => {
      retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)
    })
    await flush()
    expect(rows()).toEqual([
      expect.objectContaining({ updatedAt: FAILED_AT + 60_000, stateStartedAt: FAILED_AT + 60_000 })
    ])
    expect(unread()).toBe(1)
  })

  it('re-dates a failed row the pane key already held by its own failure', async () => {
    setClock(FAILED_AT - 60_000)
    await connect()
    const { state, mainAgent } = structuredAgentSessionAgentStatus({
      status: 'idle',
      turnOutcome: 'failure'
    })
    act(() =>
      store()
        .getState()
        .setAgentStatus(
          PANE_KEY,
          {
            state,
            mainAgent: { ...mainAgent, stateStartedAt: FAILED_AT - 60_000 },
            interrupted: false,
            prompt: '',
            agentType: 'claude',
            sessionBoundary: false
          },
          structuredTab.label,
          undefined,
          { tabId: structuredTab.id, worktreeId: WORKTREE_ID }
        )
    )
    expect(rows()).toEqual([expect.objectContaining({ updatedAt: FAILED_AT - 60_000 })])

    setClock(FAILED_AT)
    await failStart()
    expect(rows()).toEqual([
      expect.objectContaining({ updatedAt: FAILED_AT, stateStartedAt: FAILED_AT })
    ])
  })
  it('warns during real issued send and accepted handoff before status arrives', async () => {
    await ready()
    noteStructuredAgentSessionFence(SESSION_ID, 4)
    const answer = Promise.withResolvers<AgentSessionMutationResult<AgentSessionSendResult>>()
    mocks.call.mockReturnValue(answer.promise)
    const sent = sendStructuredAgentSessionMessage({
      sessionId: SESSION_ID,
      target: { kind: 'local' },
      text: 'continue'
    })
    expect(sent).not.toBeNull()
    await flush()
    await closeChat()
    expect(pendingClose()).not.toBeNull()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    answer.resolve({
      ok: true,
      replayed: false,
      fence: 4,
      cursor: { epoch: 'e', sequence: 2 },
      value: {
        clientMessageId: sent!.clientMessageId,
        submission: {
          clientMessageId: sent!.clientMessageId,
          fence: 4,
          payloadFingerprint: 'send',
          dispatchState: 'accepted',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: 2
        }
      }
    })
    expect(await sent!.outcome).toBe('recorded')
    mocks.history.mockResolvedValue({
      ...completeIdle,
      page: { ...completeIdle.page, working: true }
    })
    await flush()
    await closeChat()
    await flush()
    expect(pendingClose()).not.toBeNull()
    expect(store().getState().unifiedTabsByWorktree[WORKTREE_ID]).toContainEqual(structuredTab)
  })
  it.each(['active', 'idle', 'HTTP', 'null settings', 'opt-out', 'bulk'])(
    '%s preserves close policy',
    async (mode) => {
      await ready(mode)
      if (mode === 'HTTP') {
        vi.stubGlobal('crypto', undefined)
      }
      const before = store().getState()
      const closed = vi.spyOn(before, 'closeUnifiedTab')
      await closeChat(mode === 'bulk')
      await flush()
      if (['active', 'HTTP', 'null settings'].includes(mode)) {
        expect(pendingClose()).toMatchObject({ copyKind: 'chat-agent', tabLabel: 'Claude Chat' })
        useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
        expect(store().getState()).toBe(before)
        expect(closed).not.toHaveBeenCalled()
        await flush()
        await closeChat()
        useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
      } else {
        expect(pendingClose()).toBeNull()
      }
      expect(closed).toHaveBeenCalledExactlyOnceWith(structuredTab.id)
      expect(
        mocks.history.mock.calls.filter((call) => call[1] === 'agentSession.history')
      ).toHaveLength(mode === 'idle' ? 1 : 0)
      vi.unstubAllGlobals()
    }
  )
  // Reduced replies from executed legacy producers; completed tail does not prove whole-work absence.
  it.each(['idle', 'prompt', 'unanswered', 'eligible queue', 'unlisted child'])(
    'legacy %s asks without refreshing status',
    async (kind) => {
      await ready()
      mocks.history.mockResolvedValue({
        ok: true,
        page: {
          ...completeIdle.page,
          latestTurn: {
            itemId: 'claude:turn-1',
            observedAt: 1_000,
            turn: { turnId: 'turn-1', state: 'completed' }
          },
          working: undefined,
          actionablePromptIds: undefined,
          nextQueuedMessageId: kind === 'eligible queue' ? 'card' : null,
          backgroundTasks:
            kind === 'unlisted child'
              ? { state: 'monitoring', supportsStopAll: false, children: [], incomplete: true }
              : null
        }
      })
      await closeChat()
      await flush()
      expect(pendingClose()).not.toBeNull()
      expect(mocks.history).toHaveBeenCalledOnce()
      expect(mocks.subscribeStatus).toHaveBeenCalledOnce()
    }
  )
  it.each(['read error', 'unsupported old host', 'deadline'])(
    '%s asks within the total deadline',
    async (kind) => {
      await ready()
      vi.useFakeTimers()
      mocks.history.mockReset()
      if (kind === 'deadline') {
        mocks.history.mockReturnValue(new Promise(() => {}))
      } else {
        mocks.history.mockRejectedValue(
          new RuntimeRpcCallError({
            id: 'history',
            ok: false,
            error: {
              code: kind === 'unsupported old host' ? 'method_not_found' : 'internal',
              message: kind
            }
          })
        )
      }
      const closed = vi.spyOn(store().getState(), 'closeUnifiedTab')
      await closeChat()
      if (kind === 'deadline') {
        await vi.advanceTimersByTimeAsync(1_999)
        expect(pendingClose()).toBeNull()
        expect(closed).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
      }
      await flush()
      expect(pendingClose()).not.toBeNull()
      expect(closed).not.toHaveBeenCalled()
    }
  )
})
