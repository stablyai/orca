/* oxlint-disable max-lines */
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST_REPLAY_FOCUS_REPORTING_RESET, POST_REPLAY_MODE_RESET } from './layout-serialization'
import type * as UseNotificationDispatchModule from './use-notification-dispatch'

// Why: the fresh-spawn and reattach paths now chain pre-signal → spawn →
// register/settle through multiple microtasks. Tests that previously flushed
// once with `await Promise.resolve()` must drain a few extra ticks before
// asserting against IPC mocks. See docs/mobile-prefer-renderer-scrollback.md.
async function flushAsyncTicks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

const toastInfo = vi.fn()

type StoreState = {
  tabsByWorktree: Record<string, { id: string; ptyId: string | null; title?: string }[]>
  ptyIdsByTabId?: Record<string, string[]>
  unreadTerminalTabs?: Record<string, true>
  worktreesByRepo: Record<string, { id: string; repoId: string; path: string }[]>
  repos: { id: string; connectionId?: string | null }[]
  sshConnectionStates: Map<string, { status: string }>
  cacheTimerByKey: Record<string, number | null>
  settings: { promptCacheTimerEnabled?: boolean } | null
  codexRestartNoticeByPtyId: Record<
    string,
    { previousAccountLabel: string; nextAccountLabel: string }
  >
  deferredSshReconnectTargets: string[]
  deferredSshSessionIdsByTabId: Record<string, string>
  removeDeferredSshReconnectTarget: ReturnType<typeof vi.fn>
  removeDeferredSshSessionId: ReturnType<typeof vi.fn>
  consumePendingColdRestore: ReturnType<typeof vi.fn>
  consumePendingSnapshot: ReturnType<typeof vi.fn>
}

type ConnectCallbacks = {
  onData?: (data: string) => void
  onError?: (msg: string) => void
}

type MockTransport = {
  attach: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn> & {
    mockImplementation: (
      impl: (opts: { callbacks?: ConnectCallbacks } & Record<string, unknown>) => Promise<unknown>
    ) => unknown
  }
  sendInput: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  getPtyId: ReturnType<typeof vi.fn>
}

const scheduleRuntimeGraphSync = vi.fn()
const shouldSeedCacheTimerOnInitialTitle = vi.fn(() => false)

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    isGeminiTerminalTitle: vi.fn(() => false),
    isClaudeAgent: vi.fn(() => false),
    detectAgentStatusFromTitle: vi.fn((title: string) =>
      /Claude (working|done)/.test(title) ? (/working/.test(title) ? 'working' : 'idle') : null
    )
  }
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

// Why: the working→idle test imports the real useNotificationDispatch to
// verify producer → IPC end-to-end. useCallback is pure memoization for
// that hook, so pass-through here lets it be invoked outside React.
//
// Scope note: this mock applies to every test in this file, not just the
// working→idle test. It is safe today because no other test in this file
// depends on useCallback identity stability — the suite does not render
// React components. If that ever changes, either narrow this with
// vi.doMock inside the it() block or extract the hook body into a plain
// non-hook function so the test does not need to bypass React at all.
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

function createMockTransport(initialPtyId: string | null = null): MockTransport {
  let ptyId = initialPtyId
  return {
    attach: vi.fn(({ existingPtyId }: { existingPtyId: string }) => {
      ptyId = existingPtyId
    }),
    connect: vi.fn().mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        ptyId = opts.sessionId
        return { id: opts.sessionId }
      }
      return ptyId
    }),
    sendInput: vi.fn(() => true),
    resize: vi.fn(() => true),
    getPtyId: vi.fn(() => ptyId)
  } as MockTransport
}

function createPane(paneId: number) {
  return {
    id: paneId,
    terminal: {
      cols: 120,
      rows: 40,
      write: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() }))
    },
    container: { dataset: {} },
    fitAddon: {
      fit: vi.fn()
    }
  }
}

function createManager(paneCount = 1) {
  return {
    setPaneGpuRendering: vi.fn(),
    markPaneHasComplexScriptOutput: vi.fn(),
    getPanes: vi.fn(() => Array.from({ length: paneCount }, (_, index) => ({ id: index + 1 }))),
    closePane: vi.fn(),
    getActivePane: vi.fn<() => { id: number } | null>(() => null)
  }
}

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    cwd: '/tmp/wt-1',
    startup: null,
    restoredLeafId: null,
    restoredPtyIdByLeafId: {},
    paneTransportsRef: { current: new Map() },
    replayingPanesRef: { current: new Map() },
    isActiveRef: { current: true },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    onPtyErrorRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(() => false),
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    clearWorktreeUnread: vi.fn(),
    clearTerminalTabUnread: vi.fn(),
    dispatchNotification: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    ...overrides
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve
  })
  return { promise, resolve: resolveDeferred }
}

