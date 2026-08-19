import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  POST_REPLAY_REATTACH_RESET_KEEP_MOUSE,
  RESET_GRAPHIC_RENDITION,
  RESET_KITTY_KEYBOARD_PROTOCOL,
  RESET_TERMINAL_CURSOR_STYLE
} from '../../../../shared/terminal-mode-reset-profiles'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  withMockedDocumentActiveElement,
  configureTerminalFocusMode,
  sendTerminalInputThroughPane
} from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
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

  it('retries a fresh-spawn native follow reset when renderer dimensions return', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getTerminalScrollIntentKind } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('fresh-pty')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
    } as StoreState
    const pane = createPane(1)
    pane.terminal.buffer.active.viewportY = 40
    pane.terminal.buffer.active.baseY = 100
    const renderListener: { current: (() => void) | null } = { current: null }
    const renderDisposable = { dispose: vi.fn() }
    pane.terminal.onRender = vi.fn((listener: () => void) => {
      renderListener.current = listener
      return renderDisposable
    })
    vi.mocked(pane.terminal.scrollToBottom)
      .mockImplementationOnce(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })
      .mockImplementation(() => {
        pane.terminal.buffer.active.viewportY = pane.terminal.buffer.active.baseY
      })

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    expect(pane.terminal.buffer.active.viewportY).toBe(40)
    expect(renderListener.current).not.toBeNull()

    renderListener.current?.()
    expect(pane.terminal.buffer.active.viewportY).toBe(100)
    expect(pane.terminal.scrollToBottom).toHaveBeenCalledTimes(2)
    expect(getTerminalScrollIntentKind(pane.terminal)).toBe('followOutput')
    expect(renderDisposable.dispose).toHaveBeenCalledTimes(1)
  })

  it('writes the daemon pendingEscapeTailAnsi after the reset on local reattach (#7329)', async () => {
    // Why: re-arm the mid-escape tail LAST, after the reattach reset whose ESC would abort it, so a live continuation completes it.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot: 'restored snapshot',
          snapshotCols: 80,
          snapshotRows: 24,
          pendingEscapeTailAnsi: '\x1b[3'
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    const tailWriteCall = pane.terminal.write.mock.invocationCallOrder.find(
      (_order, index) => pane.terminal.write.mock.calls[index][0] === '\x1b[3'
    )
    const resetWriteCall = pane.terminal.write.mock.invocationCallOrder.find((_order, index) =>
      String(pane.terminal.write.mock.calls[index][0]).includes(POST_REPLAY_REATTACH_RESET)
    )
    expect(tailWriteCall).toBeDefined()
    expect(resetWriteCall).toBeDefined()
    // The dangling tail is written AFTER the reset.
    expect(resetWriteCall as number).toBeLessThan(tailWriteCall as number)
  })

  it('routes native onData query replies through sendInputImmediate, typed input through sendInput (#7329)', async () => {
    // Why this test: the mock aliases sendInputImmediate to sendInput, so other tests can't tell them apart; this pins the routing decision.
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-7329')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()

    // xterm answers CSI 6n natively with a CPR via onData; it must take the immediate path (skips the remote 8ms debounce that corrupted it).
    sendTerminalInputThroughPane(pane, '\x1b[3;1R')
    expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[3;1R')

    // Ordinary typed input must stay on the debounced path — never immediate.
    transport.sendInputImmediate.mockClear()
    sendTerminalInputThroughPane(pane, 'yes')
    sendTerminalInputThroughPane(pane, '\x1b[A') // arrow-key auto-repeat stays batched
    expect(transport.sendInput).toHaveBeenCalledWith('yes')
    expect(transport.sendInput).toHaveBeenCalledWith('\x1b[A')
    expect(transport.sendInputImmediate).not.toHaveBeenCalled()

    // terminal-query-reply.test proves real xterm emits this as one framed onData reply; this pins it to the immediate path.
    transport.sendInputImmediate.mockClear()
    const xtversionReply = '\x1bP>|xterm.js(6.1.0-beta.287)\x1b\\'
    sendTerminalInputThroughPane(pane, xtversionReply)
    expect(transport.sendInputImmediate).toHaveBeenCalledWith(xtversionReply)

    // Printable input is user-owned: remote cooked echo returns via PTY output, not onData, so OSC-looking text stays on normal input.
    transport.sendInput.mockClear()
    transport.sendInputImmediate.mockClear()
    const printableInputs = [']10;hello', '>|xterm.js(6.1.0-beta.287)', ']|literal-text']
    for (const data of printableInputs) {
      sendTerminalInputThroughPane(pane, data)
      expect(transport.sendInput).toHaveBeenCalledWith(data)
    }
    expect(transport.sendInputImmediate).not.toHaveBeenCalled()
  })

  it('writes the onReplayData pendingEscapeTailAnsi meta last, after the replayed bytes (#7329)', async () => {
    // Why this test: the onReplayData meta pass-through had no failing test — severing it kept the suite green.
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const pane = createPane(1)
    const writes: string[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    }) as typeof pane.terminal.write
    const transport = createMockTransport('remote:web-env-1@@pty-7329-tail')
    const replayCallback: {
      current:
        | ((
            data: string,
            meta?: { clearBeforeReplay?: boolean; pendingEscapeTailAnsi?: string }
          ) => void)
        | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      replayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:web-env-1@@pty-7329-tail', replay: '' }
    })
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    expect(replayCallback.current).toBeTypeOf('function')

    replayCallback.current?.('remote snapshot bytes', {
      clearBeforeReplay: false,
      pendingEscapeTailAnsi: '\x1b[3'
    })
    await flushAsyncTicks(20)

    const snapshotIndex = writes.indexOf('remote snapshot bytes')
    const tailIndex = writes.lastIndexOf('\x1b[3')
    expect(snapshotIndex).toBeGreaterThanOrEqual(0)
    expect(tailIndex).toBeGreaterThanOrEqual(0)
    // The dangling tail is re-armed after the snapshot/reset, so the next live chunk completes it instead of rendering literally.
    expect(tailIndex).toBeGreaterThan(snapshotIndex)
    expect(writes.slice(tailIndex + 1)).toEqual([])
  })

  it('preserves live modes and injects focus-in after focused agent reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25lrestored cursor snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('Cursor Agent')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    // Why: public xterm modes plus an agent title are the stable signal for a live focus-driven TUI; avoid private `_core` probes.
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
      // Snapshot ends with ?25l (Cursor Agent parks/hides the cursor); the reset must preserve it, not force ?25h, or a stray block paints.
      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
      const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map(
        ([data]) => data as string
      )
      expect(writes.some((data) => data.includes('\x1b[?25h'))).toBe(false)
    })
  })

  it('ignores the stale agent signal on a cold restore and applies the fresh-shell reset', async () => {
    // Why: pane status and title are persisted, so after a cold restore they still
    // describe the process that died and make the pane look agent-owned. Preserving
    // "its" modes arms mouse/focus/paste reporting against the replacement shell,
    // which then prints the reports as junk at the prompt (#12101).
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot: '\x1b[?1003h\x1b[?1006h\x1b[?2004huser@host ~ $ ',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('Cursor Agent')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map(
        ([data]) => data as string
      )
      expect(writes).toContain(
        `${RESET_GRAPHIC_RENDITION}\x1b[?1003h\x1b[?1006h\x1b[?2004huser@host ~ $ `
      )
      expect(writes).toContain(POST_REPLAY_MODE_RESET)
      expect(writes).not.toContain(POST_REPLAY_LIVE_AGENT_REATTACH_RESET)
    })
  })

  it('applies the fresh-shell reset when a spawn is answered with a cold-restore reattach', async () => {
    // Why: main can answer a *spawn* with an adopted session, so the reattach handler
    // is reachable by a second door that skips the restored-session path entirely. The
    // cold-restore signal has to survive that door too, or #12101 returns on it.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    let activePtyId = 'tab-pty'
    transport.getPtyId.mockImplementation(() => activePtyId)
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        throw new Error('restored session is gone')
      }
      // Main answered the spawn by adopting a durable session instead.
      activePtyId = 'adopted-pty'
      return {
        id: 'adopted-pty',
        isReattach: true,
        // Keep this snapshot free of ?25l: the live agent reset is built from the
        // payload and only equals the constant negated below when the cursor is left
        // visible. Ending it hidden would quietly retire that assertion.
        snapshot: '\x1b[?1003h\x1b[?1006h\x1b[?2004huser@host ~ $ ',
        coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
      }
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('Cursor Agent')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(30)

      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(transport.connect.mock.calls[0]?.[0]?.sessionId).toBe('tab-pty')
      expect(transport.connect.mock.calls[1]?.[0]?.sessionId).toBeUndefined()
      const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map(
        ([data]) => data as string
      )
      const output = writes.join('')
      const snapshotIndex = output.indexOf('\x1b[?1003h\x1b[?1006h\x1b[?2004huser@host ~ $ ')
      const resetIndex = output.indexOf(POST_REPLAY_MODE_RESET)
      expect(snapshotIndex).toBeGreaterThanOrEqual(0)
      expect(resetIndex).toBeGreaterThan(snapshotIndex)
      expect(writes).toContain(POST_REPLAY_MODE_RESET)
      expect(writes).not.toContain(POST_REPLAY_LIVE_AGENT_REATTACH_RESET)
    })
  })

  it('keeps ?25h in the live agent reattach reset when the snapshot leaves the cursor visible', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        // A mid-frame snapshot cut after the TUI re-showed its cursor.
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25l\x1b[?25hrestored cursor snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('Cursor Agent')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
    })
  })

  it('does not inject focus-in after reattach when the terminal does not own DOM focus', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25lrestored cursor snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('Cursor Agent')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    // Why: a different element owns focus, so the reattach must not send a stray focus-in to a background pane.
    await withMockedDocumentActiveElement({}, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
    })
  })

  it('resets stale focus and cursor modes for a focused non-agent shell reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25lstale shell snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('zsh')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_REATTACH_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
    })
  })

  // Why: issue #8291 — the reattach reset wiped the mouse modes the daemon snapshot had just
  // rehydrated, so xterm re-enabled its row-wise selection over a still-running TUI.
  const reattachSnapshotResetFor = async (snapshot: string): Promise<string | undefined> => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
      sessionId ? { id: sessionId, snapshot } : null
    )
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('zsh')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    return withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })
      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      return (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => String(call[0]))
        .find(
          (data) =>
            data === POST_REPLAY_REATTACH_RESET || data === POST_REPLAY_REATTACH_RESET_KEEP_MOUSE
        )
    })
  }

  it('keeps mouse reporting when a reattach snapshot restores a live alternate-screen TUI', async () => {
    await expect(
      reattachSnapshotResetFor('\x1b[?1049h\x1b[?1002h\x1b[?1006hthird-party tui session')
    ).resolves.toBe(POST_REPLAY_REATTACH_RESET_KEEP_MOUSE)
  })

  it('still disarms mouse reporting when a reattach snapshot ends on the normal buffer', async () => {
    await expect(reattachSnapshotResetFor('\x1b[?1003h\x1b[?1006hdead tui residue')).resolves.toBe(
      POST_REPLAY_REATTACH_RESET
    )
  })

  it('does not treat persisted tab launchAgent metadata as a live agent reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25lstale shell snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    // Why: launchAgent is launch-ownership metadata that never decays; it must not preserve stale modes for a shell left after agent death.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', title: 'zsh', launchAgent: 'claude' }]
      },
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: 'zsh' }
      }
    } as StoreState

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_REATTACH_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
    })
  })

  it('does not treat an agent-name token in a shell title as a live agent reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25lstale shell snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    // Why: broad token matching would classify this ordinary ssh title as an agent and preserve stale modes into a bare shell.
    setReattachPaneTitle('ssh devin@host')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_REATTACH_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
    })
  })

  it('does not treat ordinary shell scrollback mentioning Cursor Agent as a live agent reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot:
            '\x1b[?1004h\x1b[?25l$ grep -R "Cursor Agent" docs\r\nCursor Agent IME notes\r\n'
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('zsh')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_REATTACH_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
    })
  })

  it('resets an already-idle agent cursor again after reattach SIGWINCH repaint', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: 'restored idle codex snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', title: 'Codex done' }]
      },
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: 'Codex done' }
      },
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(window.api.pty.signal).toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )

    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  // Why: a reattach with both snapshot and replay paints the same tail twice (dup-TUI-output on switch); snapshot wins by precedence.
})
