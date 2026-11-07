import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

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

vi.mock('../../render-health/terminal-webgl-atlas-recovery', () => ({
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
  const { buildAgentStatusModuleMock } =
    await import('../test-fixtures/pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('../../titles/cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/agent-session/accounts/codex/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

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
      const transport = transportFactoryQueue.shift()
      if (!transport) {
        throw new Error('No remote mock transport queued')
      }
      return transport
    }
  )
}))

vi.mock('../../pty-transport/delivery/pty-dispatcher', async (importOriginal) => {
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
describe('connectPanePty queued startup consume', () => {
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
    vi.unstubAllGlobals()
  })

  it('spends the queued startup only after the pty is bound to the tab', async () => {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks2 = await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
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

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks2)
    )
    await flushAsyncTicks(20)

    expect(callOrder).toContain('onQueuedStartupSpawned')
    expect(callOrder.indexOf('updateTabPtyId')).toBeGreaterThanOrEqual(0)
    expect(callOrder.indexOf('updateTabPtyId')).toBeLessThan(
      callOrder.indexOf('onQueuedStartupSpawned')
    )
  })

  it('leaves the queued startup unspent when the spawn never reaches onPtySpawn', async () => {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
    const transport = createMockTransport()
    // A retired/reattached spawn resolves without ever announcing a fresh pty.
    transport.connect.mockImplementation(async () => undefined)
    transportFactoryQueue.push(transport)

    const onQueuedStartupSpawned = vi.fn()
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      startup: { command: 'echo queued' },
      onQueuedStartupSpawned
    })

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
    )
    await flushAsyncTicks(20)

    // The next mount must still find the command queued, or it is lost for good.
    expect(onQueuedStartupSpawned).not.toHaveBeenCalled()
  })

  it('keeps a throwing consume from escaping into the spawn', async () => {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
    const transport = createMockTransport()
    // onPtySpawn runs inside connect; callback throws would reject spawn and strand the pane, so cleanup must not throw.
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

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks4)
    )
    await flushAsyncTicks(20)

    expect(escapedIntoSpawn).toBe(false)
    expect(updateTabPtyId).toHaveBeenCalled()
  })
})
