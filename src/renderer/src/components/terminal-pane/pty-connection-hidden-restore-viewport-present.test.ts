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

// Stub eager-buffer lookup to exercise live adoption without the IPC dispatcher.
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

// #33684: the restore's final present must run after xterm parses the transaction's last
// write, not merely after its submission: presenting early paints a pre-parse buffer, and
// a render latch still paused at parse time swallows the follow-up dirty-row refresh. Real
// xterm parses asynchronously, so the mock parks write callbacks until the test releases
// them in FIFO order — the order xterm's WriteBuffer guarantees.
function deferTerminalParseCallbacks(pane: ReturnType<typeof createPane>): {
  parseTick: ReturnType<typeof vi.fn>
  flushParse: () => void
} {
  const queued: (() => void)[] = []
  const parseTick = vi.fn((callback: () => void) => callback())
  pane.terminal.write.mockImplementation((_data: string | Uint8Array, callback?: () => void) => {
    if (callback) {
      queued.push(callback)
    }
  })
  return {
    parseTick,
    flushParse: () => {
      const pending = queued.splice(0)
      for (const callback of pending) {
        parseTick(callback)
      }
    }
  }
}

// While the transaction's parse is still parked, no viewport refresh may follow its last
// write submission: a refresh there presented the pre-parse buffer.
function expectNoPresentAfterLastWriteSubmission(
  pane: ReturnType<typeof createPane>,
  presentSink: ReturnType<typeof vi.fn>
): void {
  const writeOrder = pane.terminal.write.mock.invocationCallOrder
  expect(writeOrder.length).toBeGreaterThan(0)
  for (const order of presentSink.mock.invocationCallOrder) {
    expect(order).toBeLessThan(writeOrder.at(-1)!)
  }
}

// Once the parked parses complete, the deferred present must follow the final parse.
function expectPresentAfterParseFlush(
  presentSink: ReturnType<typeof vi.fn>,
  presentCountBeforeParse: number,
  parseTick: ReturnType<typeof vi.fn>
): void {
  expect(parseTick).toHaveBeenCalled()
  expect(presentSink.mock.invocationCallOrder.length).toBeGreaterThan(presentCountBeforeParse)
  expect(presentSink.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
    parseTick.mock.invocationCallOrder.at(-1)!
  )
}

