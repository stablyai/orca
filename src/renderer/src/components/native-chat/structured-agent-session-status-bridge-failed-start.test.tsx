// @vitest-environment happy-dom

// Refused creates publish no host session; bridge launch failures into tab/workspace rows until retry or closure.

import type * as LaunchErrors from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult,
  AgentSessionStatusEvent
} from '../../../../shared/agent-session/agent-session-wire'

import { structuredAgentSessionAgentStatus } from '../../../../shared/agent-session/view/structured-agent-session-agent-status'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
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

vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local'
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.history
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  ensureRuntimeEnvironmentCompatible: async () => {}
}))

vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: vi.fn(async () => [])
}))

const launchErrorMocks = vi.hoisted(() => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return { StructuredAgentSessionCreateRefusalError }
})

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-errors', async () => ({
  ...(await vi.importActual<typeof LaunchErrors>(
    '@/lib/agent-session/launch/structured-agent-session-launch-errors'
  )),
  ...launchErrorMocks
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-create-call', () => ({
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
} from '@/lib/agent-session/launch/structured-agent-session-launch'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import {
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus
} from '../tab-bar/terminal-tab-activity-status'

import { countActivityUnread } from '../activity/useActivityUnreadCount'

import { getDefaultSettings } from '../../../../shared/constants'
import {
  sendStructuredAgentSessionMessage,
  resetStructuredAgentSessionSendsForTests
} from './structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'

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
})
