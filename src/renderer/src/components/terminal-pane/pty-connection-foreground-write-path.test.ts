import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  temporarilySetNavigatorUserAgent,
  sendTerminalInputThroughPane
} from './pty-connection-test-dom'
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

  it('queues visible bulk output off the synchronous xterm write path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    vi.useFakeTimers()
    capturedDataCallback.current?.('x'.repeat(16 * 1024))

    expect(pane.terminal.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(pane.terminal.write).toHaveBeenCalledWith('x'.repeat(16 * 1024), expect.any(Function))
  })

  it('keeps ANSI redraws after terminal input on the immediate xterm write path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    const onDataMock = pane.terminal.onData as unknown as {
      mock: { calls: [[(data: string) => void] | []] }
    }
    const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
    expect(terminalInputHandler).toBeTypeOf('function')
    terminalInputHandler?.('a')

    const redraw = `\x1b[2J\x1b[H${'codex composer redraw '.repeat(200)}`
    capturedDataCallback.current?.(redraw)

    expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
  })

  it('keeps large ANSI redraws after terminal input on the immediate xterm write path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    const onDataMock = pane.terminal.onData as unknown as {
      mock: { calls: [[(data: string) => void] | []] }
    }
    const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
    expect(terminalInputHandler).toBeTypeOf('function')
    terminalInputHandler?.('a')

    const redraw = `\x1b[2J\x1b[H${'codex large composer redraw '.repeat(1_200)}`
    expect(redraw.length).toBeGreaterThan(16 * 1024)
    expect(redraw.length).toBeLessThan(128 * 1024)
    capturedDataCallback.current?.(redraw)

    expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
  })

  it('routes terminal input through deferPtyInput so the host can withhold it', async () => {
    // Regression: inlining forwardPtyInput into onData dropped this hop, silently disabling link-click mouse suppression.
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    transportFactoryQueue.push(transport)
    const deferPtyInput = vi.fn()

    connectPanePty(pane as never, createManager(1) as never, createDeps({ deferPtyInput }) as never)
    await flushAsyncTicks()
    sendTerminalInputThroughPane(pane, 'a')

    expect(deferPtyInput).toHaveBeenCalledWith(1, 'a', expect.any(Function))
    expect(transport.sendInput).not.toHaveBeenCalled()

    const forward = deferPtyInput.mock.calls[0]?.[2] as (data: string) => void
    forward('a')
    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('forwards terminal input directly when the host supplies no deferPtyInput', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    transportFactoryQueue.push(transport)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    sendTerminalInputThroughPane(pane, 'a')

    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('keeps large ANSI redraws after captured shortcut input on the immediate path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    const binding = connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps() as never
    ) as unknown as { markShortcutTerminalInputSent: () => void }
    await flushAsyncTicks()
    binding.markShortcutTerminalInputSent()

    const redraw = `\x1b[2J\x1b[H${'pi composer redraw '.repeat(200)}`
    expect(redraw.length).toBeGreaterThan(2_048)
    capturedDataCallback.current?.(redraw)

    expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
  })

  it('does not let OpenTUI-style small ANSI redraw bursts monopolize foreground writes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    vi.useFakeTimers()

    const frames = Array.from({ length: 270 }, (_, index) =>
      [
        '\x1b[?2026h',
        '\x1b[?25l',
        `\x1b[2;3H\x1b[38;2;255;138;0m${index % 2 === 0 ? '#' : '*'}${'*'.repeat(7)}\x1b[0m`,
        `\x1b[2;12H\x1b[38;2;255;138;0mOpenTUI synthetic active TUI redraw ${index}\x1b[0m`,
        `\x1b[4;6H\x1b[38;2;231;237;247m${'#'.repeat(36)} ${'opentui'.repeat(48)}\x1b[0m`
      ].join('')
    )
    expect(frames.every((frame) => frame.length <= 2048 && frame.includes('\x1b['))).toBe(true)
    expect(frames.join('').length).toBeGreaterThan(128 * 1024)

    for (const frame of frames) {
      capturedDataCallback.current?.(frame)
    }

    expect(pane.terminal.write.mock.calls.length).toBeLessThan(frames.length)
    vi.advanceTimersByTime(0)
    expect(pane.terminal.write.mock.calls.length).toBeGreaterThan(0)
  })

  it('drains a post-submit synchronized frame on the fast path when its end marker arrives late', async () => {
    // Why (STA-1041): a submit-opened DEC 2026 frame must drain fast (~16ms) by open time, even when ConPTY splits its close past the 150ms window.
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      // Enter submits; the synchronized repaint frame opens immediately after.
      sendTerminalInputThroughPane(pane, '\r')
      const repaintBody = 'opencode repaint '.repeat(200)
      expect(repaintBody.length).toBeGreaterThan(2048)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
      // The frame body holds, then its hold-safety fallback drains it.
      vi.advanceTimersByTime(40)
      pane.terminal.write.mockClear()

      // ConPTY delivers the closing chunk well past the 150ms redraw window.
      vi.advanceTimersByTime(300)
      const endChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
      expect(endChunk.length).toBeGreaterThan(2048)
      capturedDataCallback.current?.(endChunk)

      // Fast path: the latency-sensitive coalesce window is ~16ms, not 1000ms.
      vi.advanceTimersByTime(20)
      expect(pane.terminal.write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      restoreNavigator()
    }
  })

  it('keeps coalescing a synchronized frame end with no recent input behind the 1s fallback', async () => {
    // Why (STA-1041): fast path is keystroke-only; a background split redraw waits the full fallback so Windows never rasterizes the transient cursor.
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      // No terminal input: this synchronized redraw is not submit-driven.
      const repaintBody = 'opencode repaint '.repeat(200)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
      // Let the frame body drain via its 250ms hold-safety fallback before isolating the closing chunk.
      vi.advanceTimersByTime(300)
      pane.terminal.write.mockClear()

      const endChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
      capturedDataCallback.current?.(endChunk)

      // The fast 16ms window must NOT flush a background split-restore frame.
      vi.advanceTimersByTime(20)
      expect(pane.terminal.write).not.toHaveBeenCalled()

      // The full coalesce fallback still drains it so the frame is never lost.
      vi.advanceTimersByTime(1000)
      expect(pane.terminal.write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      restoreNavigator()
    }
  })

  it('clears the synchronized latch when ConPTY splits the frame end marker', async () => {
    // Why: issue #8754 — a split \x1b[?2026l left the foreground latch armed, so every later
    // chunk was held as frame body and the visible pane froze until the tab was blurred.
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      const repaintBody = 'codex spinner '.repeat(200)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
      vi.advanceTimersByTime(300)
      pane.terminal.write.mockClear()

      // ConPTY splits the closing marker across two chunks.
      capturedDataCallback.current?.(`${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?202`)
      capturedDataCallback.current?.('6l')
      vi.advanceTimersByTime(1100)
      expect(pane.terminal.write).toHaveBeenCalled()
      pane.terminal.write.mockClear()

      // The frame is closed, so ordinary output must paint instead of being held as frame body.
      capturedDataCallback.current?.('command finished\r\n')
      vi.advanceTimersByTime(20)
      expect(pane.terminal.write).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      restoreNavigator()
    }
  })

  it('does not leak the interactive latch across a same-chunk close+open to a stale frame', async () => {
    // Why: a same-chunk close+open re-evaluates the new frame from its own open time so it can't inherit the prior frame's fast path.
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      // Load-bearing: Enter opens an INTERACTIVE frame that stays OPEN — the leak precondition, since the buggy set-branch is gated on !active.
      sendTerminalInputThroughPane(pane, '\r')
      const repaintBody = 'opencode repaint '.repeat(200)
      expect(repaintBody.length).toBeGreaterThan(2048)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
      // Move past the 400ms interactive window without closing the frame, so any new frame now classifies non-interactive.
      vi.advanceTimersByTime(500)
      pane.terminal.write.mockClear()

      // One chunk closes the prior frame and opens a new one ~500ms post-keystroke; the recompute must judge the new frame non-interactive from its own open time.
      capturedDataCallback.current?.(`\x1b[?2026l\x1b[?2026h${repaintBody}`)
      vi.advanceTimersByTime(40)
      pane.terminal.write.mockClear()

      // The new frame's split restore + end marker arrive in a later chunk.
      const staleEndChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
      expect(staleEndChunk.length).toBeGreaterThan(2048)
      capturedDataCallback.current?.(staleEndChunk)

      // The fast ~16ms window must NOT flush this stale non-interactive frame.
      vi.advanceTimersByTime(20)
      expect(pane.terminal.write).not.toHaveBeenCalled()

      // Only the full 1s coalesce fallback drains it, restoring the protection.
      vi.advanceTimersByTime(1000)
      expect(pane.terminal.write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      restoreNavigator()
    }
  })

  it('coalesces a second synchronized frame that opens after the window with no keystroke', async () => {
    // Why: the second frame opens after the interactive window, so its start is judged independently and stays on the 1s fallback.
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      // Frame 1: submit-driven and interactive; opens and closes cleanly.
      sendTerminalInputThroughPane(pane, '\r')
      const repaintBody = 'opencode repaint '.repeat(200)
      expect(repaintBody.length).toBeGreaterThan(2048)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}\x1b[?2026l`)
      vi.advanceTimersByTime(40)

      // Move past the 400ms window with no further keystroke, then open frame 2.
      vi.advanceTimersByTime(500)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
      vi.advanceTimersByTime(40)
      pane.terminal.write.mockClear()

      // Frame 2's split cursor restore + end marker arrive in a later chunk.
      const secondEndChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
      capturedDataCallback.current?.(secondEndChunk)

      // The fast ~16ms window must NOT flush this non-interactive second frame.
      vi.advanceTimersByTime(20)
      expect(pane.terminal.write).not.toHaveBeenCalled()

      // The full 1s coalesce fallback drains it so the frame is never lost.
      vi.advanceTimersByTime(1000)
      expect(pane.terminal.write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      restoreNavigator()
    }
  })
})
