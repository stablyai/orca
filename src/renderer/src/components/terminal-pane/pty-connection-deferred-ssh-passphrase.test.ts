import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
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

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
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

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

function notifyStoreSubscribers(): void {
  for (const listener of storeSubscribers.slice()) {
    listener(mockStoreState)
  }
}

describe('connectPanePty', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('does not auto-reconnect after a user cancels deferred SSH passphrase auth', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'disconnected' }]]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'saved-session' }
    }

    const api = (
      globalThis as unknown as {
        window: {
          api: {
            ssh: {
              connect: ReturnType<typeof vi.fn>
              needsPassphrasePrompt: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    ).window.api
    api.ssh.needsPassphrasePrompt.mockResolvedValue(true)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(3)

    mockStoreState.sshConnectionStates = new Map([['conn-1', { status: 'connecting' }]])
    notifyStoreSubscribers()
    mockStoreState.sshConnectionStates = new Map([['conn-1', { status: 'disconnected' }]])
    notifyStoreSubscribers()
    await flushAsyncTicks(10)

    expect(api.ssh.connect).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshSessionId).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshReconnectTarget).not.toHaveBeenCalled()
  })

  it('abandons a deferred SSH retry replaced during the passphrase probe', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const restoredPtyId = toAppSshPtyId('conn-1', 'saved-session')
    const passphraseProbe = createDeferred<boolean>()
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pendingRetry = {
      attemptId: 'attempt-passphrase-probe',
      authority: {
        targetId: 'conn-1',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId, generation: 7 }]
      },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([
        [
          'conn-1',
          {
            status: 'disconnected',
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          }
        ]
      ]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': restoredPtyId },
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry }
    }
    vi.mocked(window.api.ssh.needsPassphrasePrompt).mockReturnValue(passphraseProbe.promise)

    const deps = createDeps()
    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(3)
    mockStoreState.directSshPaneRetryByTabId = {
      'tab-1': { ...pendingRetry, attemptId: 'attempt-passphrase-probe-new' }
    }

    passphraseProbe.resolve(false)
    await flushAsyncTicks(12)

    expect(window.api.ssh.connect).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshSessionId).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshReconnectTarget).not.toHaveBeenCalled()
  })

  it('drops a failed passphrase wait after its deferred SSH retry is replaced', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const restoredPtyId = toAppSshPtyId('conn-1', 'saved-session')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pendingRetry = {
      attemptId: 'attempt-passphrase-wait',
      authority: {
        targetId: 'conn-1',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId, generation: 7 }]
      },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([
        [
          'conn-1',
          {
            status: 'disconnected',
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          }
        ]
      ]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': restoredPtyId },
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry }
    }
    vi.mocked(window.api.ssh.needsPassphrasePrompt).mockResolvedValue(true)

    const deps = createDeps()
    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(3)
    mockStoreState.directSshPaneRetryByTabId = {
      'tab-1': { ...pendingRetry, attemptId: 'attempt-passphrase-wait-new' }
    }
    mockStoreState.sshConnectionStates = new Map([
      [
        'conn-1',
        {
          status: 'auth-failed',
          providerEpoch: 'epoch-1',
          connectionGeneration: 3
        }
      ]
    ])
    notifyStoreSubscribers()
    await flushAsyncTicks(12)

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(window.api.ssh.connect).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshSessionId).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshReconnectTarget).not.toHaveBeenCalled()
  })

  it('does not mutate deferred SSH reattach state after its connect wait lease is replaced', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const restoredPtyId = toAppSshPtyId('conn-1', 'saved-session')
    const sshConnect = createDeferred<SshConnectionState | null>()
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pendingRetry = {
      attemptId: 'attempt-connect-wait',
      authority: {
        targetId: 'conn-1',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId, generation: 7 }]
      },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([
        [
          'conn-1',
          {
            status: 'disconnected',
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          }
        ]
      ]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': restoredPtyId },
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry }
    }
    vi.mocked(window.api.ssh.connect).mockReturnValue(sshConnect.promise)
    const paneMode2031Ref = { current: new Map([[1, true]]) }
    const paneLastThemeModeRef = { current: new Map([[1, true]]) }
    const deps = createDeps({ paneMode2031Ref, paneLastThemeModeRef })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)
    mockStoreState.directSshPaneRetryByTabId = {
      'tab-1': { ...pendingRetry, attemptId: 'attempt-connect-wait-new' }
    }

    sshConnect.resolve({
      targetId: 'conn-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    await flushAsyncTicks(12)

    expect(mockStoreState.removeDeferredSshReconnectTarget).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshSessionId).not.toHaveBeenCalled()
    expect(window.api.pty.declarePendingPaneSerializer).not.toHaveBeenCalled()
    expect(paneMode2031Ref.current.get(1)).toBe(true)
    expect(paneLastThemeModeRef.current.get(1)).toBe(true)
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('consumes a sole deferred SSH session id after reattach succeeds', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]]),
      deferredSshSessionIdsByTabId: { 'tab-1': 'saved-session' }
    }
    const deps = createDeps()

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    expect(mockStoreState.removeDeferredSshSessionId).not.toHaveBeenCalled()
    await flushAsyncTicks(12)

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'saved-session' })
    )
    expect(mockStoreState.removeDeferredSshSessionId).toHaveBeenCalledExactlyOnceWith('tab-1')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'saved-session')
  })

  it('retains a sole deferred SSH session id when its replay is disposed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('saved-session')
    transport.connect.mockResolvedValueOnce({
      id: 'saved-session',
      replay: 'restored output'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]]),
      deferredSshSessionIdsByTabId: { 'tab-1': 'saved-session' }
    }
    const pane = createPane(1)
    const deps = createDeps()
    let binding: ReturnType<typeof connectPanePty> | null = null
    pane.terminal.write.mockImplementation((_data, callback) => {
      binding?.dispose()
      callback?.()
    })

    binding = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(12)

    expect(mockStoreState.removeDeferredSshSessionId).not.toHaveBeenCalled()
    expect(mockStoreState.deferredSshSessionIdsByTabId['tab-1']).toBe('saved-session')
  })

  it('spawns a fresh PTY when a deferred SSH session expired', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts) => {
      if (opts.sessionId) {
        opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: expired-session')
        return undefined
      }
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('fresh-ssh-pty')
      return 'fresh-ssh-pty'
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'expired-session' }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'expired-session')
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'expired-session')
    expect(mockStoreState.removeDeferredSshSessionId).toHaveBeenCalledWith('tab-1')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'fresh-ssh-pty')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-ssh-pty')
  })

  it('clears the pending serializer when disposed before deferred SSH expiry resolves', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<undefined>()
    const transport = createMockTransport()
    transport.connect.mockImplementation(
      (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (opts.sessionId) {
          opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: expired-session')
          return reattach.promise
        }
        return Promise.resolve('fresh-ssh-pty')
      }
    )
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'expired-session' }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(10)
    binding.dispose()
    reattach.resolve(undefined)
    await flushAsyncTicks(10)

    expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      1
    )
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('ignores stale deferred SSH expiry after successor transport registration', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<undefined>()
    let reattachOptions: ConnectCallbacks | undefined
    const staleTransport = createMockTransport('old-pty')
    staleTransport.connect.mockImplementation(
      async (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (opts.sessionId) {
          reattachOptions = opts.callbacks
          await reattach.promise
          return undefined
        }
        opts.callbacks?.onConnect?.()
        opts.callbacks?.onReattachDetermined?.()
        return 'fresh-pty'
      }
    )
    transportFactoryQueue.push(staleTransport)
    const paneTransportsRef = { current: new Map<number, MockTransport>() }
    const deps = createDeps({ paneTransportsRef })
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'old-pty' }] },
      ptyIdsByTabId: { 'tab-1': ['old-pty'] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'old-pty' }
    } as StoreState

    const pane = createPane(1)
    connectPanePty(
      pane as never,
      createManager(1) as never,
      Object.assign(deps, {
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'old-pty' }
      }) as never
    )
    await flushAsyncTicks(12)
    expect(staleTransport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'old-pty' })
    )
    const removeDeferredTargetCallCount =
      mockStoreState.removeDeferredSshReconnectTarget.mock.calls.length

    const successorTransport = createMockTransport('successor-pty')
    paneTransportsRef.current.set(pane.id, successorTransport)
    reattachOptions?.onError?.('SSH_SESSION_EXPIRED: stale lease')
    reattach.resolve(undefined)
    await flushAsyncTicks(20)

    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(deps.updateTabPtyId).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshReconnectTarget).toHaveBeenCalledTimes(
      removeDeferredTargetCallCount
    )
  })

  // Why: wires the REAL useNotificationDispatch (not a stub) so deleting the producer breaks the IPC assertion — the user-facing contract.
})
