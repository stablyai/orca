// @vitest-environment happy-dom

// A chat whose create got no answer (a lost reply, or a reload mid-start) may or may not exist on
// its host. It shows no mark while that is unknown; when the host is reachable again the launch is
// re-checked without the user, and settles to started (no mark) or failed (marked).

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import type { AppState } from '@/store/types'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState>) => void
}

const mocks = vi.hoisted(() => {
  const hoisted: {
    store: TestStore | null
    subscribeStatus: Mock
    createIntent: Mock
    restoreIntent: Mock
    launch: Mock<
      (
        intent: StructuredAgentSessionLaunchIntent,
        onHostSeed?: unknown
      ) => Promise<{ sessionId: string; fence: number }>
    >
    refresh: Mock
    history: Mock
  } = {
    store: null,
    subscribeStatus: vi.fn(),
    createIntent: vi.fn(),
    restoreIntent: vi.fn(),
    launch: vi.fn(),
    refresh: vi.fn(),
    history: vi.fn()
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
  callStructuredAgentSession: mocks.history,
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: mocks.refresh
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: vi.fn((prior: unknown) => prior),
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { startStructuredAgentLaunch } from '@/lib/structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchLifecycle,
  markStructuredAgentSessionLaunchCancelled,
  resetStructuredAgentLaunchRegistryForTests
} from '@/lib/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/structured-agent-session-launch-persistence'
import { recheckUnconfirmedStructuredAgentLaunches } from '@/lib/structured-agent-session-launch-unconfirmed-recheck'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import {
  resetTerminalTabActivityFlagsCacheForTest,
  resolveTerminalTabActivityStatus
} from '../tab-bar/terminal-tab-activity-status'

const WORKTREE_ID = 'wt-1'
const CLAUDE_SESSION = 'session-claude'
const CODEX_SESSION = 'session-codex'

function chatTab(sessionId: string, agent: 'claude' | 'codex'): Tab {
  return {
    id: `structured-agent-session-${sessionId}`,
    worktreeId: WORKTREE_ID,
    groupId: 'group-1',
    contentType: 'agent-session',
    entityId: sessionId,
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1_000,
    isPinned: false,
    agentSessionAgent: agent
  }
}

function launchIntent(
  sessionId: string,
  agent: 'claude' | 'codex' = 'claude'
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId: WORKTREE_ID,
    sessionId,
    executionHostId: 'local',
    target: { kind: 'local' },
    agent,
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${WORKTREE_ID}`,
      agent
    }
  }
}

function listing(...sessionIds: string[]): RuntimeMobileSessionTabsResult[] {
  return [
    {
      worktree: WORKTREE_ID,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: sessionIds.map((sessionId) => ({
        type: 'agent-session' as const,
        id: `agent-session:${sessionId}`,
        title: 'Chat',
        sessionId,
        agent: 'claude' as const,
        isActive: false
      }))
    }
  ]
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

function tabStatus(sessionId = CLAUDE_SESSION): string {
  const state = store().getState()
  return resolveTerminalTabActivityStatus({
    tab: { id: `structured-agent-session-${sessionId}`, title: 'Chat', launchAgent: 'claude' },
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    agentStatusEpoch: state.agentStatusEpoch
  })
}

function lifecycle(sessionId = CLAUDE_SESSION): string | null {
  return getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, sessionId)
}

function createCalls(): number {
  return mocks.launch.mock.calls.length
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function connect(): Promise<void> {
  render(<StructuredAgentSessionStatusBridge />)
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalled())
  for (const [, emit] of mocks.subscribeStatus.mock.calls) {
    act(() => emit({ type: 'snapshot', sessions: [] }))
  }
}

/** A reload keeps the saved launch record and the tab, but nothing in memory. */
async function reload(): Promise<void> {
  cleanup()
  store().setState({ agentStatusByPaneKey: {} })
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentSessionStatusFeedsForTests()
  resetTerminalTabActivityFlagsCacheForTest()
  mocks.subscribeStatus.mockClear()
  await connect()
}

/** The create's reply never arrives and the host lists nothing, so the outcome stays unknown. */
async function loseStart(
  sessionId = CLAUDE_SESSION,
  agent: 'claude' | 'codex' = 'claude'
): Promise<void> {
  mocks.createIntent.mockReturnValueOnce(launchIntent(sessionId, agent))
  const launch = startStructuredAgentLaunch(WORKTREE_ID, agent, {
    requestId: `request-${sessionId}`
  })
  await expect(launch.launchResult).rejects.toThrow('reply lost')
  await flush()
  expect(lifecycle(sessionId)).toBe('visibility-unknown')
}

function hostIsReachableAgain(executionHostId: 'local' | `runtime:${string}` = 'local'): void {
  act(() => recheckUnconfirmedStructuredAgentLaunches(executionHostId))
}

describe('a chat whose start was never confirmed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Queued one-shot answers an earlier case left unconsumed must not leak into the next.
    for (const mock of [mocks.createIntent, mocks.launch, mocks.refresh, mocks.restoreIntent]) {
      mock.mockReset()
    }
    localStorage.clear()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentSessionStatusFeedsForTests()
    resetTerminalTabActivityFlagsCacheForTest()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: vi.fn() })
    mocks.launch.mockRejectedValue(new Error('reply lost'))
    mocks.refresh.mockResolvedValue([])
    mocks.history.mockResolvedValue({ ok: true, page: { fence: 1 } })
    mocks.restoreIntent.mockImplementation((args: { sessionId: string }) =>
      launchIntent(args.sessionId)
    )
    store().setState({
      agentStatusByPaneKey: {},
      acknowledgedAgentsByPaneKey: {},
      retainedAgentsByPaneKey: {},
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [chatTab(CLAUDE_SESSION, 'claude'), chatTab(CODEX_SESSION, 'codex')]
      }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it('shows no mark while unconfirmed, and none once the host shows the create had landed', async () => {
    await connect()
    await loseStart()
    expect(rows()).toEqual([])
    expect(tabStatus()).not.toBe('failed')
    const creates = createCalls()

    mocks.refresh.mockResolvedValueOnce(listing(CLAUDE_SESSION))
    hostIsReachableAgain()
    await flush()

    expect(lifecycle()).toBeNull()
    // The host already held the chat, so nothing is created twice.
    expect(createCalls()).toBe(creates)
    expect(rows()).toEqual([])
  })

  it('marks it failed when the host, asked again, refuses the create', async () => {
    await connect()
    await loseStart()
    expect(rows()).toEqual([])

    mocks.launch.mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))
    hostIsReachableAgain()
    await flush()

    expect(lifecycle()).toBe('failed')
    expect(tabStatus()).toBe('failed')

    // A refusal is an answer: only the user's Retry asks again.
    const creates = createCalls()
    hostIsReachableAgain()
    await flush()
    expect(createCalls()).toBe(creates)
  })

  it('re-checks a start a reload interrupted, without the user pressing Retry', async () => {
    await connect()
    mocks.createIntent.mockReturnValueOnce(launchIntent(CLAUDE_SESSION))
    mocks.launch.mockReturnValueOnce(new Promise(() => {}))
    startStructuredAgentLaunch(WORKTREE_ID, 'claude', { requestId: `request-${CLAUDE_SESSION}` })
    await flush()

    await reload()
    expect(lifecycle()).toBe('visibility-unknown')
    expect(rows()).toEqual([])
    expect(tabStatus()).not.toBe('failed')

    mocks.launch.mockResolvedValueOnce({ sessionId: CLAUDE_SESSION, fence: 1 })
    mocks.refresh.mockResolvedValueOnce([]).mockResolvedValueOnce(listing(CLAUDE_SESSION))
    hostIsReachableAgain()
    await flush()

    expect(mocks.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: CLAUDE_SESSION,
        params: expect.objectContaining({
          envelope: expect.objectContaining({ clientOperationId: `operation-${CLAUDE_SESSION}` })
        })
      }),
      expect.any(Function)
    )
    expect(lifecycle()).toBeNull()
    expect(rows()).toEqual([])
  })

  it('never re-creates a chat the user closed, before or after a reload', async () => {
    await connect()
    await loseStart(CLAUDE_SESSION, 'claude')
    await loseStart(CODEX_SESSION, 'codex')
    act(() => {
      markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, CLAUDE_SESSION, 'local')
    })
    const creates = createCalls()

    hostIsReachableAgain()
    await flush()
    const recreated = (sessionId: string): number =>
      mocks.launch.mock.calls.slice(creates).filter(([intent]) => intent.sessionId === sessionId)
        .length
    expect(recreated(CODEX_SESSION)).toBe(1)
    expect(recreated(CLAUDE_SESSION)).toBe(0)

    await reload()
    hostIsReachableAgain()
    await flush()
    expect(recreated(CLAUDE_SESSION)).toBe(0)
    expect(lifecycle(CLAUDE_SESSION)).toBe('cancelled')
  })

  it('re-checks once per return of its own host: one still unknown waits for the next', async () => {
    await connect()
    await loseStart()
    const creates = createCalls()

    hostIsReachableAgain('runtime:other-host')
    await flush()
    expect(createCalls()).toBe(creates)

    hostIsReachableAgain()
    await flush()
    expect(createCalls()).toBe(creates + 1)
    expect(lifecycle()).toBe('visibility-unknown')
    expect(rows()).toEqual([])

    await flush()
    expect(createCalls()).toBe(creates + 1)

    hostIsReachableAgain()
    await flush()
    expect(createCalls()).toBe(creates + 2)
  })
})
