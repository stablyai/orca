import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESET_AFTER_BYTE_GAP } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import {
  flushAsyncTicks,
  renderHeadlessTerminalState
} from '@/components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '@/components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks as AgentTitleMocks,
  bindPaneAgentTitleMocks
} from '@/components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '@/components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '@/components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '@/components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-environment'

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

vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
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

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
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

  it('restores overflowed hidden remote runtime output from its serialized snapshot', async () => {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks = await vi.importMock<AgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )
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
    const disposable = connectPanePty(
      pane as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
    )
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
    expect(transport.serializeBuffer).toHaveBeenCalledWith({
      scrollbackRows: 5000,
      repaintsPane: true
    })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      expect.stringContaining('remote snapshot with hidden remote output'),
      expect.any(Function)
    )
    expect(presentPaneViewport).toHaveBeenCalledWith(pane)
    disposable.dispose()
  })

  it('preserves the painted normal buffer when a successful hidden restore has no image', async () => {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks2 = await vi.importMock<AgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )
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
    const disposable = connectPanePty(
      pane as never,
      createManager(1) as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks2)
    )
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
    // Ground the pen despite an imageless snapshot: the gap still occurred and no repaint will reset the live terminal.
    expect(restoreWrites).toContain(RESET_AFTER_BYTE_GAP)
    expect(transport.serializeBufferOutcome).toHaveBeenCalledTimes(1)
    expect(transport.serializeBuffer).not.toHaveBeenCalled()
    disposable.dispose()
  })
})
