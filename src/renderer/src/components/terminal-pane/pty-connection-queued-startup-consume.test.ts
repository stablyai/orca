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

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({ scheduleTerminalWebglAtlasRecovery }))

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

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))

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

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

function spawnOnConnect(transport: MockTransport, ptyId: string): void {
  transport.connect.mockImplementation(async () => {
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as ((id: string) => void) | undefined
    onPtySpawn?.(ptyId)
    return ptyId
  })
}

// Why this suite exists: the queued startup command is spent through onQueuedStartupSpawned, and
// both *when* it fires and *how often* are load-bearing. Spending it before the pty is bound
// unmounts the pane mid-spawn (the entry is what holds its worktree out of the retention-budget
// force-park); spending it on a later respawn drops a command queued after the first launch
// (STA-4876).
describe('connectPanePty queued startup consume', () => {
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

  it('spends the queued startup only after the pty is bound to the tab', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    spawnOnConnect(transport, 'fresh-pty')
    transportFactoryQueue.push(transport)

    const callOrder: string[] = []
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      startup: { command: 'echo queued' },
      updateTabPtyId: vi.fn(() => {
        callOrder.push('updateTabPtyId')
      }),
      onQueuedStartupSpawned: vi.fn(() => {
        callOrder.push('onQueuedStartupSpawned')
      })
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(callOrder).toContain('onQueuedStartupSpawned')
    expect(callOrder.indexOf('updateTabPtyId')).toBeGreaterThanOrEqual(0)
    expect(callOrder.indexOf('updateTabPtyId')).toBeLessThan(
      callOrder.indexOf('onQueuedStartupSpawned')
    )
  })

  it('leaves the queued startup unspent when the spawn never reaches onPtySpawn', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    // A retired/reattached spawn resolves without ever announcing a fresh pty.
    transport.connect.mockImplementation(async () => undefined)
    transportFactoryQueue.push(transport)

    const onQueuedStartupSpawned = vi.fn()
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      startup: { command: 'echo queued' },
      onQueuedStartupSpawned
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    // The next mount must still find the command queued, or it is lost for good.
    expect(onQueuedStartupSpawned).not.toHaveBeenCalled()
  })

  it('keeps a throwing consume from escaping into the spawn', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    // Mirror the transport contract: onPtySpawn is invoked from inside the connect promise, so
    // anything it throws rejects that promise, strands the pane with no pty, and is far worse
    // than the stale queued entry the callback exists to clear.
    let escapedIntoSpawn = false
    transport.connect.mockImplementation(async () => {
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((id: string) => void)
        | undefined
      try {
        onPtySpawn?.('fresh-pty')
      } catch {
        escapedIntoSpawn = true
        return undefined
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)

    const updateTabPtyId = vi.fn()
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      startup: { command: 'echo queued' },
      updateTabPtyId,
      onQueuedStartupSpawned: vi.fn(() => {
        throw new Error('store blew up')
      })
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(escapedIntoSpawn).toBe(false)
    expect(updateTabPtyId).toHaveBeenCalled()
  })
})
