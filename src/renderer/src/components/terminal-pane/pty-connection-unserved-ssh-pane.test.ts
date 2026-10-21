import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { createPane, createManager, type MockTransport } from './pty-connection-test-pane-fixtures'
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
  notifyCodexPaneBoundForStaleSweep,
  requestTerminalPaneRecovery
} = vi.hoisted(() => ({
  requestTerminalPaneRecovery: vi.fn(),
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

vi.mock('./terminal-pane-recovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestTerminalPaneRecovery
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

function sshApi() {
  return {
    connect: vi.mocked(window.api.ssh.connect),
    needsPassphrasePrompt: vi.mocked(window.api.ssh.needsPassphrasePrompt)
  }
}

function mountUnservedPane(paneId = 1) {
  const deps = createDeps()
  const binding = connectPane(paneId, deps)
  return { deps, binding }
}

let connectPane: (paneId: number, deps: ReturnType<typeof createDeps>) => { dispose: () => void }

// A relay-era `ssh:` row that has not converted to its managed runtime yet.
describe('a pane on an unconverted SSH row', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = {
      ...createInitialStoreState(() => mockStoreState),
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'disconnected' }]])
    }
    await installTerminalTestGlobals()
    const { connectPanePty } = await import('./pty-connection')
    connectPane = (paneId, deps) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the connection fields exercised here without a real terminal or DOM.
      connectPanePty(createPane(paneId) as never, createManager(paneId) as never, deps as never)
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('never spawns or attaches, and dials the target once on mount', async () => {
    const { deps } = mountUnservedPane()
    await flushAsyncTicks(10)

    expect(createdTransportOptions).toEqual([])
    expect(sshApi().connect).toHaveBeenCalledExactlyOnceWith({
      targetId: 'conn-1',
      automatic: true
    })
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('dials once for every pane of the target while a connect is in flight', async () => {
    const connect = createDeferred<null>()
    sshApi().connect.mockReturnValueOnce(connect.promise)

    mountUnservedPane(1)
    mountUnservedPane(2)
    await flushAsyncTicks(10)

    expect(sshApi().connect).toHaveBeenCalledOnce()
    connect.resolve(null)
  })

  it('waits for the user on a passphrase target', async () => {
    sshApi().needsPassphrasePrompt.mockResolvedValue(true)

    mountUnservedPane()
    await flushAsyncTicks(10)

    expect(sshApi().connect).not.toHaveBeenCalled()
  })

  it('does not dial a removed target or one that is already connected', async () => {
    mockStoreState = { ...mockStoreState, sshTargetLabels: new Map() }
    mountUnservedPane(1)
    mockStoreState = {
      ...mockStoreState,
      sshTargetLabels: undefined,
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
    }
    mountUnservedPane(2)
    await flushAsyncTicks(10)

    expect(sshApi().needsPassphrasePrompt).not.toHaveBeenCalled()
    expect(sshApi().connect).not.toHaveBeenCalled()
  })

  it('does not dial after the pane is disposed during the passphrase probe', async () => {
    const probe = createDeferred<boolean>()
    sshApi().needsPassphrasePrompt.mockReturnValueOnce(probe.promise)

    const { binding } = mountUnservedPane()
    await flushAsyncTicks(3)
    binding.dispose()
    probe.resolve(false)
    await flushAsyncTicks(10)

    expect(sshApi().connect).not.toHaveBeenCalled()
  })

  it('reports a failed dial on the pane', async () => {
    sshApi().connect.mockRejectedValueOnce(new Error('host unreachable'))

    const { deps } = mountUnservedPane()
    await flushAsyncTicks(10)

    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
      expect.any(Number),
      'SSH connection failed: host unreachable'
    )
  })

  it('leaves recovery to the overlay when typed input cannot be delivered', async () => {
    const pane = createPane(1)
    const { connectPanePty } = await import('./pty-connection')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the connection fields exercised here without a real terminal or DOM.
    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(10)

    vi.mocked(pane.terminal.onData).mock.calls[0]?.[0]('ls\r')
    await flushAsyncTicks(10)

    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })
})
