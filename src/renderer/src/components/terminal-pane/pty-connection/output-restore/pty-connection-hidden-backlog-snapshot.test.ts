import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ABORT_TRUNCATED_CONTROL_STRING,
  buildSnapshotReplayPrologue
} from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { flushAsyncTicks, createDeferred } from '../test-fixtures/pty-connection-test-async'
import { NORMAL_BUFFER_PROLOGUE } from '../test-fixtures/pty-connection-test-constants'
import { createRect } from '../test-fixtures/pty-connection-test-dom'
import {
  terminalWriteText,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks as AgentTitleMocks,
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
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep,
  presentPaneViewport
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  presentPaneViewport: vi.fn()
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

vi.mock('@/lib/pane-manager/pane-webgl-renderer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  presentPaneViewport
}))
vi.mock('@/lib/pane-manager/pane-viewport-present', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  presentPaneViewport
}))

vi.mock('@/store/index', () => ({
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

vi.mock('../../titles/cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/agent-session/accounts/codex/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Pass useCallback through because this suite invokes notification hooks without rendering React.
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
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Stub eager-buffer lookup to exercise live adoption without the IPC dispatcher.
vi.mock('../../pty-transport/delivery/pty-dispatcher', async (importOriginal) => {
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

  // Use a real alt-screen pane so a stubbed normal-buffer check cannot pass without emitting the missing ?1049l reset.
  it('emits the alt-screen unstick when the pane is on alt and the model is not', async () => {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks6 = await vi.importMock<AgentTitleMocks>('@/lib/agent-status')
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
    const disposable = connectPanePty(
      pane as never,
      createManager(1) as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
    )
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
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks7 = await vi.importMock<AgentTitleMocks>('@/lib/agent-status')
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
    const disposable = connectPanePty(
      pane as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks7)
    )
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
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks8 = await vi.importMock<AgentTitleMocks>('@/lib/agent-status')
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
    const disposable = connectPanePty(
      pane as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks8)
    )
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
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks9 = await vi.importMock<AgentTitleMocks>('@/lib/agent-status')
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
    pane.terminal.write = vi.fn((data: string | Uint8Array, callback?: () => void) => {
      data = terminalWriteText(data)
      writes.push(data)
      callback?.()
    })
    pane.container.getBoundingClientRect = vi.fn(() => createRect(4, 3))
    const deps = createDeps({ isVisibleRef: { current: false } })
    const binding = connectPanePty(
      pane as never,
      createManager(1) as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks9)
    )
    await flushAsyncTicks(6)
    onData?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    const { _dispatchPtyModelRestoreNeededForTest } =
      await import('../../pty-transport/delivery/pty-model-restore-channel')
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
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks10 = await vi.importMock<AgentTitleMocks>('@/lib/agent-status')
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
    const disposable = connectPanePty(
      pane as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks10)
    )
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
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks11 = await vi.importMock<AgentTitleMocks>('@/lib/agent-status')
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
    const disposable = connectPanePty(
      pane as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks11)
    )
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
      data: string | Uint8Array,
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
