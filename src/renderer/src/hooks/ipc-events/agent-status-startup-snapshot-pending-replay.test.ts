import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildStoreState,
  FUTURE_LEAF_ID,
  FUTURE_PANE_KEY,
  TAB_1_LEAF_ID,
  TAB_1_PANE_KEY,
  installMockAgentStatusTransaction,
  type StoreLike,
  type StoreSubscribeListener
} from '../ipc-events-agent-status-store-test-fixtures'

const SNAPSHOT_ENTRY = {
  paneKey: FUTURE_PANE_KEY,
  worktreeId: 'wt-1',
  terminalHandle: 'term-1',
  state: 'working' as const,
  agentType: 'opencode',
  providerSession: { key: 'session_id' as const, id: 'ses_1' },
  receivedAt: 1_700_000_000_000,
  stateStartedAt: 1_700_000_000_000
}

function routedTabs(state: StoreLike): void {
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
}

async function flushMicrotasks(): Promise<void> {
  for (let step = 0; step < 12; step += 1) {
    await Promise.resolve()
  }
}

async function bootBridge(
  storeState: StoreLike,
  options?: {
    getSnapshot?: () => Promise<unknown>
    clearHandler?: { current: ((data: unknown) => void) | null }
  }
): Promise<{
  publish: (mutate: (state: StoreLike) => void) => void
  waitForSnapshot: (paneKey?: string) => Promise<void>
  dispose: () => void
  registerReplacement: () => { dispose: () => void }
}> {
  const subscribeListenerRef: { current: StoreSubscribeListener | null } = { current: null }
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
        onSet: () => () => {},
        onClear: (handler: (data: unknown) => void) => {
          if (options?.clearHandler) {
            options.clearHandler.current = handler
          }
          return () => {
            if (options?.clearHandler) {
              options.clearHandler.current = null
            }
          }
        },
        getSnapshot: options?.getSnapshot ?? (() => Promise.resolve([SNAPSHOT_ENTRY]))
      }
    }
  })

  const gate = await import('./agent-status-startup-snapshot-gate')
  const { registerAgentStatusIpcBridge } = await import('./agent-status-ipc-bridge')
  const bridge = registerAgentStatusIpcBridge([])
  return {
    publish: (mutate) => {
      const previousState = { ...storeState }
      mutate(storeState)
      subscribeListenerRef.current?.(storeState, previousState)
    },
    waitForSnapshot: (paneKey?: string) =>
      gate.waitForAgentStatusStartupSnapshot(undefined, paneKey),
    dispose: () => {
      bridge.unsubscribeStore()
      bridge.disposeAsyncState()
    },
    registerReplacement: () => {
      const replacement = registerAgentStatusIpcBridge([])
      return {
        dispose: () => {
          replacement.unsubscribeStore()
          replacement.disposeAsyncState()
        }
      }
    }
  }
}

describe('startup snapshot gate waits for a pending replay', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
    vi.doUnmock('../../store')
    vi.doUnmock('../agent-hook-completion-notifications')
  })

  it('keeps the gate closed until the unrouted snapshot entry is applied', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_100_000)
    const setAgentStatuses = vi.fn(() => [])
    const storeState = buildStoreState({
      setAgentStatuses,
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } }
    })
    installMockAgentStatusTransaction(storeState)

    const harness = await bootBridge(storeState)
    let released = false
    const waiting = harness.waitForSnapshot().then(() => {
      released = true
    })
    // The snapshot `.finally` has to run before this assertion. A no-op hold
    // settles in that turn, so the gate must still be closed after it.
    await flushMicrotasks()
    expect(released).toBe(false)

    harness.publish(routedTabs)
    await waiting
    expect(released).toBe(true)
    expect(setAgentStatuses).toHaveBeenCalledWith([
      expect.objectContaining({ paneKey: FUTURE_PANE_KEY })
    ])
    harness.dispose()
  })

  it('does not hold a routed pane for an unrelated snapshot row', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_100_000)
    const storeState = buildStoreState({
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } }
    })
    installMockAgentStatusTransaction(storeState)
    storeState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1', ptyId: 'pty-1', worktreeId: 'wt-1', title: 'Ready' }]
    }
    storeState.terminalLayoutsByTabId = {
      'tab-1': {
        root: { type: 'leaf', leafId: TAB_1_LEAF_ID },
        activeLeafId: TAB_1_LEAF_ID,
        expandedLeafId: null
      }
    }
    const readyEntry = {
      ...SNAPSHOT_ENTRY,
      paneKey: TAB_1_PANE_KEY,
      providerSession: { key: 'session_id' as const, id: 'ses_ready' }
    }
    const harness = await bootBridge(storeState, {
      getSnapshot: () => Promise.resolve([readyEntry, SNAPSHOT_ENTRY])
    })
    let ready = false
    let blocked = false
    const readyWait = harness.waitForSnapshot(TAB_1_PANE_KEY).then(() => {
      ready = true
    })
    const blockedWait = harness.waitForSnapshot(FUTURE_PANE_KEY).then(() => {
      blocked = true
    })

    await flushMicrotasks()
    expect(ready).toBe(true)
    expect(blocked).toBe(false)

    harness.publish(routedTabs)
    await blockedWait
    expect(blocked).toBe(true)
    await readyWait
    harness.dispose()
  })

  it('releases the gate when the snapshot pane is already routable', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_100_000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storeState = buildStoreState({
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } }
    })
    installMockAgentStatusTransaction(storeState)
    routedTabs(storeState)

    const harness = await bootBridge(storeState)
    await harness.waitForSnapshot()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    harness.dispose()
  })

  it('keeps a replacement bridge hold closed when the disposed snapshot settles', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_100_000)
    let resolveFirst: (entries: unknown[]) => void = () => {}
    const firstSnapshot = new Promise<unknown[]>((resolve) => {
      resolveFirst = resolve
    })
    let snapshots = 0
    const storeState = buildStoreState({
      setAgentStatuses: vi.fn(() => []),
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } }
    })
    installMockAgentStatusTransaction(storeState)

    const harness = await bootBridge(storeState, {
      getSnapshot: () => {
        snapshots += 1
        return snapshots === 1 ? firstSnapshot : Promise.resolve([SNAPSHOT_ENTRY])
      }
    })
    await flushMicrotasks()
    harness.dispose()

    const replacement = harness.registerReplacement()
    let released = false
    const waiting = harness.waitForSnapshot().then(() => {
      released = true
    })
    await flushMicrotasks()
    expect(released).toBe(false)

    resolveFirst([SNAPSHOT_ENTRY])
    await flushMicrotasks()
    expect(released).toBe(false)

    harness.publish(routedTabs)
    await waiting
    expect(released).toBe(true)
    replacement.dispose()
    harness.dispose()
  })

  it('releases the hold when a clear drops the queued replay entry', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_100_000)
    const clearHandler: { current: ((data: unknown) => void) | null } = { current: null }
    const storeState = buildStoreState({
      setAgentStatuses: vi.fn(() => []),
      workspaceSessionReady: true,
      settings: { terminalFontSize: 13, notifications: { enabled: false } },
      removeAgentStatus: vi.fn()
    })
    installMockAgentStatusTransaction(storeState)

    const harness = await bootBridge(storeState, { clearHandler })
    let released = false
    const waiting = harness.waitForSnapshot().then(() => {
      released = true
    })
    await flushMicrotasks()
    expect(released).toBe(false)
    expect(clearHandler.current).toEqual(expect.any(Function))

    clearHandler.current?.({ paneKey: FUTURE_PANE_KEY })
    await waiting
    expect(released).toBe(true)
    harness.dispose()
  })
})
