import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
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
  scheduleImagePasteWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleImagePasteWebglAtlasRecovery: vi.fn(),
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
  scheduleImagePasteWebglAtlasRecovery
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

  it('keeps recovery pending when hidden output arrives during an in-flight snapshot', async () => {
    let visibilityState: DocumentVisibilityState = 'visible'
    // Fire-all like a real event target: both the pane resync and stale-visibility trust handlers listen for visibilitychange.
    const visibilityChangeListeners: (() => void)[] = []
    const visibilityChangeHandler = {
      current: (): void => {
        for (const listener of visibilityChangeListeners) {
          listener()
        }
      }
    }
    ;(globalThis as { document?: Document }).document = {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') {
          visibilityChangeListeners.push(listener as () => void)
        }
      }),
      removeEventListener: vi.fn()
    } as unknown as Document

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
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
    const firstSnapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
    }>()
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const visibleLive = 'visible-before-hide\r\n'
    const hiddenAgain = 'hidden-during-restore\r\n'
    getMainBufferSnapshot.mockReturnValueOnce(firstSnapshot.promise).mockResolvedValueOnce({
      data: 'snapshot-after-hidden-again\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length + visibleLive.length + hiddenAgain.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    visibilityState = 'visible'
    capturedDataCallback.current?.(visibleLive, {
      seq: hidden.length + visibleLive.length,
      rawLength: visibleLive.length
    })
    await flushAsyncTicks(2)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

    ;(deps.isVisibleRef as { current: boolean }).current = false
    visibilityState = 'hidden'
    capturedDataCallback.current?.(hiddenAgain, {
      seq: hidden.length + visibleLive.length + hiddenAgain.length,
      rawLength: hiddenAgain.length
    })
    transport.resize.mockClear()
    signalPty.mockClear()
    firstSnapshot.resolve({
      data: 'snapshot-before-hidden-again\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + visibleLive.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-before-hidden-again\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hiddenAgain, expect.any(Function))
    expect(transport.resize).not.toHaveBeenCalled()
    expect(signalPty).not.toHaveBeenCalledWith('pty-id', 'SIGWINCH')

    ;(deps.isVisibleRef as { current: boolean }).current = true
    visibilityState = 'visible'
    visibilityChangeHandler.current?.()
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-after-hidden-again\r\n',
      expect.any(Function)
    )
    disposable.dispose()
  })

  it('does not signal SIGWINCH after hidden-backlog snapshot replay when dimensions are unchanged', async () => {
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
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-state\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)
    transport.resize.mockClear()
    signalPty.mockClear()

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith('snapshot-state\r\n', expect.any(Function))
    expect(transport.resize).not.toHaveBeenCalledWith(120, 40)
    expect(signalPty).not.toHaveBeenCalledWith('pty-id', 'SIGWINCH')
    disposable.dispose()
  })

  it('skips a background-origin alternate-screen frame and pulses a PTY repaint', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current:
        | ((
            data: string,
            meta?: { seq?: number; rawLength?: number; background?: boolean }
          ) => void)
        | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
    const staleHiddenTuiFrame = '\x1b[2Khidden-width codex composer\r\n'

    const pane = createPane(1)
    pane.terminal.cols = 133
    pane.terminal.rows = 40
    ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: true }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)
    getMainBufferSnapshot.mockClear()
    transport.resize.mockClear()
    signalPty.mockClear()

    capturedDataCallback.current?.(staleHiddenTuiFrame, {
      seq: staleHiddenTuiFrame.length,
      rawLength: staleHiddenTuiFrame.length,
      background: true
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith(staleHiddenTuiFrame, expect.any(Function))
    expect(transport.resize).toHaveBeenCalledWith(132, 40)
    expect(transport.resize).toHaveBeenCalledWith(133, 40)
    expect(signalPty).not.toHaveBeenCalledWith('pty-id', 'SIGWINCH')
    disposable.dispose()
  })

  it('does not forward terminal resizes while the pane is hidden', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const manager = createManager(1)
    const isVisibleRef = { current: false }
    const deps = createDeps({ isVisibleRef })

    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    const onResizeMock = pane.terminal.onResize as unknown as {
      mock: { calls: [[(event: { cols: number; rows: number }) => void] | []] }
    }
    const resizeHandler = onResizeMock.mock.calls[0]?.[0]
    if (!resizeHandler) {
      throw new Error('Expected terminal resize handler to be registered')
    }

    transport.resize.mockClear()
    resizeHandler({ cols: 121, rows: 41 })

    expect(transport.resize).not.toHaveBeenCalled()

    isVisibleRef.current = true
    resizeHandler({ cols: 122, rows: 42 })

    expect(transport.resize).toHaveBeenCalledWith(122, 42, { claim: true })
    disposable.dispose()
  })
})
