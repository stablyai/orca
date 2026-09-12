import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_KITTY_KEYBOARD_PROTOCOL,
  RESET_TERMINAL_CURSOR_STYLE
} from '../../../../shared/terminal-mode-reset-profiles'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  NORMAL_BUFFER_PROLOGUE,
  ANSI_POSITIONED_CURSOR_AGENT_REATTACH_SCREEN
} from './pty-connection-test-constants'
import {
  withMockedDocumentActiveElement,
  configureTerminalFocusMode
} from './pty-connection-test-dom'
import {
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager
} from './pty-connection-test-pane-fixtures'
import type { ConnectCallbacks, MockTransport } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildReattachPaneTitleState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
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

function setReattachPaneTitle(title: string): void {
  mockStoreState = buildReattachPaneTitleState(mockStoreState, title)
}

// Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
  mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
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

  it('preserves a scrolled-up viewport after hidden-backlog snapshot replay', async () => {
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
    pane.terminal.buffer.active.viewportY = 42
    pane.terminal.buffer.active.baseY = 100
    pane.terminal.write.mockImplementation((data: string, callback?: () => void) => {
      if (data.includes('snapshot-state')) {
        pane.terminal.buffer.active.viewportY = 0
      }
      callback?.()
    })
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

    expect(pane.terminal.write).toHaveBeenCalledWith('snapshot-state\r\n', expect.any(Function))
    expect(pane.terminal.scrollToLine).toHaveBeenCalledWith(42)
    disposable.dispose()
  })

  it('cancels a delayed snapshot scroll restore when the pane binding is disposed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { isTerminalScrollIntentRebuildInFlight } =
      await import('@/lib/pane-manager/terminal-scroll-intent-rebuild')
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
    pane.terminal.buffer.active.viewportY = 42
    pane.terminal.buffer.active.baseY = 100
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
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

    expect(writes).toContain('snapshot-state\r\n')
    expect(isTerminalScrollIntentRebuildInFlight(pane.terminal)).toBe(true)
    pane.terminal.scrollToLine.mockClear()
    disposable.dispose()
    expect(isTerminalScrollIntentRebuildInFlight(pane.terminal)).toBe(true)

    pane.terminal.buffer.active.baseY = 200
    pane.terminal.buffer.active.viewportY = 200
    for (const callback of parseCallbacks) {
      callback()
    }
    await flushAsyncTicks()

    expect(isTerminalScrollIntentRebuildInFlight(pane.terminal)).toBe(false)
    expect(pane.terminal.scrollToLine).not.toHaveBeenCalled()
  })

  it('does not apply a delayed snapshot restore after newer user intent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markTerminalFollowOutput } = await import('@/lib/pane-manager/terminal-scroll-intent')
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
    pane.terminal.buffer.active.viewportY = 42
    pane.terminal.buffer.active.baseY = 100
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
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

    expect(writes).toContain('snapshot-state\r\n')
    pane.terminal.buffer.active.viewportY = 200
    pane.terminal.buffer.active.baseY = 200
    markTerminalFollowOutput(pane.terminal)
    pane.terminal.scrollToLine.mockClear()
    for (const callback of parseCallbacks) {
      callback()
    }
    await flushAsyncTicks()

    // Why: replay completion must not overwrite scroll intent recorded while xterm was still parsing the restored snapshot.
    expect(pane.terminal.scrollToLine).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('rebuilds WebGL after remote buffered replay arrives on an already-open pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedReplayCallback: {
      current: ((data: string) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:env-1@@terminal-1', replay: '' }
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
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedReplayCallback.current?.('remote prompt\r\n$ ')
    await flushAsyncTicks(6)

    expect(pane.terminal.write).toHaveBeenCalledWith('remote prompt\r\n$ ', expect.any(Function))
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
    expect(manager.rebuildPaneWebgl).toHaveBeenCalledWith(1)
    disposable.dispose()
  })

  it('preserves live agent modes when queued replay data carries the Cursor Agent screen', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedReplayCallback: {
      current: ((data: string, meta?: { clearBeforeReplay?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:env-1@@terminal-1', replay: '' }
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('renamed shell')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = await withMockedDocumentActiveElement(textarea, async () => {
      const connection = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedReplayCallback.current?.(ANSI_POSITIONED_CURSOR_AGENT_REATTACH_SCREEN)
      await flushAsyncTicks(12)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
      return connection
    })
    disposable.dispose()
  })

  // Why pinned: the classifier strips CSI precisely so a styled header still matches. A future
  // "just lastIndexOf the raw bytes" shortcut would pass every other test and silently break this.
  it('still detects the Cursor Agent screen when CSI styling splits the header and the marker', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedReplayCallback: {
      current: ((data: string, meta?: { clearBeforeReplay?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:env-1@@terminal-1', replay: '' }
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('renamed shell')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = await withMockedDocumentActiveElement(textarea, async () => {
      const connection = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedReplayCallback.current?.(
        '\x1b[4;3HCursor \x1b[1mAgent\x1b[0m\x1b[9;3H→\x1b[0m Plan, search, build anything'
      )
      await flushAsyncTicks(12)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
      return connection
    })
    disposable.dispose()
  })

  // Why pinned: the scan reads only a bounded tail, so a header buried behind megabytes of
  // scrollback describes a finished run, not the current screen.
  it('ignores a Cursor Agent screen buried beyond the payload scan tail limit', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedReplayCallback: {
      current: ((data: string, meta?: { clearBeforeReplay?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:env-1@@terminal-1', replay: '' }
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('renamed shell')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = await withMockedDocumentActiveElement(textarea, async () => {
      const connection = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedReplayCallback.current?.(
        `${ANSI_POSITIONED_CURSOR_AGENT_REATTACH_SCREEN}${'shell scrollback\r\n'.repeat(20_000)}`
      )
      await flushAsyncTicks(12)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      return connection
    })
    disposable.dispose()
  })

  it('downgrades a scrollback-only Cursor Agent signal when the parsed viewport shows a shell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedReplayCallback: {
      current: ((data: string, meta?: { clearBeforeReplay?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:env-1@@terminal-1', replay: '' }
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('renamed shell')

    const pane = createPane(1)
    // Why: a buffer whose visible rows carry no Cursor Agent screen models a shell foreground after a dead run left its screen in scrollback.
    Object.assign(pane.terminal.buffer.active, {
      cursorX: 2,
      getLine: () => undefined
    })
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = await withMockedDocumentActiveElement(textarea, async () => {
      const connection = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      // A dead run left the cursor hidden; the live-agent reset preserves ?25l, so the veto must re-show the cursor for the shell.
      capturedReplayCallback.current?.(`${ANSI_POSITIONED_CURSOR_AGENT_REATTACH_SCREEN}\x1b[?25l`)
      await flushAsyncTicks(12)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[?25h\x1b[?1004l', expect.any(Function))
      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      return connection
    })
    disposable.dispose()
  })

  it('does not clear restored scrollback when eager metadata replay opts out', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedReplayCallback: {
      current: ((data: string, meta?: { clearBeforeReplay?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    pane.terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedReplayCallback.current?.('\x1b]0;Restored title\x07', { clearBeforeReplay: false })
    await flushAsyncTicks(6)

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      NORMAL_BUFFER_PROLOGUE,
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '\x1b]0;Restored title\x07',
      expect.any(Function)
    )
    disposable.dispose()
  })

  it('does not write a clear or reset for empty eager metadata replay', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedReplayCallback: {
      current: ((data: string, meta?: { clearBeforeReplay?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    pane.terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedReplayCallback.current?.('', { clearBeforeReplay: false })
    await flushAsyncTicks(6)

    expect(pane.terminal.write).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('coalesces remote replay payloads that overlap before parsing starts', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedReplayCallback: {
      current: ((data: string) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:env-1@@terminal-1', replay: '' }
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const pendingParses: (() => void)[] = []
    pane.terminal.write = vi.fn((_data: string, callback?: () => void) => {
      if (callback) {
        pendingParses.push(callback)
      }
    })
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedReplayCallback.current?.('first replay')
    capturedReplayCallback.current?.('second replay')
    await flushAsyncTicks(6)

    expect(pane.terminal.write).toHaveBeenCalledTimes(1)
    expect(pane.terminal.write).toHaveBeenNthCalledWith(
      1,
      '\x1b[2J\x1b[3J\x1b[H',
      expect.any(Function)
    )

    for (let index = 0; index < 8; index += 1) {
      await flushAsyncTicks(2)
      pendingParses.shift()?.()
    }
    await flushAsyncTicks(4)

    expect(pane.terminal.write).not.toHaveBeenCalledWith('first replay', expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith('second replay', expect.any(Function))
    expect(manager.rebuildPaneWebgl).toHaveBeenCalledTimes(1)
    disposable.dispose()
  })

  it('holds newer live bytes until a later replay frame has fully parsed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { deliverTerminalDataWithDeferredCredit } =
      await import('@/lib/pane-manager/terminal-delivery-credit')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-live-order')
    const callbacksRef: {
      replay: ((data: string) => void) | null
      data: ((data: string) => void) | null
    } = { replay: null, data: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      callbacksRef.replay = callbacks.onReplayData ?? null
      callbacksRef.data = callbacks.onData ?? null
      return 'remote:env-1@@terminal-live-order'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(8)

    callbacksRef.replay?.('authoritative replay')
    await flushAsyncTicks(8)
    expect(writes).toEqual(['\x1b[2J\x1b[3J\x1b[H'])

    const acknowledgeLiveFrame = vi.fn()
    deliverTerminalDataWithDeferredCredit(acknowledgeLiveFrame, () => {
      callbacksRef.data?.('NEWER-LIVE\r\n')
    })
    expect(writes).not.toContain('NEWER-LIVE\r\n')
    expect(acknowledgeLiveFrame).not.toHaveBeenCalled()
    for (let index = 0; index < 12 && parseCallbacks.length > 0; index += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(8)

    const replayIndex = writes.indexOf('authoritative replay')
    const resetIndex = writes.indexOf(POST_REPLAY_REATTACH_RESET)
    const liveIndex = writes.indexOf('NEWER-LIVE\r\n')
    expect(replayIndex).toBeGreaterThan(0)
    expect(resetIndex).toBeGreaterThan(replayIndex)
    expect(liveIndex).toBeGreaterThan(resetIndex)
    expect(acknowledgeLiveFrame).toHaveBeenCalledOnce()

    callbacksRef.replay?.('stalled replay')
    await flushAsyncTicks(8)
    const acknowledgeDisposedFrame = vi.fn()
    deliverTerminalDataWithDeferredCredit(acknowledgeDisposedFrame, () => {
      callbacksRef.data?.('LIVE-BEHIND-STALLED-REPLAY')
    })
    expect(acknowledgeDisposedFrame).not.toHaveBeenCalled()
    binding.dispose()
    expect(acknowledgeDisposedFrame).toHaveBeenCalledOnce()
  })

  it('drops a queued relay replay instead of retagging it for a replacement PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-old')
    const replayCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      replayCallback.current = callbacks.onReplayData ?? null
      return 'remote:env-1@@terminal-old'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(8)

    replayCallback.current?.('blocking replay')
    await flushAsyncTicks(8)
    replayCallback.current?.('stale queued replay')
    vi.mocked(transport.getPtyId).mockReturnValue('remote:env-1@@terminal-replacement')
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(12)

    expect(writes).not.toContain('blocking replay')
    expect(writes).not.toContain('stale queued replay')
    binding.dispose()
  })

  it('requests snapshot recovery for one oversized live frame deferred by replay', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { deliverTerminalDataWithDeferredCredit } =
      await import('@/lib/pane-manager/terminal-delivery-credit')
    const transport = createMockTransport('pty-large-live')
    const callbacksRef: {
      replay: ((data: string) => void) | null
      data: ((data: string) => void) | null
    } = { replay: null, data: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      callbacksRef.replay = callbacks.onReplayData ?? null
      callbacksRef.data = callbacks.onData ?? null
      return 'pty-large-live'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(8)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue(null)
    getMainBufferSnapshot.mockClear()

    callbacksRef.replay?.('authoritative replay')
    await flushAsyncTicks(8)
    const oversizedLiveFrame = 'L'.repeat(512 * 1024 + 1)
    const acknowledgeDroppedFrame = vi.fn()
    deliverTerminalDataWithDeferredCredit(acknowledgeDroppedFrame, () => {
      callbacksRef.data?.(oversizedLiveFrame)
    })
    expect(acknowledgeDroppedFrame).not.toHaveBeenCalled()
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-large-live', {
      scrollbackRows: 5000
    })
    expect(writes.some((write) => write.startsWith('L'))).toBe(false)
    expect(acknowledgeDroppedFrame).toHaveBeenCalledOnce()
    binding.dispose()
  })
})
