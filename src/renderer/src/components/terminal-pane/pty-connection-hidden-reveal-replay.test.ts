import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
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
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

function writtenText(pane: ReturnType<typeof createPane>): string {
  return pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
}

function writeCallOrder(pane: ReturnType<typeof createPane>, fragment: string): number | undefined {
  const index = pane.terminal.write.mock.calls.findIndex((call) =>
    String(call[0]).includes(fragment)
  )
  return index !== -1 ? pane.terminal.write.mock.invocationCallOrder[index] : undefined
}

describe('hidden-to-visible PTY reveal replay', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    mockStoreState.settings = {
      ...mockStoreState.settings,
      terminalMainSideEffectAuthority: true
    } as StoreState['settings']
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('replays the current buffer on visibility sync, then resumes live frames', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const snapshot = 'authoritative frame 000010'
    const live = 'authoritative frame 000011'
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: `${snapshot}\r\n`,
      cols: 100,
      rows: 30,
      seq: 64
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const isVisibleRef = { current: false }
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({ isVisibleRef }) as never
    ) as {
      syncProcessTracking: () => void
      dispose: () => void
    }
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('stale hidden frame\r\n', { seq: 16, rawLength: 18 })
    pane.terminal.write.mockClear()
    getMainBufferSnapshot.mockClear()

    // Reveal through the pane visibility hook only. Production tab reveal can
    // race the restore marker and the backlog-recovery call.
    isVisibleRef.current = true
    binding.syncProcessTracking()
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(writtenText(pane)).toContain(snapshot)

    capturedDataCallback.current?.(live, {
      seq: 64 + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(writtenText(pane)).toContain(live)
    expect(writeCallOrder(pane, snapshot)).toBeLessThan(writeCallOrder(pane, live) ?? 0)

    binding.dispose()
  })

  it('retires a duplicate hidden renderer once so the revealed pane can restore', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'authoritative frame 000010\r\n',
      cols: 100,
      rows: 30,
      seq: 64
    })

    const connectGated = async (
      paneId: number,
      isVisibleRef: { current: boolean }
    ): Promise<{
      pane: ReturnType<typeof createPane>
      binding: { syncProcessTracking: () => void; dispose: () => void }
      dataCallback: (data: string, meta?: { seq?: number; rawLength?: number }) => void
    }> => {
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const pane = createPane(paneId)
      const manager = createManager(paneId)
      const binding = connectPanePty(
        pane as never,
        manager as never,
        createDeps({ isVisibleRef, restoredLeafId: pane.leafId }) as never
      ) as { syncProcessTracking: () => void; dispose: () => void }
      await flushAsyncTicks(6)
      return { pane, binding, dataCallback: capturedDataCallback.current! }
    }

    const retainedVisibleRef = { current: false }
    const duplicateVisibleRef = { current: false }
    const retained = await connectGated(1, retainedVisibleRef)
    const duplicate = await connectGated(2, duplicateVisibleRef)

    retained.dataCallback('stale hidden frame\r\n', { seq: 16, rawLength: 18 })
    duplicate.dataCallback('stale hidden frame\r\n', { seq: 16, rawLength: 18 })
    const setHiddenRendererPty = window.api.pty.setHiddenRendererPty as unknown as ReturnType<
      typeof vi.fn
    >
    expect(setHiddenRendererPty).toHaveBeenCalledWith('pty-id', true)
    setHiddenRendererPty.mockClear()
    getMainBufferSnapshot.mockClear()
    retained.pane.terminal.write.mockClear()

    duplicate.binding.dispose()
    retainedVisibleRef.current = true
    retained.binding.syncProcessTracking()
    await flushAsyncTicks(20)

    expect(setHiddenRendererPty).toHaveBeenCalledTimes(1)
    expect(setHiddenRendererPty).toHaveBeenCalledWith('pty-id', false)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
    expect(writtenText(retained.pane)).toContain('authoritative frame 000010')

    retained.binding.dispose()
  })
})