describe('connectPanePty hidden-output restore viewport present', () => {
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
  })

  function attachRefreshSpy(pane: ReturnType<typeof createPane>): ReturnType<typeof vi.fn> {
    const refresh = vi.fn()
    Object.assign(pane.terminal, { refresh })
    return refresh
  }

  // xterm parks rendering behind _renderService._isPaused while a pane is hidden, and a
  // reveal can beat the IntersectionObserver that would unpause it (#33684). The restore's
  // present must release that latch itself and full-present (terminal-render-pause-release.ts).
  function attachPausedRenderService(pane: ReturnType<typeof createPane>): {
    _isPaused: boolean
    _needsFullRefresh: boolean
    _pausedResizeTask: { flush: ReturnType<typeof vi.fn> } | null
    refreshRows: ReturnType<typeof vi.fn>
  } {
    const service = {
      _isPaused: true,
      _needsFullRefresh: true,
      _pausedResizeTask: { flush: vi.fn() },
      refreshRows: vi.fn()
    }
    Object.assign(pane.terminal, { _core: { _renderService: service } })
    return service
  }

  async function connectHiddenClaudePane(
    overrides: Record<string, unknown> = {},
    options: { pausedRenderService?: boolean } = {}
  ) {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    let onData: ConnectCallbacks['onData']
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      onData = callbacks.onData
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const refresh = attachRefreshSpy(pane)
    const renderService =
      options.pausedRenderService === true ? attachPausedRenderService(pane) : null
    const isVisibleRef = { current: false }
    const deps = createDeps({ isVisibleRef, startup: { command: 'codex' }, ...overrides })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture mocks are structurally partial bags; every sibling pty-connection suite binds them the same way.
    const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)
    return { pane, refresh, renderService, onData: onData!, isVisibleRef, disposable, deps }
  }

  const hiddenChunk = 'hidden-before-flood\r\n'
  const liveChunk = 'spinner redraw\r\n'

  it('presents the viewport after the deadline abandon drains its last pending byte', async () => {
    const getSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    // The reporter's busy-spinner shape: the snapshot serialize is still in flight when the
    // foreground deadline (750ms) abandons the restore and drains the queued live bytes.
    const snapshotDeferred = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
    }>()
    getSnapshot.mockReturnValueOnce(snapshotDeferred.promise)
    const { pane, refresh, onData, isVisibleRef, disposable } = await connectHiddenClaudePane()
    const { parseTick, flushParse } = deferTerminalParseCallbacks(pane)

    onData?.(hiddenChunk, { seq: hiddenChunk.length, rawLength: hiddenChunk.length })
    const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
    _dispatchPtyModelRestoreNeededForTest({
      id: 'pty-id',
      reason: 'hidden-drop',
      markerSeq: 64
    })
    isVisibleRef.current = true
    await flushAsyncTicks(30)

    vi.useFakeTimers()
    try {
      // Queue the live chunk under the virtual clock so the 750ms foreground deadline it
      // arms is fake-timer driven, then let the deadline abandon and drain.
      onData?.(liveChunk, { seq: 96, rawLength: liveChunk.length })
      await vi.advanceTimersByTimeAsync(800)
      await flushAsyncTicks(30)
    } finally {
      vi.useRealTimers()
    }
    await flushAsyncTicks(30)
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    // The drained bytes have not parsed yet: presenting here would paint the pre-parse
    // buffer, so the restore must not have presented at write time.
    expectNoPresentAfterLastWriteSubmission(pane, refresh)
    const presentCountBeforeParse = refresh.mock.invocationCallOrder.length
    flushParse()
    await flushAsyncTicks(30)
    expectPresentAfterParseFlush(refresh, presentCountBeforeParse, parseTick)
    // The plain fixture carries no render service, so this present degraded to the refresh fallback.
    expect(refresh).toHaveBeenCalledWith(0, pane.terminal.rows - 1)

    snapshotDeferred.resolve({ data: 'late\r\n', cols: 120, rows: 40, seq: 128 })
    await flushAsyncTicks(20)
    disposable.dispose()
  })

  it('presents the viewport after the clean drain writes its last byte', async () => {
    const getSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    const modelTail = '\x1b[0'
    getSnapshot.mockResolvedValueOnce({
      data: 'snapshot-screen\r\n',
      pendingEscapeTailAnsi: modelTail,
      cols: 120,
      rows: 40,
      seq: 64
    })
    const { pane, refresh, onData, isVisibleRef, disposable } = await connectHiddenClaudePane()
    const { parseTick, flushParse } = deferTerminalParseCallbacks(pane)

    onData?.(hiddenChunk, { seq: 20, rawLength: 20 })
    const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
    _dispatchPtyModelRestoreNeededForTest({
      id: 'pty-id',
      reason: 'hidden-drop',
      markerSeq: 64
    })
    isVisibleRef.current = true
    // Queued while the restore is in flight, drained after the snapshot paints.
    onData?.(liveChunk, { seq: 84, rawLength: liveChunk.length })
    await flushAsyncTicks(30)
    // The snapshot replay stalls at its parse barrier; releasing it lets the coordinator
    // drain the queued live chunk and arm the transaction's final parse barrier.
    flushParse()
    await flushAsyncTicks(30)
    await flushAsyncTicks(30)

    expectNoPresentAfterLastWriteSubmission(pane, refresh)
    const presentCountBeforeParse = refresh.mock.invocationCallOrder.length
    flushParse()
    await flushAsyncTicks(30)
    expectPresentAfterParseFlush(refresh, presentCountBeforeParse, parseTick)
    // The plain fixture carries no render service, so this present degraded to the refresh fallback.
    expect(refresh).toHaveBeenCalledWith(0, pane.terminal.rows - 1)
    disposable.dispose()
  })

  it('releases the paused render latch and requests the full repaint after the deadline abandon drains its last byte', async () => {
    const getSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    // Same reporter's busy-spinner shape as the fallback twin above, but the hidden pane's
    // render service is paused: xterm parks rendering while hidden and the reveal races the
    // IntersectionObserver that would unpause it, so the drain's present must release the
    // latch itself and full-present instead of degrading to refresh.
    const snapshotDeferred = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
    }>()
    getSnapshot.mockReturnValueOnce(snapshotDeferred.promise)
    const { pane, refresh, renderService, onData, isVisibleRef, disposable } =
      await connectHiddenClaudePane({}, { pausedRenderService: true })
    const service = renderService!
    const { parseTick, flushParse } = deferTerminalParseCallbacks(pane)

    onData?.(hiddenChunk, { seq: hiddenChunk.length, rawLength: hiddenChunk.length })
    const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
    _dispatchPtyModelRestoreNeededForTest({
      id: 'pty-id',
      reason: 'hidden-drop',
      markerSeq: 64
    })
    isVisibleRef.current = true
    await flushAsyncTicks(30)

    vi.useFakeTimers()
    try {
      // Queue the live chunk under the virtual clock so the 750ms foreground deadline it
      // arms is fake-timer driven, then let the deadline abandon and drain.
      onData?.(liveChunk, { seq: 96, rawLength: liveChunk.length })
      await vi.advanceTimersByTimeAsync(800)
      await flushAsyncTicks(30)
    } finally {
      vi.useRealTimers()
    }
    await flushAsyncTicks(30)
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    // The drained bytes have not parsed yet: no full repaint may have been requested.
    expectNoPresentAfterLastWriteSubmission(pane, service.refreshRows)
    const presentCountBeforeParse = service.refreshRows.mock.invocationCallOrder.length
    flushParse()
    await flushAsyncTicks(30)
    expectPresentAfterParseFlush(service.refreshRows, presentCountBeforeParse, parseTick)
    // The paused present released the latch itself instead of waiting for the observer.
    expect(service._isPaused).toBe(false)
    expect(service._needsFullRefresh).toBe(false)
    expect(service._pausedResizeTask?.flush).toHaveBeenCalled()
    // The present went through the render service, not the refresh fallback.
    expect(refresh).not.toHaveBeenCalled()

    snapshotDeferred.resolve({ data: 'late\r\n', cols: 120, rows: 40, seq: 128 })
    await flushAsyncTicks(20)
    disposable.dispose()
  })
})
