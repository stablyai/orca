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

function expectNoGlobalAtlasRecovery(): void {
  // Why: the removed output path requested recovery 200ms before its global reset ran.
  expect(scheduleImagePasteWebglAtlasRecovery).not.toHaveBeenCalled()
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

  it('does not schedule WebGL atlas recovery for ordinary foreground shell rewrites', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
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
      const refresh = vi.fn()
      let parseCallback: (() => void) | undefined
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\r\x1b[Korca % npm test')

      parseCallback?.()
      expect(refresh).toHaveBeenCalledWith(0, 39, true)
      expectNoGlobalAtlasRecovery()
    } finally {
      restoreNavigator()
    }
  })

  it('does not schedule WebGL atlas recovery for plain synchronized foreground frames', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
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
      let parseCallback: (() => void) | undefined
      pane.terminal.write = vi.fn((_data: string, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[?2026hplain claude frame\x1b[?2026l')
      parseCallback?.()
      expectNoGlobalAtlasRecovery()
    } finally {
      restoreNavigator()
    }
  })

  it('forces a viewport refresh when foreground background SGR is split across PTY chunks', async () => {
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
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })

    connectPanePty(pane as never, manager as never, createDeps() as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[48')
    expect(refresh).not.toHaveBeenCalled()

    capturedDataCallback.current?.(';2;52;52;52m codex block text \x1b[0m\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
  })

  it('forces a viewport refresh when the foreground CSI introducer is split across PTY chunks', async () => {
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
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })

    connectPanePty(pane as never, manager as never, createDeps() as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b')
    expect(refresh).not.toHaveBeenCalled()

    capturedDataCallback.current?.('[48;2;52;52;52m codex block text \x1b[0m\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
  })

  it('does not keep forcing viewport refresh after completed background redraws', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[2J\x1b[H\x1b[48;2;52;52;52m codex block text \x1b[0m\r\n')
    expect(refresh).toHaveBeenCalledWith(0, 39, true)

    refresh.mockClear()
    capturedDataCallback.current?.('plain follow-up output\r\n')

    expect(refresh).not.toHaveBeenCalled()
  })

  it('forces a viewport refresh for native Windows CJK foreground output after terminal input', async () => {
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
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)
      sendTerminalInputThroughPane(pane, '已经安装完成，软件已更新后重启。')

      capturedDataCallback.current?.('已经安装完成，软件已更新后重启。')

      expect(refresh).toHaveBeenCalledWith(0, 39, true)
    } finally {
      restoreNavigator()
    }
  })

  it('forces the native Windows CJK repaint path for foreground agent output without recent terminal input', async () => {
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
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('已经安装完成，软件已更新后重启。')

      expect(refresh).toHaveBeenCalledWith(0, 39, true)
    } finally {
      restoreNavigator()
    }
  })

  it('does not force renderer-risk repaint for ordinary non-ASCII output', async () => {
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
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)
      sendTerminalInputThroughPane(pane, 'abc 123 ✓')

      capturedDataCallback.current?.('abc 123 ✓')

      expect(refresh).not.toHaveBeenCalled()
    } finally {
      restoreNavigator()
    }
  })

  it('applies the Windows CJK repaint path to SSH panes on Windows clients after terminal input', async () => {
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
      // Why: missing-glyph workaround is renderer-scoped, not PTY-scoped — SSH moves byte origin but Windows still paints locally.
      mockStoreState = {
        ...mockStoreState,
        repos: [{ id: 'repo1', connectionId: 'conn-1', displayName: 'orca' }]
      }

      const pane = createPane(1)
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)
      sendTerminalInputThroughPane(pane, '已经安装完成，软件已更新后重启。')

      capturedDataCallback.current?.('已经安装完成，软件已更新后重启。')

      expect(refresh).toHaveBeenCalledWith(0, 39, true)
    } finally {
      restoreNavigator()
    }
  })

  it('does not repaint ordinary non-ASCII output on non-Windows clients', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
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
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('abc 123 ✓')

      expect(refresh).not.toHaveBeenCalled()
    } finally {
      restoreNavigator()
    }
  })

  it('schedules a follow-up repaint for Claude-style in-place prompt redraws on native Windows', async () => {
    // Why: issue #5656/#5653 — native Windows ConPTY paints Claude's in-place prompt redraw one frame late; needs a follow-up next-frame repaint.
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
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      // User typed into the prompt; Claude redraws the input line in place.
      capturedDataCallback.current?.('\r\x1b[3Gzzzx\x1b[K')

      // One synchronous settle refresh + one follow-up next-frame refresh.
      expect(refresh).toHaveBeenCalledTimes(2)
      expect(refresh).toHaveBeenNthCalledWith(1, 0, 39, true)
      expect(refresh).toHaveBeenNthCalledWith(2, 0, 39, true)
    } finally {
      restoreNavigator()
    }
  })

  it('does not schedule a follow-up repaint for the Claude redraw pattern on non-Windows clients', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
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
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      // CR redraw still forces one synchronous refresh, but no native-Windows follow-up repaint is scheduled.
      capturedDataCallback.current?.('\r\x1b[3Gzzzx\x1b[K')

      expect(refresh).toHaveBeenCalledTimes(1)
      expect(refresh).toHaveBeenCalledWith(0, 39, true)
    } finally {
      restoreNavigator()
    }
  })

  it('coalesces forced foreground refreshes when WebGL is live', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
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
      const synchronousRefresh = vi.fn()
      const debouncedRefresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof synchronousRefresh }
        refresh: typeof debouncedRefresh
      }
      terminal._core = { refresh: synchronousRefresh }
      terminal.refresh = debouncedRefresh
      terminal.write = vi.fn((_data: string, callback?: () => void) => callback?.())
      const manager = createManager(1)
      manager.hasWebglRenderer.mockReturnValue(true)

      connectPanePty(pane as never, manager as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\r\x1b[3Gzzzx\x1b[K')

      expect(debouncedRefresh).toHaveBeenCalledWith(0, 39)
      expect(synchronousRefresh).not.toHaveBeenCalled()
    } finally {
      restoreNavigator()
    }
  })
})
