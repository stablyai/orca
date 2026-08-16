import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ABORT_TRUNCATED_CONTROL_STRING,
  buildSnapshotReplayPrologue,
  RESET_AFTER_BYTE_GAP
} from '../../../../shared/terminal-mode-reset-profiles'
import {
  flushAsyncTicks,
  renderHeadlessTerminalState,
  createDeferred
} from './pty-connection-test-async'
import { NORMAL_BUFFER_PROLOGUE } from './pty-connection-test-constants'
import { createRect } from './pty-connection-test-dom'
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

  it('restores overflowed hidden remote runtime output from its serialized snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    // Why: with the skip grammar gone, remote-runtime model restore is latched by background-queue overflow, not per-chunk scanning.
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible remote output\r\n'
    transport.serializeBuffer = vi.fn().mockResolvedValue({
      data: 'remote snapshot with hidden remote output\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length + live.length,
      source: 'headless'
    })
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'remote:env-1@@terminal-1'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ isVisibleRef: { current: false } })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden, expect.any(Function))

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(transport.serializeBuffer).toHaveBeenCalledWith({ scrollbackRows: 5000 })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      expect.stringContaining('remote snapshot with hidden remote output'),
      expect.any(Function)
    )
    disposable.dispose()
  })

  it('preserves the painted normal buffer when a successful hidden restore has no image', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible remote output\r\n'
    transport.serializeBuffer = vi.fn()
    transport.serializeBufferOutcome = vi.fn().mockResolvedValue({
      availability: { kind: 'snapshot' },
      snapshot: {
        data: '',
        scrollbackAnsi: '',
        cols: 120,
        rows: 40,
        seq: hidden.length + live.length,
        source: 'headless'
      }
    })
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'remote:env-1@@terminal-1'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const deps = createDeps({ isVisibleRef: { current: false } })
    const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)
    const writeStart = pane.terminal.write.mock.calls.length

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    const restoreWrites = pane.terminal.write.mock.calls
      .slice(writeStart)
      .map(([data]) => String(data))
    const paintedFrame = Array.from({ length: 8 }, (_, index) => `painted-frame-${index + 1}`).join(
      '\r\n'
    )
    const actual = await renderHeadlessTerminalState([paintedFrame, ...restoreWrites], 120, 4)
    const expected = await renderHeadlessTerminalState(
      [paintedFrame, ...restoreWrites.filter((data) => data === live)],
      120,
      4
    )
    expect(actual).toEqual(expected)
    // The imageless snapshot skips the repaint, but the gap still happened — so
    // the pen is grounded anyway, with the live-path constant since nothing
    // repaints over whatever is still running here.
    expect(restoreWrites).toContain(RESET_AFTER_BYTE_GAP)
    expect(transport.serializeBufferOutcome).toHaveBeenCalledTimes(1)
    expect(transport.serializeBuffer).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('defers inactive split-pane plain hidden output restore until the pane returns', async () => {
    const { resetHiddenOutputRestoreSchedulerForTests } =
      await import('./hidden-output-restore-scheduler')
    let disposable: { dispose: () => void } | null = null
    try {
      const { connectPanePty } = await import('./pty-connection')
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
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'inactive snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })

      const pane = createPane(1)
      const manager = createManager(2)
      manager.getActivePane.mockReturnValue({ id: 2 })
      const deps = createDeps({ isVisibleRef: { current: false } })
      disposable = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      // Why: overflowing the background queue latches the model restore now — the per-chunk skip grammar is gone.
      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const live = 'visible inactive output\r\n'
      expect(capturedDataCallback.current).not.toBeNull()
      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      await flushAsyncTicks(4)

      expect(getMainBufferSnapshot).not.toHaveBeenCalled()

      // Why: inactive split restore is frame-spaced, so wait past one scheduler tick without fake timers for xterm callbacks.
      await new Promise((resolve) => setTimeout(resolve, 30))
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
      expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden)
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining('inactive snapshot'),
        expect.any(Function)
      )
    } finally {
      disposable?.dispose()
      resetHiddenOutputRestoreSchedulerForTests()
    }
  })

  it('drops a deferred inactive hidden restore when the pane is hidden again', async () => {
    const { resetHiddenOutputRestoreSchedulerForTests } =
      await import('./hidden-output-restore-scheduler')
    let disposable: { dispose: () => void } | null = null
    try {
      const { connectPanePty } = await import('./pty-connection')
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
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'inactive snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })

      const pane = createPane(1)
      const manager = createManager(2)
      manager.getActivePane.mockReturnValue({ id: 2 })
      const deps = createDeps({ isVisibleRef: { current: false } })
      disposable = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      // Why: overflow latches the model restore (no skip grammar remains).
      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const live = 'visible inactive output\r\n'
      expect(capturedDataCallback.current).not.toBeNull()
      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      ;(deps.isVisibleRef as { current: boolean }).current = false
      await new Promise((resolve) => setTimeout(resolve, 30))
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        'inactive snapshot\r\n',
        expect.any(Function)
      )
    } finally {
      disposable?.dispose()
      resetHiddenOutputRestoreSchedulerForTests()
    }
  })

  it('retries null remote snapshots for overflowed hidden runtime output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.serializeBuffer = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      data: 'remote recovered snapshot\r\n',
      cols: 120,
      rows: 40,
      seq: 80,
      source: 'headless'
    })
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'remote:env-1@@terminal-1'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ isVisibleRef: { current: false } })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    // Why: overflow latches the model restore (no skip grammar remains).
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const firstLive = 'first visible output\r\n'
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(firstLive, {
      seq: hidden.length + firstLive.length,
      rawLength: firstLive.length
    })
    await flushAsyncTicks(20)

    expect(transport.serializeBuffer).toHaveBeenCalledTimes(1)
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('Orca skipped hidden terminal output'),
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'remote recovered snapshot\r\n',
      expect.any(Function)
    )

    await new Promise((resolve) => setTimeout(resolve, 80))
    await flushAsyncTicks(20)

    expect(transport.serializeBuffer).toHaveBeenCalledTimes(2)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      expect.stringContaining('remote recovered snapshot'),
      expect.any(Function)
    )
    disposable.dispose()
  })

  // The conditional buffer switch is the riskiest logic in the replay prologue,
  // and the pane mock is on the normal buffer everywhere else — so a stubbed
  // `() => false` would pass the whole suite. Put the pane on the alt screen and
  // pin that a normal-buffer snapshot really does emit the `?1049l` unstick.
  it('emits the alt-screen unstick when the pane is on alt and the model is not', async () => {
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
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    // The gap ate the TUI's own `?1049l`, so the renderer is still on alt.
    pane.terminal.buffer.active.type = 'alternate'
    const deps = createDeps({ isVisibleRef: { current: false } })
    const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
    const prologue = written.find((data) => data.startsWith(ABORT_TRUNCATED_CONTROL_STRING))
    expect(prologue).toBeDefined()
    expect(prologue).toContain('\x1b[?1049l')
    expect(prologue).not.toBe(NORMAL_BUFFER_PROLOGUE)
    disposable.dispose()
  })

  // Why: pins the switch-off hidden fallback chain — 2MB lossy cap drops the backlog, latches restore, and reveal repaints from the model snapshot.
  it('restores hidden backlog overflow from the main terminal snapshot on foreground output', async () => {
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
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalled()

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.resize).toHaveBeenCalledWith(100, 30)
    expect(pane.terminal.write).toHaveBeenCalledWith(NORMAL_BUFFER_PROLOGUE, expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith('snapshot-state\r\n', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('rebuilds normal and alternate buffers from an authoritative alternate snapshot', async () => {
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
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after-altscreen\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'altscreen-snapshot\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length,
      alternateScreen: true,
      scrollbackAnsi: 'preserved-shell-history\r\n'
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalled()

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.write).toHaveBeenCalledWith(NORMAL_BUFFER_PROLOGUE, expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'preserved-shell-history\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      buildSnapshotReplayPrologue({ targetAlternateScreen: true, paneOnAlternateScreen: false }),
      expect.any(Function)
    )
    const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0]
    )
    expect(writes.indexOf('preserved-shell-history\r\n')).toBeLessThan(
      writes.indexOf(
        buildSnapshotReplayPrologue({ targetAlternateScreen: true, paneOnAlternateScreen: false })
      )
    )
    expect(
      writes.indexOf(
        buildSnapshotReplayPrologue({ targetAlternateScreen: true, paneOnAlternateScreen: false })
      )
    ).toBeLessThan(writes.indexOf('altscreen-snapshot\r\n'))
    expect(pane.terminal.write).toHaveBeenCalledWith('altscreen-snapshot\r\n', expect.any(Function))
    disposable.dispose()
  })

  it('keeps a hidden-output alt frame at the capture grid below the fit floor', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    let onData: ConnectCallbacks['onData']
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      onData = callbacks.onData
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    getMainBufferSnapshot.mockResolvedValue({
      data: 'TOO-WIDE-ALT-FRAME',
      frameRestoreAnsi: '\x1b[?1004h\x1b[?25l',
      cols: 120,
      rows: 40,
      seq: hidden.length + 1,
      alternateScreen: true,
      scrollbackAnsi: 'preserved history'
    })
    const pane = createPane(1)
    pane.terminal.cols = 80
    pane.terminal.rows = 24
    const writes: string[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    })
    pane.container.getBoundingClientRect = vi.fn(() => createRect(4, 3))
    const deps = createDeps({ isVisibleRef: { current: false } })
    const binding = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)
    onData?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
    _dispatchPtyModelRestoreNeededForTest({
      id: 'pty-id',
      reason: 'hidden-drop',
      markerSeq: hidden.length + 1
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    const { requestTerminalBacklogRecovery } =
      await import('@/lib/pane-manager/pane-terminal-output-scheduler')
    requestTerminalBacklogRecovery(pane.terminal as never)
    await flushAsyncTicks(20)

    expect(writes.join('')).toContain('TOO-WIDE-ALT-FRAME')
    expect(writes.join('')).toContain('preserved history')
    expect(writes.filter((write) => write.includes('TOO-WIDE-ALT-FRAME'))).toHaveLength(1)
    expect(pane.terminal.resize).toHaveBeenCalledWith(120, 40)
    expect(transport.resize).not.toHaveBeenCalled()
    binding.dispose()
  })

  it('drains foreground output after a renderer-sourced hidden-backlog snapshot without seq', async () => {
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
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after-renderer-fallback\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'renderer-snapshot-state\r\n',
      cols: 100,
      rows: 30,
      source: 'renderer'
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
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith(
      'renderer-snapshot-state\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('slices abandoned pending chunks against a replay that already painted', async () => {
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
    const snapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
      pendingDeliveryStartSeq: number
    }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    const hidden = 'hidden-codex-output\r\n'
    const coveredLive = 'LIVE_DUP_LINE\r\n'
    const afterAbandon = 'AFTER_ABANDON\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)
    expect(capturedDataCallback.current).not.toBeNull()

    vi.useFakeTimers()
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(coveredLive, {
      seq: hidden.length + coveredLive.length,
      rawLength: coveredLive.length
    })
    await flushAsyncTicks(4)

    const heldCallbacks: (() => void)[] = []
    pane.terminal.write.mockImplementation(function write(
      data: string,
      callback?: () => void
    ): void {
      if (callback) {
        heldCallbacks.push(callback)
      }
      void data
    })
    snapshot.resolve({
      data: 'SNAP_STATE\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + coveredLive.length,
      pendingDeliveryStartSeq: 0
    })
    await flushAsyncTicks(6)

    vi.advanceTimersByTime(750)
    await flushAsyncTicks(10)

    const writtenAfterAbandon = pane.terminal.write.mock.calls.map(([data]) => data as string)
    expect(writtenAfterAbandon.join('')).not.toContain('LIVE_DUP_LINE')

    pane.terminal.write.mockClear()
    capturedDataCallback.current?.(coveredLive, {
      seq: hidden.length + coveredLive.length,
      rawLength: coveredLive.length
    })
    await flushAsyncTicks(4)
    expect(pane.terminal.write.mock.calls.map(([data]) => data as string).join('')).not.toContain(
      'LIVE_DUP_LINE'
    )

    capturedDataCallback.current?.(afterAbandon, {
      seq: hidden.length + coveredLive.length + afterAbandon.length,
      rawLength: afterAbandon.length
    })
    await flushAsyncTicks(4)
    expect(pane.terminal.write.mock.calls.map(([data]) => data as string).join('')).toContain(
      'AFTER_ABANDON'
    )

    heldCallbacks.forEach((callback) => callback())
    disposable.dispose()
  })
})
