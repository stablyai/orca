import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
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

function expectNoGlobalAtlasRecovery(): void {
  // Why: the removed output path requested recovery 200ms before its global reset ran.
  expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
  expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
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

  it('keeps hidden synchronized output off the global atlas recovery path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: false }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      const startChunk = '\x1b[?2026h'
      const plainRowChunk = '| hidden Claude row |\r\n'
      const endChunk = '\x1b[?2026l'

      capturedDataCallback.current?.(startChunk)
      capturedDataCallback.current?.(plainRowChunk)
      capturedDataCallback.current?.(endChunk)

      expect(writes).toEqual([])
      vi.advanceTimersByTime(50)

      expect(writes).toEqual([`${startChunk}${plainRowChunk}${endChunk}`])

      parseCallbacks[0]?.()
      expectNoGlobalAtlasRecovery()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps split hidden synchronized output off the global atlas recovery path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: false }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('\x1b[?202')
      capturedDataCallback.current?.('6hbody row\r\n')
      capturedDataCallback.current?.('tail\x1b[?20')
      capturedDataCallback.current?.('26l')

      vi.advanceTimersByTime(50)

      expect(writes.join('')).toBe('\x1b[?2026hbody row\r\ntail\x1b[?2026l')

      parseCallbacks[0]?.()
      expectNoGlobalAtlasRecovery()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not schedule hidden atlas recovery for ordinary rich text or metadata output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: false }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('plain hidden emoji 😀 and CJK 没改什么\r\n')
      capturedDataCallback.current?.('\x1b[48;2;52;52;52mcolored shell text\x1b[0m\r\n')
      capturedDataCallback.current?.('\x1b]0;hidden title\x07\x1b]133;A\x07')

      vi.advanceTimersByTime(50)
      for (const callback of parseCallbacks) {
        callback()
      }
      expectNoGlobalAtlasRecovery()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps hidden TUI redraw output off the global atlas recovery path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: false }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('\x1b[2J\x1b[Hredrawn hidden table\x1b[K')

      vi.advanceTimersByTime(50)

      parseCallbacks[0]?.()
      expectNoGlobalAtlasRecovery()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps hidden rewrite frames on the pane-local output path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: false }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('prompt rewrite\r')
      vi.advanceTimersByTime(50)
      expect(writes).toEqual(['prompt rewrite\r'])
      parseCallbacks.shift()?.()

      capturedDataCallback.current?.('\x1b[?2026hredraw frame\x1b[?2026l')
      vi.advanceTimersByTime(50)
      expect(writes).toEqual(['prompt rewrite\r', '\x1b[?2026hredraw frame\x1b[?2026l'])
      parseCallbacks.shift()?.()

      capturedDataCallback.current?.('plain after frame')
      vi.advanceTimersByTime(50)
      parseCallbacks.shift()?.()
      expectNoGlobalAtlasRecovery()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps output after a skipped hidden alternate-screen frame pane-local', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { background?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const isVisibleRef = { current: false }

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('\x1b[?2026h')
      vi.advanceTimersByTime(50)
      parseCallbacks.shift()?.()
      writes.length = 0

      isVisibleRef.current = true
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
      capturedDataCallback.current?.('\x1b[?2026l', { background: true })
      expect(writes).toEqual([])

      isVisibleRef.current = false
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'normal'
      capturedDataCallback.current?.('plain after skipped close\r\n')
      vi.advanceTimersByTime(50)
      parseCallbacks.shift()?.()

      expect(writes).toEqual(['plain after skipped close\r\n'])
      expectNoGlobalAtlasRecovery()
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues visible split-pane PTY bytes when the pane is not active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isActiveRef: { current: false },
      isVisibleRef: { current: true }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    const redraw = '\x1b[2J\x1b[Hvisible split output\r\n'
    capturedDataCallback.current?.(redraw)

    expect(pane.terminal.write).not.toHaveBeenCalledWith(redraw, expect.any(Function))
    vi.advanceTimersByTime(0)
    expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
  })

  it('queues visible ANSI redraws when only another split pane is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = {
      ...createManager(2),
      getActivePane: vi.fn(() => ({ id: 2 }))
    }
    const deps = createDeps({
      isActiveRef: { current: true },
      isVisibleRef: { current: true }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    const redraw = '\x1b[2J\x1b[Hvisible inactive split output\r\n'
    capturedDataCallback.current?.(redraw)

    expect(pane.terminal.write).not.toHaveBeenCalledWith(redraw, expect.any(Function))
    vi.advanceTimersByTime(0)
    expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
  })

  it('routes visible pane PTY bytes through the background scheduler when the document is hidden', async () => {
    ;(globalThis as { document?: Pick<Document, 'visibilityState'> }).document = {
      visibilityState: 'hidden'
    }
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isActiveRef: { current: true },
      isVisibleRef: { current: true }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    capturedDataCallback.current?.('backgrounded document output\r\n')

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'backgrounded document output\r\n',
      expect.any(Function)
    )

    vi.advanceTimersByTime(50)
    expect(pane.terminal.write).toHaveBeenCalledWith('backgrounded document output\r\n')
  })

  it('keeps hidden Codex telemetry startup output parsing briefly', async () => {
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
        startup: {
          command: 'wrapped-agent',
          telemetry: {
            agent_kind: 'codex',
            launch_source: 'tab_bar_quick_launch',
            request_kind: 'new'
          }
        }
      }) as never
    )
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b]11;?\x1b\\startup frame\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden Grok telemetry startup output parsing briefly', async () => {
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
        startup: {
          command: 'wrapped-agent',
          telemetry: {
            agent_kind: 'grok',
            launch_source: 'tab_bar_quick_launch',
            request_kind: 'new'
          }
        }
      }) as never
    )
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b]11;?\x1b\\startup frame\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden bare Codex startup commands parsing briefly', async () => {
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

    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b]11;?\x1b\\startup frame\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden bare Grok startup commands parsing briefly', async () => {
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
        startup: { command: '/Users/me/.grok/bin/grok --permission-mode bypassPermissions' }
      }) as never
    )
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b]11;?\x1b\\startup frame\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('skips arbitrary hidden startup output parsing', async () => {
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
        startup: { command: 'printf noisy startup' }
      }) as never
    )
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('hidden startup output\r\n')

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'hidden startup output\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('records a mode 2031 subscribe from the raw chunk boundary without answering', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: { ...mockStoreState.settings, theme: 'light' }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('\x1b[?2031h')
      vi.advanceTimersByTime(50)

      // Why the scanner and not xterm's CSI handler: xterm batches PTY chunks into one
      // parse, so only this layer knows the chunk ended still subscribed (#9993).
      expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
      expect(transport.sendInputImmediate).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
      // The bytes still reach xterm so the emulator tracks the mode itself.
      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[?2031h')
    } finally {
      vi.useRealTimers()
    }

    binding.dispose()
  })

  // Why: fish 4.7.1 enables and disables 2031 around *every* prompt with no opt-out, so
  // back-to-back chunks each carrying a toggle are the normal case. Subscribing is never
  // answered (#9993) — these pin that silence plus the per-chunk subscription bookkeeping
  // that theme-flip pushes depend on. xterm cannot do that bookkeeping: it parses several
  // chunks in one synchronous batch and only sees the net result.
})