describe('connectPanePty', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    mockStoreState = {
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['tab-pty']
      },
      unreadTerminalTabs: {},
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1' }]
      },
      repos: [{ id: 'repo1', connectionId: null }],
      sshConnectionStates: new Map(),
      cacheTimerByKey: {},
      settings: { promptCacheTimerEnabled: true },
      codexRestartNoticeByPtyId: {},
      deferredSshReconnectTargets: [],
      deferredSshSessionIdsByTabId: {},
      removeDeferredSshReconnectTarget: vi.fn(),
      removeDeferredSshSessionId: vi.fn(),
      consumePendingColdRestore: vi.fn(() => null),
      consumePendingSnapshot: vi.fn(() => null),
      removeAgentStatus: vi.fn()
    } as StoreState
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        ssh: {
          connect: vi.fn().mockResolvedValue({ status: 'connected' })
        },
        pty: {
          signal: vi.fn(),
          ackColdRestore: vi.fn(),
          onSerializeBufferRequest: vi.fn(() => vi.fn()),
          declarePendingPaneSerializer: vi.fn().mockResolvedValue(1),
          settlePaneSerializer: vi.fn().mockResolvedValue(undefined),
          clearPendingPaneSerializer: vi.fn().mockResolvedValue(undefined)
        },
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true }),
          playSound: vi.fn().mockResolvedValue({ played: true })
        }
      }
    }
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    globalThis.cancelAnimationFrame = vi.fn()
  })

  afterEach(() => {
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
    } else {
      delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame })
        .requestAnimationFrame
    }
    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
    } else {
      delete (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame })
        .cancelAnimationFrame
    }
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('does not send startup command via sendInput for local connections', async () => {
    // Why: the local PTY provider already writes the command via
    // writeStartupCommandWhenShellReady — sending it again from the renderer
    // would cause the command to appear twice in the terminal.
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-local-1'
    })
    transportFactoryQueue.push(transport)

    // Local connection: no connectionId
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ startup: { command: "claude 'say test'" } })

    connectPanePty(pane as never, manager as never, deps as never)
    expect(capturedDataCallback.current).not.toBeNull()

    // Simulate PTY output (shell prompt arriving)
    capturedDataCallback.current?.('(base) user@host $ ')

    // Even after the debounce window, the renderer must not inject the command
    // because the main process already wrote it via writeStartupCommandWhenShellReady.
    expect(transport.sendInput).not.toHaveBeenCalledWith(
      expect.stringContaining("claude 'say test'")
    )
  })

  it('does not reuse a sibling split pane pending spawn after remount', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const mainSpawn = createDeferred<string>()
    const setupSpawn = createDeferred<string>()

    const mainTransport = createMockTransport()
    mainTransport.connect.mockImplementation(async () => mainSpawn.promise)
    const setupTransport = createMockTransport()
    setupTransport.connect.mockImplementation(async () => setupSpawn.promise)
    const remountTransport = createMockTransport()
    transportFactoryQueue.push(mainTransport, setupTransport, remountTransport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const sharedTransportsRef = { current: new Map() }
    connectPanePty(
      createPane(1) as never,
      createManager(2) as never,
      createDeps({ paneTransportsRef: sharedTransportsRef }) as never
    )
    connectPanePty(
      createPane(2) as never,
      createManager(2) as never,
      createDeps({
        startup: { command: 'bash setup-runner.sh' },
        paneTransportsRef: sharedTransportsRef
      }) as never
    )

    const remountDeps = createDeps()
    connectPanePty(createPane(1) as never, createManager(2) as never, remountDeps as never)

    setupSpawn.resolve('pty-setup')
    mainSpawn.resolve('pty-main')
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(remountTransport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'pty-main' })
    )
    expect(remountDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-main')
    expect(remountDeps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-main')
  })

  it('drops xterm onData while pane is replaying restored bytes', async () => {
    // Regression: during cold-restore / snapshot replay, xterm auto-replies
    // to embedded query sequences (DA1, DECRQM, OSC 10/11, focus, CPR) via
    // onData. Those replies must not pipe through to transport.sendInput, or
    // they land as stray characters ("?1;2c", "2026;2$y", ...) on the new
    // shell's prompt. See replay-guard.ts.
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-live')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const replayingPanesRef = { current: new Map<number, number>([[1, 1]]) }
    const deps = createDeps({ replayingPanesRef })

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    // Simulate xterm emitting a DA1 auto-reply during replay parse.
    ;(onDataHandler as (data: string) => void)('\x1b[?1;2c')
    expect(transport.sendInput).not.toHaveBeenCalled()

    // Once replay completes (guard cleared), real keystrokes flow through.
    replayingPanesRef.current.delete(1)
    ;(onDataHandler as (data: string) => void)('a')
    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('blocks input to stale Codex panes until they restart', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-codex-stale')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-codex-stale' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-codex-stale']
      },
      codexRestartNoticeByPtyId: {
        'pty-codex-stale': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    const sendTerminalInput = onDataHandler as (data: string) => void
    sendTerminalInput('hello')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('blocks input when tab-level ptyId is stale even if panePtyId is null', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-level-pty' }]
      },
      codexRestartNoticeByPtyId: {
        'tab-level-pty': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('hello')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('sends startup command via sendInput for SSH connections (relay has no shell-ready mechanism)', async () => {
    // Capture the setTimeout callback directly so we can fire it without
    // vi.useFakeTimers() (which would also replace the rAF mock from beforeEach).
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport()
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      // SSH connection: connectionId is set, relay ignores the command field
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }]
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({ startup: { command: "claude 'say test'" } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(capturedDataCallback.current).not.toBeNull()

      // Simulate shell prompt arriving — queues the debounce timer
      capturedDataCallback.current?.('user@remote $ ')

      // Fire all queued setTimeout callbacks (the debounce)
      for (const fn of pendingTimeouts) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("claude 'say test'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('reattaches a remounted split pane to its restored leaf PTY instead of the tab-level PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: 'pane:2',
      restoredPtyIdByLeafId: { 'pane:2': 'leaf-pty-2' }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    // Why: Option 2 deferred reattach uses connect({ sessionId }) instead of
    // attach({ existingPtyId }) so the daemon's createOrAttach runs at the
    // pane's real fitAddon dimensions.
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'leaf-pty-2' })
    )
    expect(transport.attach).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'leaf-pty-2')
  })

  it('spawns a fresh PTY when a restored daemon split session cannot reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        return undefined
      }
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('fresh-pty')
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: 'pane:2',
      restoredPtyIdByLeafId: { 'pane:2': 'stale-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await Promise.resolve()
    await Promise.resolve()

    expect(transport.connect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: 'stale-pty' })
    )
    expect(transport.connect).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, null)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'stale-pty')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-pty')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-pty')
  })

  it('resets focus reporting after daemon snapshot replay without applying the full mode reset', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004hrestored snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      },
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: 'pane:1',
      restoredPtyIdByLeafId: { 'pane:1': 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H', expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '\x1b[?1004hrestored snapshot',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      POST_REPLAY_FOCUS_REPORTING_RESET,
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      POST_REPLAY_MODE_RESET,
      expect.any(Function)
    )
  })

  // Why: when a reattach result carries both snapshot and replay (the daemon
  // host serves the snapshot, the relay replay buffer covers the same tail),
  // painting both into xterm doubles the same lines. This is the duplicated-
  // TUI-output symptom users saw on worktree switch. Snapshot is the freshest
  // authoritative source and wins by precedence.
  it('paints only the daemon snapshot when reattach result includes both snapshot and replay', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot: 'snapshot-payload',
          replay: 'replay-payload'
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: 'pane:1',
      restoredPtyIdByLeafId: { 'pane:1': 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith('snapshot-payload', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith('replay-payload', expect.any(Function))
  })

  it('paints only relay replay when reattach result has replay and coldRestore but no snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          replay: 'replay-payload',
          coldRestore: { scrollback: 'cold-payload' }
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: 'pane:1',
      restoredPtyIdByLeafId: { 'pane:1': 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith('replay-payload', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith('cold-payload', expect.any(Function))
    // Why: the replay branch supersedes cold-restore but must still ack so
    // the daemon does not redeliver the cold-restore payload on the next
    // reattach.
    expect(window.api.pty.ackColdRestore).toHaveBeenCalledWith('tab-pty')
  })

  // Regression for the dim-mismatch bug — guarantees that we never
  // reintroduce visibility-gated buffering. Bytes go straight to xterm,
  // which lets the WebGL/DOM-fallback renderer parse them at live cols.
  // Hidden panes still get writes; the visibility prop only controls
  // WebGL suspend/resume in use-terminal-pane-global-effects.
  it('writes PTY bytes straight to xterm regardless of visibility', async () => {
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
      isVisibleRef: { current: false }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    capturedDataCallback.current?.('hello\r\n')

    expect(pane.terminal.write).toHaveBeenCalledWith('hello\r\n')
  })

  it('marks panes that receive Arabic output for DOM rendering', async () => {
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
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('Arabic: السلام عليكم\r\n')

    expect(manager.markPaneHasComplexScriptOutput).toHaveBeenCalledWith(1)
    expect(pane.terminal.write).toHaveBeenCalledWith('Arabic: السلام عليكم\r\n')
  })

  it('reattaches via daemon sessionId when an in-session PTY is live', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-local-detached' }]
      },
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-local-detached' })
    )
    expect(transport.attach).not.toHaveBeenCalled()
    await flushAsyncTicks()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-local-detached')
  })

  it('persists a restarted pane PTY id and uses it on the next remount', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const restartedTransport = createMockTransport()
    let spawnedPtyId: string | null = null
    restartedTransport.connect.mockImplementation(async () => {
      spawnedPtyId = 'pty-restarted'
      const opts = createdTransportOptions[0]
      ;(opts.onPtySpawn as (ptyId: string) => void)('pty-restarted')
      return 'pty-restarted'
    })
    transportFactoryQueue.push(restartedTransport)

    const restartPane = createPane(1)
    const restartManager = createManager(1)
    const restartDeps = createDeps({
      paneTransportsRef: { current: new Map([[99, createMockTransport('another-pane-pty')]]) }
    })

    connectPanePty(restartPane as never, restartManager as never, restartDeps as never)
    await flushAsyncTicks()

    expect(spawnedPtyId).toBe('pty-restarted')
    expect(restartDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted')

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-restarted' }]
      },
      settings: {
        ...mockStoreState.settings
      }
    }

    const remountTransport = createMockTransport()
    transportFactoryQueue.push(remountTransport)
    const remountPane = createPane(1)
    const remountManager = createManager(1)
    const remountDeps = createDeps({
      restoredLeafId: 'pane:1',
      restoredPtyIdByLeafId: { 'pane:1': 'pty-restarted' }
    })

    connectPanePty(remountPane as never, remountManager as never, remountDeps as never)

    expect(remountTransport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-restarted' })
    )
    expect(remountTransport.attach).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(remountDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted')
  })

  // Why: BEL (0x07) is the attention signal. connectPanePty wires an
  // onBell handler that raises the worktree unread dot, the tab-level
  // bell indicator, and an OS notification. Under the ghostty
  // show-until-interact model, the unread flags clear when the user
  // actually interacts with the pane — keystroke via xterm onData or
  // pointerdown on the container (see TerminalPane.tsx). This test
  // locks in the mark wiring; separate tests below cover the clear path.
  it('wires onBell to raise worktree unread, tab unread, and OS notification', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler) {
      throw new Error('Expected onBell to be registered')
    }

    bellHandler()

    expect(deps.markWorktreeUnread).toHaveBeenCalledTimes(1)
    expect(deps.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.dispatchNotification).toHaveBeenCalledWith({ source: 'terminal-bell' })
  })

  // Why: show-until-interact — a real keystroke through xterm onData is the
  // canonical "user is here" signal that dismisses the bell. Guarded by the
  // replay and codex-stale checks (see separate tests) so synthetic xterm
  // auto-replies and blocked stale input never count as interaction.
  it('clears tab and worktree unread on real keystroke via onData', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(deps.clearTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.clearWorktreeUnread).toHaveBeenCalledWith('wt-1')
    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  // Why: xterm auto-replies during replay must not masquerade as user
  // interaction. If they did, a pane that BELed during its scrollback
  // replay would instantly self-dismiss without the user ever seeing it.
  it('does not clear unread when onData fires during replay', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const replayingPanesRef = { current: new Map<number, number>([[1, 1]]) }
    const deps = createDeps({ replayingPanesRef })

    connectPanePty(pane as never, manager as never, deps as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('\x1b[?1;2c')

    expect(deps.clearTerminalTabUnread).not.toHaveBeenCalled()
    expect(deps.clearWorktreeUnread).not.toHaveBeenCalled()
  })

  // Why: symmetric to the replay guard — if the pane is stale-codex (pending
  // account-switch restart), xterm onData bytes are either blocked synthetic
  // input or keystrokes that would execute under the wrong account. Either
  // way they must not count as user interaction and dismiss the bell. The
  // production code also blocks the transport.sendInput call in this branch
  // (see pty-connection.ts lines 275-277), so we assert that too.
  it('does not clear unread when onData fires on a stale codex pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex-stale')
    transportFactoryQueue.push(transport)
    // isCodexPaneStale reads codexRestartNoticeByPtyId from the store, so
    // trigger the stale branch by seeding a restart notice for the pane's PTY.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-codex-stale' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-codex-stale']
      },
      codexRestartNoticeByPtyId: {
        'pty-codex-stale': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(deps.clearTerminalTabUnread).not.toHaveBeenCalled()
    expect(deps.clearWorktreeUnread).not.toHaveBeenCalled()
    // Stale-codex input is also blocked from reaching the transport.
    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('replays attach buffer for deferred SSH reattach and clears stale tab session metadata', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      return { id: opts.sessionId ?? 'pty-new', replay: 'restored-ssh-output' }
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'tab-level-stale-session' }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: 'leaf-1',
      restoredPtyIdByLeafId: { 'leaf-1': 'leaf-session' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    const api = (
      globalThis as unknown as {
        window: {
          api: {
            ssh: { connect: ReturnType<typeof vi.fn> }
            pty: { signal: ReturnType<typeof vi.fn> }
          }
        }
      }
    ).window.api
    expect(api.ssh.connect).toHaveBeenCalledWith({ targetId: 'conn-1' })
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'leaf-session' })
    )
    expect(mockStoreState.removeDeferredSshSessionId).toHaveBeenCalledWith('tab-1')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'leaf-session')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'leaf-session')
    // Why: the relay's replay buffer holds the full terminal history, so the
    // client clears xterm before writing to prevent duplication with any
    // content already in the terminal from a prior session.
    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H', expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith('restored-ssh-output', expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      POST_REPLAY_FOCUS_REPORTING_RESET,
      expect.any(Function)
    )
    expect(api.pty.signal).toHaveBeenCalledWith('leaf-session', 'SIGWINCH')
  })

  it('shows an informational toast instead of a terminal error when an SSH session expired', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      return { id: opts.sessionId ?? 'pty-new', sessionExpired: true }
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'expired-session' }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: 'leaf-1',
      restoredPtyIdByLeafId: { 'leaf-1': 'leaf-session' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalledWith(
      expect.any(Number),
      expect.stringContaining('Previous session expired')
    )
    expect(toastInfo).toHaveBeenCalledWith('Previous SSH session expired.', {
      id: 'ssh-session-expired-tab-1',
      description: 'Started a new shell.'
    })
  })

  // Why: the working→idle transition fires an 'agent-task-complete' OS
  // notification (user-toggleable in Settings) but MUST NOT raise tab/worktree
  // unread — those stay BEL-only so non-agent long-running tasks remain
  // first-class attention sources. Double-firing with a concurrent BEL is
  // collapsed by the per-worktree dedupe in main/ipc/notifications.ts.
  //
  // This test deliberately wires the real useNotificationDispatch hook into
  // connectPanePty instead of a vi.fn() stub. A stub would let the producer
  // be silently deleted and the test still pass by asserting "not called";
  // routing through the real hook to window.api.notifications.dispatch means
  // removing the producer breaks the IPC assertion, which is the user-facing
  // contract.
  it('dispatches agent-task-complete on working→idle but does not raise tab/worktree unread', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    // Why: useNotificationDispatch uses useCallback internally; bypass the
    // React machinery by invoking its body directly through a module call.
    // Safe here because useCallback is pure memoization — the returned
    // function has the same behavior as the callback passed in.
    // Depends on the file-level vi.mock('react', ...) near the top of this
    // file that replaces useCallback with a pass-through. Removing that
    // mock breaks this test with a rules-of-hooks error.
    const dispatchNotification = useNotificationDispatch('wt-1')

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Claude done')

    expect(deps.markWorktreeUnread).not.toHaveBeenCalled()
    expect(deps.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-1',
        terminalTitle: '* Claude done'
      })
    )
  })

  // Why: onAgentExited must clear any running prompt-cache countdown so the
  // sidebar does not show a stale timer for a tab that no longer has an
  // active Claude session.
  it('clears the cache timer when the agent exits', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const agentExitedHandler = createdTransportOptions[0]?.onAgentExited as (() => void) | undefined
    if (!agentExitedHandler) {
      throw new Error('Expected onAgentExited to be registered')
    }

    agentExitedHandler()

    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith('tab-1:1', null)
  })
})
