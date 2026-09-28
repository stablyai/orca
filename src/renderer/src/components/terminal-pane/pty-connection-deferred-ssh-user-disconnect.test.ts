import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
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

const USER_DISCONNECTED: SshConnectionState = {
  targetId: 'conn-1',
  status: 'disconnected',
  error: null,
  reconnectAttempt: 0,
  disconnectedBy: 'user'
}

function publishSshState(state: Partial<SshConnectionState>): void {
  mockStoreState = {
    ...mockStoreState,
    sshConnectionStates: new Map([['conn-1', { ...USER_DISCONNECTED, ...state }]])
  }
  notifyStoreSubscribers()
}

describe("connectPanePty on a host the user's Disconnect holds down", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
    window.api.ssh.getState = vi.fn().mockResolvedValue(USER_DISCONNECTED)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }]
    }
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('reports nothing, dials once, and attaches once when the user connects', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-ssh-pty')
    transportFactoryQueue.push(transport)
    publishSshState({})
    vi.mocked(window.api.ssh.ensureConnected).mockRejectedValue(
      new Error('conn-1 was disconnected on the desktop.')
    )
    const deps = createDeps()

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(vi.mocked(window.api.ssh.ensureConnected)).toHaveBeenCalledTimes(1)
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()

    publishSshState({ status: 'connecting', disconnectedBy: undefined })
    await flushAsyncTicks(5)
    publishSshState({ status: 'connected', disconnectedBy: undefined })
    await flushAsyncTicks(20)

    expect(vi.mocked(window.api.ssh.ensureConnected)).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('waits the same way when the Disconnect cancels a connect already in flight', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-ssh-pty')
    transportFactoryQueue.push(transport)
    publishSshState({ status: 'connecting', disconnectedBy: undefined })
    const inFlight = createDeferred<SshConnectionState | null>()
    vi.mocked(window.api.ssh.ensureConnected).mockReturnValue(inFlight.promise)
    const deps = createDeps()

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    expect(vi.mocked(window.api.ssh.ensureConnected)).toHaveBeenCalledTimes(1)

    publishSshState({})
    inFlight.reject(new Error('SSH connection attempt was cancelled'))
    await flushAsyncTicks(20)

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalled()

    publishSshState({ status: 'connected', disconnectedBy: undefined })
    await flushAsyncTicks(20)

    expect(vi.mocked(window.api.ssh.ensureConnected)).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it("waits when the refusal beats the Disconnect's push over an earlier failure", async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-ssh-pty')
    transportFactoryQueue.push(transport)
    // The store still holds the failure from before the Disconnect; only main knows it holds.
    publishSshState({ status: 'error', error: 'connect ECONNREFUSED', disconnectedBy: undefined })
    vi.mocked(window.api.ssh.ensureConnected).mockRejectedValue(
      new Error('Dev box was disconnected on the desktop.')
    )
    const deps = createDeps()

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(vi.mocked(window.api.ssh.getState)).toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()

    publishSshState({})
    await flushAsyncTicks(5)
    publishSshState({ status: 'connecting', disconnectedBy: undefined })
    await flushAsyncTicks(5)
    publishSshState({ status: 'connected', disconnectedBy: undefined })
    await flushAsyncTicks(20)

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting through a Connect the user abandons, and attaches on the next one', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-ssh-pty')
    transportFactoryQueue.push(transport)
    publishSshState({})
    vi.mocked(window.api.ssh.ensureConnected).mockRejectedValue(
      new Error('Dev box was disconnected on the desktop.')
    )
    const deps = createDeps()

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    // The user clicks Connect, then dismisses its passphrase prompt.
    publishSshState({ status: 'connecting', disconnectedBy: undefined })
    await flushAsyncTicks(5)
    publishSshState({ status: 'disconnected', disconnectedBy: undefined })
    await flushAsyncTicks(20)
    expect(transport.connect).not.toHaveBeenCalled()

    publishSshState({ status: 'connecting', disconnectedBy: undefined })
    await flushAsyncTicks(5)
    publishSshState({ status: 'connected', disconnectedBy: undefined })
    await flushAsyncTicks(20)

    expect(vi.mocked(window.api.ssh.ensureConnected)).toHaveBeenCalledTimes(1)
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('still reports a failed connect on a host the user did not disconnect', async () => {
    const { connectPanePty } = await import('./pty-connection')
    transportFactoryQueue.push(createMockTransport('fresh-ssh-pty'))
    publishSshState({ status: 'error', error: 'connect ECONNREFUSED', disconnectedBy: undefined })
    vi.mocked(window.api.ssh.getState).mockResolvedValue({
      ...USER_DISCONNECTED,
      status: 'error',
      disconnectedBy: undefined
    })
    vi.mocked(window.api.ssh.ensureConnected).mockRejectedValue(new Error('connect ECONNREFUSED'))
    const deps = createDeps()

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
      1,
      'SSH connection failed: connect ECONNREFUSED'
    )
  })
})
