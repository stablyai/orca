import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred, renderHeadlessBuffer } from './pty-connection-test-async'
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

// The connection fixture invokes hooks without mounting React.
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

const { safeFitAndThen } = vi.hoisted(() => ({ safeFitAndThen: vi.fn() }))
vi.mock('@/lib/pane-manager/pane-tree-ops', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeFitAndThen
}))

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
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

  it('repaints overflowed live output when the deadline interrupts an answered snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    let onData: ConnectCallbacks['onData']
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      onData = callbacks.onData
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const fit = createDeferred<boolean>()
    safeFitAndThen.mockReturnValue({ completion: Promise.resolve(true), cancel: vi.fn() })

    const getSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const hidden = 'hidden-before-flood\r\n'
    const overflow = 'v'.repeat(512 * 1024 + 1)
    const done = 'HIDDEN_FLOOD_DONE\r\n'
    getSnapshot
      .mockResolvedValueOnce({ data: hidden, cols: 120, rows: 40, seq: hidden.length })
      .mockResolvedValue({ data: done, cols: 120, rows: 40, seq: hidden.length + overflow.length })
    const pane = createPane(1)
    const deps = createDeps({ isVisibleRef: { current: false }, startup: { command: 'codex' } })
    const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)
    safeFitAndThen.mockClear()
    safeFitAndThen.mockReturnValueOnce({
      completion: fit.promise,
      cancel: vi.fn(() => fit.resolve(false))
    })
    vi.useFakeTimers()
    onData?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    onData?.('v', { seq: hidden.length + 1, rawLength: 1 })
    await flushAsyncTicks(30)
    expect(safeFitAndThen).toHaveBeenCalledTimes(1)
    onData?.(overflow, { seq: hidden.length + overflow.length, rawLength: overflow.length })
    await vi.advanceTimersByTimeAsync(750)
    fit.resolve(true)
    await flushAsyncTicks(30)
    await vi.advanceTimersByTimeAsync(2_000)
    await flushAsyncTicks(30)
    const output = pane.terminal.write.mock.calls.map(([data]) => data).join('')
    expect(output).toContain(done)
    expect(output).not.toContain('main recovery was unavailable')
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    disposable.dispose()
    vi.useRealTimers()
    expect(await renderHeadlessBuffer([output])).toEqual(await renderHeadlessBuffer([done]))
  })
})
