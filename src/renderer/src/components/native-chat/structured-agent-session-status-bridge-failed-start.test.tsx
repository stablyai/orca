// @vitest-environment happy-dom

// A chat whose start the host refused has no host session, so nothing publishes its row. The
// bridge marks it failed from the launch's own outcome, so the tab and the workspace row show it
// to a user looking elsewhere, until a retry starts it or the tab closes.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
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
    subscribeStatus: Mock
    unsubscribe: Mock
    createIntent: Mock
    retryIntent: Mock
    restoreIntent: Mock
    launch: Mock
  } = {
    store: null,
    subscribeStatus: vi.fn(),
    unsubscribe: vi.fn(),
    createIntent: vi.fn(),
    retryIntent: vi.fn(),
    restoreIntent: vi.fn(),
    launch: vi.fn()
  }
  return hoisted
})

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null,
  getExecutionHostIdForWorktree: () => 'local'
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn(async () => [])
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import {
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from '@/lib/structured-agent-session-launch'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import {
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus
} from '../tab-bar/terminal-tab-activity-status'
import { selectWorktreeAgentActivitySummary } from '../sidebar/worktree-agent-activity-summary'
import { countActivityUnread } from '../activity/useActivityUnreadCount'

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
  agentSessionAgent: 'claude'
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

/** What the chat's own tab shows, resolved as the tab bar resolves a structured tab. */
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

/** A restart keeps the saved launch and the acknowledgements, but no rows and no launch in memory. */
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
  // Each failed start stands for its own user action.
  const launch = startStructuredAgentLaunch(WORKTREE_ID, 'claude', {
    requestId: `request-${failedStarts}`
  })
  await expect(launch.launchResult).rejects.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
  await flush()
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
})
