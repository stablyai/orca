import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusBatchUpdate } from '../../store/slices/agent-status'
import {
  buildStoreState,
  FUTURE_LEAF_ID,
  FUTURE_PANE_KEY,
  type AgentStatusSetData,
  type StoreLike,
  type StoreSubscribeListener
} from '../ipc-events-agent-status-store-test-fixtures'
import { shouldRetryPendingAgentStatusesAfterStoreUpdate } from './agent-status-pending-retry-gate'

type RetryState = Parameters<typeof shouldRetryPendingAgentStatusesAfterStoreUpdate>[0]

function createRetryState(): RetryState {
  return {
    workspaceSessionReady: true,
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {},
    worktreesByRepo: {},
    repos: [],
    recentlyClosedAgentStatusTabIds: {},
    recentlyRetiredAgentStatusPaneKeys: {}
  }
}

type PendingRetryHarness = {
  bridge: { disposeAsyncState: () => void; unsubscribeStore: () => void }
  emitPendingStatus: () => void
  publish: (mutate: (state: StoreLike) => void) => void
  setAgentStatuses: ReturnType<typeof vi.fn>
  transactAgentStatuses: ReturnType<typeof vi.fn>
}

async function createPendingRetryHarness(): Promise<PendingRetryHarness> {
  const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }
  const onSetListenerRef: { current: ((data: AgentStatusSetData) => void) | null } = {
    current: null
  }
  const setAgentStatuses = vi.fn((updates: readonly AgentStatusBatchUpdate[]) =>
    updates.map(() => true)
  )
  const storeState = buildStoreState({
    setAgentStatuses,
    workspaceSessionReady: true,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    settings: { terminalFontSize: 13, notifications: { enabled: false } }
  })
  const transactImplementation = storeState.transactAgentStatuses as (...args: unknown[]) => unknown
  const transactAgentStatuses = vi.fn(transactImplementation)
  storeState.transactAgentStatuses = transactAgentStatuses

  vi.doMock('../../store', () => ({
    useAppStore: {
      subscribe: vi.fn((listener: StoreSubscribeListener) => {
        subscribeListenerRef.current = listener
        return () => {
          subscribeListenerRef.current = null
        }
      }),
      getState: () => storeState
    }
  }))
  vi.doMock('../agent-hook-completion-notifications', () => ({
    observeAgentHookCompletionForNotification: vi.fn(),
    syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
  }))
  vi.stubGlobal('window', {
    api: {
      agentStatus: {
        onSet: (listener: (data: AgentStatusSetData) => void) => {
          onSetListenerRef.current = listener
          return () => {
            onSetListenerRef.current = null
          }
        }
      }
    }
  })

  const { registerAgentStatusIpcBridge } = await import('./agent-status-ipc-bridge')
  const bridge = registerAgentStatusIpcBridge([])
  if (!subscribeListenerRef.current || !onSetListenerRef.current) {
    throw new Error('Expected agent-status bridge listeners')
  }

  return {
    bridge,
    emitPendingStatus: () => {
      onSetListenerRef.current?.({
        paneKey: FUTURE_PANE_KEY,
        state: 'working',
        prompt: 'pending attribution',
        agentType: 'claude',
        receivedAt: 1_700_000_000_000,
        stateStartedAt: 1_700_000_000_000
      })
    },
    publish: (mutate) => {
      const previousState = { ...storeState }
      mutate(storeState)
      subscribeListenerRef.current?.(storeState, previousState)
    },
    setAgentStatuses,
    transactAgentStatuses
  }
}

describe('agent status pending retry gate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_100_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('tracks every store-owned input that can resolve or retire pending attribution', () => {
    const previous = createRetryState()
    const changes: RetryState[] = [
      { ...previous, workspaceSessionReady: false },
      { ...previous, tabsByWorktree: {} },
      { ...previous, unifiedTabsByWorktree: {} },
      { ...previous, terminalLayoutsByTabId: {} },
      { ...previous, worktreesByRepo: {} },
      { ...previous, repos: [] },
      { ...previous, recentlyClosedAgentStatusTabIds: {} },
      { ...previous, recentlyRetiredAgentStatusPaneKeys: {} }
    ]

    expect(shouldRetryPendingAgentStatusesAfterStoreUpdate({ ...previous }, previous)).toBe(false)
    for (const current of changes) {
      expect(shouldRetryPendingAgentStatusesAfterStoreUpdate(current, previous)).toBe(true)
    }
  })

  it('skips retry transactions for unrelated publications and retries on hydration', async () => {
    const harness = await createPendingRetryHarness()
    harness.emitPendingStatus()

    for (let updateIndex = 0; updateIndex < 2_400; updateIndex += 1) {
      harness.publish((state) => {
        state.cosmeticUpdateIndex = updateIndex
      })
    }

    expect(harness.transactAgentStatuses).not.toHaveBeenCalled()

    harness.publish((state) => {
      state.tabsByWorktree = {
        'wt-1': [{ id: 'tab-future', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Future' }]
      }
      state.terminalLayoutsByTabId = {
        'tab-future': {
          root: { type: 'leaf', leafId: FUTURE_LEAF_ID },
          activeLeafId: FUTURE_LEAF_ID,
          expandedLeafId: null
        }
      }
    })

    expect(harness.transactAgentStatuses).toHaveBeenCalledTimes(1)
    expect(harness.setAgentStatuses).toHaveBeenCalledWith([
      expect.objectContaining({ paneKey: FUTURE_PANE_KEY })
    ])
    vi.advanceTimersByTime(100)
    expect(harness.transactAgentStatuses).toHaveBeenCalledTimes(1)
    harness.bridge.unsubscribeStore()
    harness.bridge.disposeAsyncState()
  })

  it('keeps the timer fallback when routing references stay unchanged', async () => {
    const harness = await createPendingRetryHarness()
    harness.emitPendingStatus()
    harness.publish((state) => {
      state.cosmeticUpdateIndex = 1
    })

    expect(harness.transactAgentStatuses).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(harness.transactAgentStatuses).toHaveBeenCalledTimes(1)
    expect(harness.setAgentStatuses).toHaveBeenCalledWith([])
    harness.bridge.unsubscribeStore()
    harness.bridge.disposeAsyncState()
  })
})
