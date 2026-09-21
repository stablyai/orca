import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
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
  notifyCodexPaneBoundForStaleSweep,
  requestTerminalPaneRecovery
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  requestTerminalPaneRecovery: vi.fn(async () => true)
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

// Only the request is spied: connect still needs the real generation/instance registry.
vi.mock('./terminal-pane-recovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestTerminalPaneRecovery
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

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

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

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

describe('fresh spawn leaves a local pane unbound', () => {
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

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  it('remounts the pane when the spawn resolves without a PTY id', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    // A spawn that produced nothing: no id returned and nothing bound after it.
    transport.connect.mockImplementation(async () => null)
    transportFactoryQueue.push(transport)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ tabId: 'tab-unbound-spawn' }) as never
    )
    await flushAsyncTicks(40)

    expect(transport.connect).toHaveBeenCalled()
    expect(requestTerminalPaneRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 'tab-unbound-spawn',
        ptyId: null,
        reason: 'spawn-left-pane-unbound'
      })
    )
  })

  // The direct-SSH ledger runs its own retry; a second remount would race it.
  it('leaves recovery to the direct SSH retry ledger', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockResolvedValueOnce(null)
    transportFactoryQueue.push(transport)
    const settleDirectSshPaneRetry = vi.fn()
    const pendingRetry = {
      attemptId: 'attempt-1',
      authority: { targetId: 'target-a', providerEpoch: 'epoch-1', connectionGeneration: 3 },
      tabGeneration: 7,
      startedAt: 1
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'target-a', displayName: 'orca' }],
      sshConnectionStates: new Map([
        [
          'target-a',
          {
            targetId: 'target-a',
            status: 'connected',
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          }
        ]
      ]),
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry },
      settleDirectSshPaneRetry
    } as StoreState

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(40)

    // The lease settled, so the unbound branch ran and deliberately skipped recovery.
    expect(settleDirectSshPaneRetry).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', attemptId: 'attempt-1' })
    )
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'spawn-left-pane-unbound' })
    )
  })

  it('does not remount when the spawn bound a PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-bound')
    transportFactoryQueue.push(transport)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ tabId: 'tab-bound-spawn' }) as never
    )
    await flushAsyncTicks(40)

    expect(requestTerminalPaneRecovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'spawn-left-pane-unbound' })
    )
  })
})
