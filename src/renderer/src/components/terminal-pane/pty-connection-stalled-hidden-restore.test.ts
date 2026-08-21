import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESET_AFTER_BYTE_GAP } from '../../../../shared/terminal-mode-reset-profiles'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { NORMAL_BUFFER_PROLOGUE } from './pty-connection-test-constants'
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

  it('abandons a stalled hidden restore with reset, warning, then pending foreground', async () => {
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
    const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    const hidden = 'hidden-codex-output\r\n'
    const firstLive = 'first-live-output\r\n'
    const secondLive = 'second-live-output\r\n'

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
    capturedDataCallback.current?.(firstLive, {
      seq: hidden.length + firstLive.length,
      rawLength: firstLive.length
    })
    await flushAsyncTicks(4)
    capturedDataCallback.current?.(secondLive, {
      seq: hidden.length + firstLive.length + secondLive.length,
      rawLength: secondLive.length
    })

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(firstLive, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(secondLive, expect.any(Function))

    vi.advanceTimersByTime(749)
    await flushAsyncTicks(4)
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('main recovery was unavailable'),
      expect.any(Function)
    )

    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)

    const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
    const warningIndex = written.findIndex((data) => data.includes('main recovery was unavailable'))
    const combinedLiveIndex = written.indexOf(firstLive + secondLive)
    expect(warningIndex).toBeGreaterThanOrEqual(0)
    expect(written[warningIndex - 1]).toBe(RESET_AFTER_BYTE_GAP)
    // Exactly one: writeRestoreUnavailableWarning already grounds the gap, so a
    // second unconditional write here was pure duplication.
    expect(written.filter((data) => data === RESET_AFTER_BYTE_GAP)).toHaveLength(1)
    expect(combinedLiveIndex).toBeGreaterThan(warningIndex)

    snapshot.resolve({
      data: 'late-snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + firstLive.length + secondLive.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'late-snapshot-state\r\n',
      expect.any(Function)
    )
    disposable.dispose()
  })

  // STA-4042: the hidden-delivery gate drops renderer-bound bytes, so the span it
  // ate can contain the `ESC[22m` closing a bold run. Abandoning the restore means
  // no snapshot will rebuild the buffer, so unless the pen is cleared here every
  // drained and subsequent cell inherits bold — the "regular text renders bold"
  // field report.
  it('clears the SGR pen before draining abandoned foreground chunks', async () => {
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
    const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    // The dropped span is where `ESC[22m` would have been; the pen is left bold.
    const hidden = '\x1b[1mbold-run-opened-while-hidden\r\n'
    const live = 'live-after-reveal\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(4)

    // Let the foreground deadline expire so the restore is abandoned.
    vi.advanceTimersByTime(750)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)

    const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
    const resetIndex = written.indexOf(RESET_AFTER_BYTE_GAP)
    const liveIndex = written.findIndex((data) => data.includes('live-after-reveal'))
    expect(resetIndex).toBeGreaterThanOrEqual(0)
    expect(liveIndex).toBeGreaterThanOrEqual(0)
    expect(resetIndex).toBeLessThan(liveIndex)
    disposable.dispose()
  })

  it('grounds byte-gap state before a remote restore re-arms', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const remotePtyId = 'remote:env-1@@terminal-rearm'
    const transport = createMockTransport(remotePtyId)
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return remotePtyId
    })
    const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
    transport.serializeBuffer = vi.fn().mockReturnValue(snapshot.promise)
    transportFactoryQueue.push(transport)
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'remote-live-after-rearm\r\n'

    const pane = createPane(1)
    const deps = createDeps({ isVisibleRef: { current: false } })
    const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(4)

    vi.advanceTimersByTime(750)
    await flushAsyncTicks(10)

    const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
    const resetIndex = written.indexOf(RESET_AFTER_BYTE_GAP)
    const liveIndex = written.indexOf(live)
    expect(resetIndex).toBeGreaterThanOrEqual(0)
    expect(liveIndex).toBeGreaterThan(resetIndex)
    // The re-arm arm grounds in rearmRemoteHiddenOutputRestoreInsteadOfWarning,
    // so the abandon body must not ground a second time.
    expect(written.filter((data) => data === RESET_AFTER_BYTE_GAP)).toHaveLength(1)
    expect(written.join('')).not.toContain('main recovery was unavailable')

    disposable.dispose()
  })

  it('falls back after repeated null hidden restore retries and drains blocked foreground', async () => {
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
    getMainBufferSnapshot.mockResolvedValue(null)
    const hidden = 'hidden-codex-output\r\n'
    const live = 'visible-after-null-retries\r\n'

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
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(10)

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
      vi.advanceTimersByTime(50)
      vi.advanceTimersByTime(0)
      await flushAsyncTicks(10)
    }

    const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
    const warningIndex = written.findIndex((data) => data.includes('main recovery was unavailable'))
    const liveIndex = written.indexOf(live)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(4)
    expect(warningIndex).toBeGreaterThanOrEqual(0)
    expect(liveIndex).toBeGreaterThan(warningIndex)
    // This arm gives up on recovery too, so the gap is grounded exactly once
    // before the blocked foreground is drained under it.
    expect(written.filter((data) => data === RESET_AFTER_BYTE_GAP)).toHaveLength(1)
    expect(written.indexOf(RESET_AFTER_BYTE_GAP)).toBeLessThan(liveIndex)
    disposable.dispose()
  })

  it('drops pending foreground overflow when a stalled hidden restore falls back', async () => {
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
    getMainBufferSnapshot.mockReturnValue(
      createDeferred<{ data: string; cols: number; rows: number; seq: number }>().promise
    )
    const hidden = 'hidden-codex-output\r\n'
    const liveOverflow = 'v'.repeat(512 * 1024 + 1)

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
    capturedDataCallback.current?.(liveOverflow, {
      seq: hidden.length + liveOverflow.length,
      rawLength: liveOverflow.length
    })
    await flushAsyncTicks(4)

    await vi.advanceTimersByTimeAsync(750)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith(
      expect.stringContaining('main recovery was unavailable'),
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(liveOverflow, expect.any(Function))
    disposable.dispose()
  })

  it('coalesces tiny pending foreground chunks when stalled hidden restore falls back', async () => {
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
    getMainBufferSnapshot.mockReturnValue(
      createDeferred<{ data: string; cols: number; rows: number; seq: number }>().promise
    )
    const hidden = 'hidden-codex-output\r\n'
    const chunkCount = 2_000
    const liveChunk = 'x'

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
    for (let index = 0; index < chunkCount; index += 1) {
      capturedDataCallback.current?.(liveChunk, {
        seq: hidden.length + index + 1,
        rawLength: liveChunk.length
      })
    }
    await flushAsyncTicks(4)

    vi.advanceTimersByTime(750)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)

    const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
    const warningIndex = written.findIndex((data) => data.includes('main recovery was unavailable'))
    const combinedLive = liveChunk.repeat(chunkCount)
    const liveWrites = written.filter((data) => data === combinedLive)
    expect(warningIndex).toBeGreaterThanOrEqual(0)
    expect(liveWrites).toHaveLength(1)
    expect(written.indexOf(combinedLive)).toBeGreaterThan(warningIndex)

    disposable.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps foreground output when hidden-backlog snapshot recovery is unavailable', async () => {
    const pendingTimeouts: {
      canceled: boolean
      delay: number
      fn: () => void
      id: number
    }[] = []
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    let nextTimeoutId = 1
    globalThis.setTimeout = vi.fn((fn: () => void, delay?: number) => {
      const timeout = {
        canceled: false,
        delay: typeof delay === 'number' ? delay : 0,
        fn,
        id: nextTimeoutId++
      }
      pendingTimeouts.push(timeout)
      return timeout.id as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = vi.fn((id: ReturnType<typeof setTimeout>) => {
      const numericId = id as unknown as number
      const timeout = pendingTimeouts.find((candidate) => candidate.id === numericId)
      if (timeout) {
        timeout.canceled = true
      }
    }) as unknown as typeof clearTimeout

    const runNextTimeoutWithDelay = async (delay: number): Promise<void> => {
      const index = pendingTimeouts.findIndex(
        (timeout) => !timeout.canceled && timeout.delay === delay
      )
      expect(index).toBeGreaterThanOrEqual(0)
      const [timeout] = pendingTimeouts.splice(index, 1)
      timeout.fn()
      await flushAsyncTicks(20)
    }
    const drainTimeoutsWithDelay = async (delay: number): Promise<void> => {
      while (pendingTimeouts.some((timeout) => !timeout.canceled && timeout.delay === delay)) {
        await runNextTimeoutWithDelay(delay)
      }
    }

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
      getMainBufferSnapshot.mockResolvedValue(null)

      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const live = 'foreground-after-unavailable\r\n'
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false }
      })
      disposable = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        expect.stringContaining(live),
        expect.any(Function)
      )

      await runNextTimeoutWithDelay(50)
      await runNextTimeoutWithDelay(50)
      await runNextTimeoutWithDelay(50)
      await drainTimeoutsWithDelay(0)

      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(4)
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining(
          'Orca skipped hidden terminal output because main recovery was unavailable.'
        ),
        expect.any(Function)
      )
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining(live),
        expect.any(Function)
      )
    } finally {
      disposable?.dispose()
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  it('keeps a newer same-PTY hidden restore after a timed-out snapshot resolves late', async () => {
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
    const firstSnapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
    }>()
    const secondSnapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
    }>()
    getMainBufferSnapshot
      .mockReturnValueOnce(firstSnapshot.promise)
      .mockReturnValueOnce(secondSnapshot.promise)
    const firstHidden = 'first-hidden-output\r\n'
    const firstLive = 'first-live-output\r\n'
    const secondHidden = 'second-hidden-output\r\n'
    const secondLive = 'second-live-output\r\n'

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
    capturedDataCallback.current?.(firstHidden, {
      seq: firstHidden.length,
      rawLength: firstHidden.length
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(firstLive, {
      seq: firstHidden.length + firstLive.length,
      rawLength: firstLive.length
    })
    await flushAsyncTicks(4)
    vi.advanceTimersByTime(750)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)

    pane.terminal.write.mockClear()
    ;(deps.isVisibleRef as { current: boolean }).current = false
    capturedDataCallback.current?.(secondHidden, {
      seq: firstHidden.length + firstLive.length + secondHidden.length,
      rawLength: secondHidden.length
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(secondLive, {
      seq: firstHidden.length + firstLive.length + secondHidden.length + secondLive.length,
      rawLength: secondLive.length
    })
    await flushAsyncTicks(4)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)

    firstSnapshot.resolve({
      data: 'stale-first-snapshot\r\n',
      cols: 100,
      rows: 30,
      seq: firstHidden.length + firstLive.length
    })
    await flushAsyncTicks(10)
    secondSnapshot.resolve({
      data: 'fresh-second-snapshot\r\n',
      cols: 100,
      rows: 30,
      seq: firstHidden.length + firstLive.length + secondHidden.length + secondLive.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'stale-first-snapshot\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'fresh-second-snapshot\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(secondLive, expect.any(Function))
    disposable.dispose()
  })

  it('ignores an async hidden-backlog snapshot if the pane changes PTYs first', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('old-pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'old-pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'old-live-output\r\n'

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
    await flushAsyncTicks(2)
    transport.getPtyId.mockReturnValue('new-pty-id')
    snapshot.resolve({
      data: 'old-snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('old-pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'old-snapshot-state\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('does not recover stale hidden backlog state after the pane switches PTYs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('old-pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'old-pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const newPtyOutput = 'new-pty-output\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    transport.getPtyId.mockReturnValue('new-pty-id')
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(newPtyOutput, {
      seq: newPtyOutput.length,
      rawLength: newPtyOutput.length
    })
    await flushAsyncTicks(10)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(newPtyOutput, expect.any(Function))
    disposable.dispose()
  })

  it('does not replay pending hidden restore chunks after a terminal clear', async () => {
    const clearBufferCallback: {
      current: ((request: { ptyId: string }) => void) | null
    } = { current: null }
    window.api.pty.onClearBufferRequest = vi.fn((callback) => {
      clearBufferCallback.current = callback as (request: { ptyId: string }) => void
      return vi.fn()
    })
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
    const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'pre-clear-live-output\r\n'

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
    await flushAsyncTicks(2)
    expect(clearBufferCallback.current).not.toBeNull()

    clearBufferCallback.current?.({ ptyId: 'pty-id' })
    snapshot.resolve({
      data: '',
      cols: 120,
      rows: 40,
      seq: hidden.length + live.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.clear).toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      NORMAL_BUFFER_PROLOGUE,
      expect.any(Function)
    )
    disposable.dispose()
  })
})
