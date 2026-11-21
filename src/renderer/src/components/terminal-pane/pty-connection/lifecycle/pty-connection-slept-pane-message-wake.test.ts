import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } =
    await import('../test-fixtures/pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('../../titles/cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/agent-session/accounts/codex/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: useCallback must pass through; no test here renders React.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('../../pty-transport/ipc/pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('../../pty-transport/remote-runtime/remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Stub eager-buffer lookup to exercise live adoption without the IPC dispatcher.
vi.mock('../../pty-transport/delivery/pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

const DEAD_SESSION = 'wt-1@@slept-session'
const PANE_KEY = makePaneKey('tab-1', LEAF_1)

function sleepRecord(): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-slept' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep'
  }
}

// A slept pane that remounts hidden over its stopped session: a message wake must resume the agent.
describe('message wake of a remounted slept pane', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  async function remountSleptPane(): Promise<{
    transport: MockTransport
    wake: () => string | null
  }> {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(false)
    const transport = createMockTransport()
    // The stopped session reattaches to nothing; only a fresh spawn gets a process.
    transport.connect.mockImplementation(async (options: { sessionId?: string }) =>
      options.sessionId ? null : { id: 'pty-resumed' }
    )
    transportFactoryQueue.push(transport)
    mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY] = sleepRecord()
    const args = mockPanePtyArgs(
      createPane(1),
      createManager(1),
      createDeps({
        isVisibleRef: { current: false },
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: DEAD_SESSION }
      })
    )
    bindPaneAgentTitleMocks(args[2], agentTitleMocks)
    const binding = connectPanePty(...args)
    await flushAsyncTicks()
    return {
      transport,
      wake: () => binding.wakeHibernatedAgentIfArmed(new Set(), PANE_KEY)
    }
  }

  function freshResumeSpawns(transport: MockTransport): unknown[] {
    return transport.connect.mock.calls.filter(
      (call) => !call[0]?.sessionId && Boolean(call[0]?.resumeProviderSession)
    )
  }

  it('resumes the agent when the host reports the stopped session gone', async () => {
    const pane = await remountSleptPane()

    expect(pane.wake()).not.toBeNull()
    await flushAsyncTicks()

    expect(freshResumeSpawns(pane.transport)).toHaveLength(1)
    expect(pane.transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: DEAD_SESSION })
    )
  })
})
