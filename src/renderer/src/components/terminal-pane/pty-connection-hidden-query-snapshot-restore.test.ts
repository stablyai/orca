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

  it('keeps all visible bytes after a pending hidden ESC becomes non-query output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-before-visible\r\n',
      cols: 100,
      rows: 30
    })

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b')
      isVisibleRef.current = true
      capturedDataCallback.current?.('hello')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith('hello', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith('ello', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('repaints from the main-owned snapshot when main drops pending output at the cap', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { droppedOutput?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'healed from snapshot\r\n',
      cols: 100,
      rows: 30
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({ isVisibleRef: { current: true } }) as never
    )
    try {
      await flushAsyncTicks(6)
      getMainBufferSnapshot.mockClear()

      // Main hit the per-PTY pending cap and sent the droppedOutput sentinel: the stream has a gap, so repaint from the authoritative main-owned buffer.
      capturedDataCallback.current?.('\x1b[?2031h', { droppedOutput: true })
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining('healed from snapshot'),
        expect.any(Function)
      )
    } finally {
      binding.dispose()
    }
  })

  it('keeps split stateful Codex queries live after becoming visible', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-before-visible\r\n',
      cols: 100,
      rows: 30
    })

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[')
      isVisibleRef.current = true
      capturedDataCallback.current?.('6n')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[6n', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith('6n', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('drops pending hidden Codex query prefixes when the PTY changes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b')
      ;(transport.attach as unknown as (opts: { existingPtyId: string }) => void)({
        existingPtyId: 'pty-new'
      })
      isVisibleRef.current = true
      capturedDataCallback.current?.('[c')

      expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b', expect.any(Function))
      expect(pane.terminal.write).toHaveBeenCalledWith('[c', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('does not live-render split hidden Codex non-query CSI output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[?202')
    capturedDataCallback.current?.('6h')
    capturedDataCallback.current?.('\x1b[?203')
    capturedDataCallback.current?.('1h')

    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b[?202', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith('6h', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b[?203', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith('1h', expect.any(Function))

    binding.dispose()
  })

  it('answers split hidden Codex OSC color queries directly', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b]11;?')
    capturedDataCallback.current?.(`\x1b\\\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `\x1b\\\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('answers hidden Codex OSC color queries split before the prefix directly', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b]')
    capturedDataCallback.current?.(`11;?\x1b\\\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `11;?\x1b\\\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps later hidden Codex stateless terminal queries on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(30_000)
      capturedDataCallback.current?.('\x1b[5n')
      vi.advanceTimersByTime(50)

      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[5n', expect.any(Function))
    } finally {
      vi.useRealTimers()
    }

    binding.dispose()
  })

  it('keeps clean hidden Codex stateful cursor-position queries on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[10;20H\x1b[6n')

    expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[10;20H\x1b[6n', expect.any(Function))

    binding.dispose()
  })

  it('does not answer dirty hidden Codex stateful queries from stale xterm state', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(`\x1b[2J\x1b[H${'codex redraw '.repeat(8_000)}`)
    capturedDataCallback.current?.('\x1b[6n')

    expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b[6n', expect.any(Function))

    binding.dispose()
  })
})
