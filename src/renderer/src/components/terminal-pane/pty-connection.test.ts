/* oxlint-disable max-lines */
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_TERMINAL_CURSOR_STYLE
} from './layout-serialization'
import type * as UseNotificationDispatchModule from './use-notification-dispatch'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'

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
const LEAF_1 = '11111111-1111-4111-8111-111111111111' as const
const LEAF_2 = '22222222-2222-4222-8222-222222222222' as const

function leafIdForPane(paneId: number): string {
  return paneId === 2 ? LEAF_2 : LEAF_1
}

type StoreState = {
  activeWorktreeId: string | null
  tabsByWorktree: Record<string, { id: string; ptyId: string | null; title?: string }[]>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  unreadTerminalTabs?: Record<string, true>
  worktreesByRepo: Record<
    string,
    {
      id: string
      repoId: string
      path: string
      displayName?: string
      branch?: string
      workspaceStatus?: string
    }[]
  >
  repos: { id: string; connectionId?: string | null; displayName?: string }[]
  sshConnectionStates: Map<string, { status: string }>
  cacheTimerByKey: Record<string, number | null>
  settings: {
    theme?: 'system' | 'dark' | 'light'
    promptCacheTimerEnabled?: boolean
    activeRuntimeEnvironmentId?: string | null
    experimentalTerminalAttention?: boolean
    notifications?: {
      enabled?: boolean
      agentTaskComplete?: boolean
      terminalBell?: boolean
      suppressWhenFocused?: boolean
      customSoundPath?: string | null
    }
  } | null
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
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  agentStatusByPaneKey: Record<string, unknown>
  markWorktreeUnread: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
  setAgentStatus: ReturnType<typeof vi.fn>
  removeAgentStatus: ReturnType<typeof vi.fn>
  dropAgentStatus: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
}

type ConnectCallbacks = {
  onData?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
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
  sendInputAccepted?: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  getPtyId: ReturnType<typeof vi.fn>
}

const scheduleRuntimeGraphSync = vi.fn()
const shouldSeedCacheTimerOnInitialTitle = vi.fn(() => false)

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
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

function notifyStoreSubscribers(): void {
  for (const listener of storeSubscribers.slice()) {
    listener(mockStoreState)
  }
}

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    isGeminiTerminalTitle: vi.fn(() => false),
    isClaudeAgent: vi.fn(() => false),
    detectAgentStatusFromTitle: vi.fn((title: string) => {
      if (/Claude (working|done)/.test(title)) {
        return /working/.test(title) ? 'working' : 'idle'
      }
      if (/Codex( working)?/.test(title)) {
        return /working/.test(title) ? 'working' : 'idle'
      }
      return null
    })
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

function createMockTransport(initialPtyId: string | null = null): MockTransport {
  let ptyId = initialPtyId
  const transport = {
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
  const sendInput = transport.sendInput as unknown as (data: string) => boolean
  transport.sendInputAccepted = vi.fn(async (data: string) => sendInput(data))
  return transport
}

function createPane(paneId: number) {
  const leafId = leafIdForPane(paneId)
  const activeBuffer = {
    type: 'normal' as const,
    viewportY: 0,
    baseY: 0,
    cursorY: 0
  }
  return {
    id: paneId,
    leafId,
    stablePaneId: leafId,
    terminal: {
      cols: 120,
      rows: 40,
      element: {},
      buffer: {
        active: activeBuffer
      },
      modes: {
        bracketedPasteMode: false
      },
      options: {
        ignoreBracketedPasteMode: false
      },
      write: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      scrollToBottom: vi.fn(() => {
        activeBuffer.viewportY = activeBuffer.baseY
      }),
      scrollToLine: vi.fn((line: number) => {
        activeBuffer.viewportY = line
      }),
      scrollLines: vi.fn((amount: number) => {
        activeBuffer.viewportY = Math.max(
          0,
          Math.min(activeBuffer.baseY, activeBuffer.viewportY + amount)
        )
      }),
      paste: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      hasSelection: vi.fn(() => false),
      parser: {
        registerOscHandler: vi.fn(() => ({ dispose: vi.fn() }))
      }
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
    getPanes: vi.fn(() =>
      Array.from({ length: paneCount }, (_, index) => ({
        id: index + 1,
        leafId: leafIdForPane(index + 1)
      }))
    ),
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
    markTerminalPaneUnread: vi.fn(),
    clearWorktreeUnread: vi.fn(),
    clearTerminalTabUnread: vi.fn(),
    clearTerminalPaneUnread: vi.fn(),
    dispatchNotification: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    ...overrides
  }
}

function createKeyboardEventTarget() {
  const handlers = new Set<(event: KeyboardEvent) => void>()
  return {
    handlers,
    target: {
      addEventListener: vi.fn(
        (
          type: string,
          handler: EventListenerOrEventListenerObject,
          _options?: AddEventListenerOptions | boolean
        ) => {
          if (type === 'keydown' && typeof handler === 'function') {
            handlers.add(handler as (event: KeyboardEvent) => void)
          }
        }
      ),
      removeEventListener: vi.fn(
        (
          type: string,
          handler: EventListenerOrEventListenerObject,
          _options?: EventListenerOptions | boolean
        ) => {
          if (type === 'keydown' && typeof handler === 'function') {
            handlers.delete(handler as (event: KeyboardEvent) => void)
          }
        }
      )
    },
    dispatch(event: KeyboardEvent) {
      for (const handler of handlers) {
        handler(event)
      }
    }
  }
}

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  } as KeyboardEvent
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
  const originalDocument = globalThis.document

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = {
      activeWorktreeId: 'wt-1',
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['tab-pty']
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: 'tab-pty' }
        }
      },
      unreadTerminalTabs: {},
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', displayName: 'feat/notis' }]
      },
      repos: [{ id: 'repo1', connectionId: null, displayName: 'orca' }],
      sshConnectionStates: new Map(),
      cacheTimerByKey: {},
      settings: { promptCacheTimerEnabled: true, experimentalTerminalAttention: true },
      codexRestartNoticeByPtyId: {},
      deferredSshReconnectTargets: [],
      deferredSshSessionIdsByTabId: {},
      removeDeferredSshReconnectTarget: vi.fn(),
      removeDeferredSshSessionId: vi.fn(),
      consumePendingColdRestore: vi.fn(() => null),
      consumePendingSnapshot: vi.fn(() => null),
      runtimePaneTitlesByTabId: {},
      agentStatusByPaneKey: {},
      markWorktreeUnread: vi.fn(),
      observeTerminalGitHubPullRequestLink: vi.fn(),
      setAgentStatus: vi.fn((paneKey: string, payload: Record<string, unknown>) => {
        mockStoreState.agentStatusByPaneKey[paneKey] = {
          ...payload,
          paneKey,
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          stateHistory: []
        }
      }),
      removeAgentStatus: vi.fn(),
      dropAgentStatus: vi.fn(),
      markTerminalTabUnread: vi.fn(),
      markTerminalPaneUnread: vi.fn()
    } as StoreState
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        ssh: {
          connect: vi.fn().mockResolvedValue({ status: 'connected' }),
          needsPassphrasePrompt: vi.fn().mockResolvedValue(false)
        },
        pty: {
          signal: vi.fn(),
          pauseOutput: vi.fn(),
          getMainBufferSnapshot: vi.fn().mockResolvedValue(null),
          getForegroundProcess: vi.fn().mockResolvedValue(null),
          hasChildProcesses: vi.fn().mockResolvedValue(false),
          ackColdRestore: vi.fn(),
          onClearBufferRequest: vi.fn(() => vi.fn()),
          onSerializeBufferRequest: vi.fn(() => vi.fn()),
          declarePendingPaneSerializer: vi.fn().mockResolvedValue(1),
          settlePaneSerializer: vi.fn().mockResolvedValue(undefined),
          clearPendingPaneSerializer: vi.fn().mockResolvedValue(undefined)
        },
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true }),
          playSound: vi.fn().mockResolvedValue({ played: true })
        },
        agentStatus: {
          inferInterrupt: vi.fn().mockResolvedValue(false)
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
    vi.useRealTimers()
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
    if (originalDocument) {
      globalThis.document = originalDocument
    } else {
      delete (globalThis as { document?: Document }).document
    }
    delete (globalThis as unknown as { window?: unknown }).window
    delete (globalThis as Record<string, unknown>).__ptyConnectDiag
  })

  it('does not retain PTY connect diagnostics unless e2e debug state is enabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    expect((globalThis as Record<string, unknown>).__ptyConnectDiag).toBeUndefined()
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('[pty-connect]'))
    logSpy.mockRestore()
  })

  it('observes live terminal GitHub PR URLs before agent completion', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    capturedDataCallback.current?.('Created https://github.com/acme/orca/pull/42\r\n')

    expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        url: 'https://github.com/acme/orca/pull/42',
        slug: { owner: 'acme', repo: 'orca' },
        number: 42
      })
    )
  })

  it('keeps the surviving split pane mounted when an intentional pane-close PTY exit arrives', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')

    onPtyExit?.('pty-pane-2')

    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
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

  it('seeds a working status for Command Code startup prompts after spawn', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-command-code')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: "command-code --trust 'Fix the status'",
        initialAgentStatus: { agent: 'command-code', prompt: 'Fix the status' }
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    onPtySpawn?.('pty-command-code')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'Fix the status',
        agentType: 'command-code'
      },
      undefined
    )
  })

  it('seeds a working status from Command Code thinking output without a startup prompt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
    capturedDataCallback.current?.('❯ Fix the spinner\r\n\x1b[35m✻ Thinking...\x1b[0m')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'Fix the spinner',
        agentType: 'command-code'
      },
      undefined
    )
  })

  it('marks a Command Code no-tool turn done after the idle prompt settles', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(pane as never, manager as never, deps as never)
    vi.runOnlyPendingTimers()
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('❯ say hi\r\n✻ Thinking...')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      prompt: 'say hi',
      agentType: 'command-code'
    })

    capturedDataCallback.current?.(
      '\r\n✻ Thought for 1 second\r\n:: Hi! How can I help you today?\r\n❯ Ask your question...'
    )
    vi.advanceTimersByTime(1499)
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      prompt: 'say hi',
      agentType: 'command-code'
    })

    vi.advanceTimersByTime(1)
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      prompt: 'say hi',
      agentType: 'command-code'
    })
  })

  it('keeps Command Code working when an active repaint follows the idle prompt before settle', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(pane as never, manager as never, deps as never)
    vi.runOnlyPendingTimers()
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('❯ Run a slow command\r\n✻ Thinking...')
    capturedDataCallback.current?.('\r\n❯ Ask your question...')
    vi.advanceTimersByTime(1000)
    capturedDataCallback.current?.('\r\n✧ Investigating... esc to interrupt')
    vi.advanceTimersByTime(500)

    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      prompt: 'Run a slow command',
      agentType: 'command-code'
    })
  })

  it('does not downgrade a completed Command Code turn back to working from stale TUI output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      stateHistory: []
    }

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
    capturedDataCallback.current?.('❯ Fix the spinner\r\n\x1b[35m✻ Threading...\x1b[0m')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    expect((mockStoreState.agentStatusByPaneKey[paneKey] as { state?: unknown })?.state).toBe(
      'done'
    )
  })

  it('starts a new Command Code turn after done when TUI output carries a different prompt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      stateHistory: []
    }

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
    capturedDataCallback.current?.('❯ Fix the green done state\r\n\x1b[35m✻ Threading...\x1b[0m')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      paneKey,
      {
        state: 'working',
        prompt: 'Fix the green done state',
        agentType: 'command-code'
      },
      undefined
    )
  })

  it('delivers terminal-paste startup commands through xterm before submitting', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport()
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-local-paste'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const pane = createPane(1)
      pane.terminal.modes.bracketedPasteMode = true
      pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const command = 'cd packages\nbun run build\ncd ..'
      const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(createdTransportOptions[0]?.command).toBeUndefined()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@host $ ')
      for (const fn of pendingTimeouts) {
        fn()
      }
      await flushAsyncTicks()

      expect(pane.terminal.paste).toHaveBeenCalledWith(command)
      expect(transport.sendInput).toHaveBeenCalledWith('\r')
      expect(transport.sendInput).not.toHaveBeenCalledWith(`${command}\r`)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('infers interrupts only from the focused terminal key target', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop this task',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const unrelatedTarget = createKeyboardEventTarget()
    ;(
      globalThis.window as unknown as { addEventListener?: ReturnType<typeof vi.fn> }
    ).addEventListener = vi.fn()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    unrelatedTarget.dispatch({
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false
    } as KeyboardEvent)
    vi.advanceTimersByTime(500)
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(globalThis.window.addEventListener).not.toHaveBeenCalled()

    terminalTarget.dispatch({
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false
    } as KeyboardEvent)
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop this task',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
  })

  it('clears stale working pane title after inferred interrupt applies', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { resolveWorktreeStatus } = await import('@/lib/worktree-status')
    vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(true)
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop visible spinner',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps({
      setRuntimePaneTitle: vi.fn((tabId: string, paneId: number, title: string) => {
        mockStoreState.runtimePaneTitlesByTabId = {
          ...mockStoreState.runtimePaneTitlesByTabId,
          [tabId]: {
            ...mockStoreState.runtimePaneTitlesByTabId[tabId],
            [paneId]: title
          }
        }
      })
    })

    connectPanePty(pane as never, manager as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Terminal')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Terminal')
    expect(
      resolveWorktreeStatus({
        tabs: [{ id: 'tab-1', title: 'Codex working' }],
        browserTabs: [],
        ptyIdsByTabId: { 'tab-1': ['tab-pty'] },
        runtimePaneTitlesByTabId: mockStoreState.runtimePaneTitlesByTabId,
        hasPermission: false,
        hasLiveWorking: false,
        hasLiveDone: true,
        hasRetainedDone: false
      })
    ).toBe('done')
  })

  it('clears unchanged title-only working indicators after acknowledged interrupt input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps({
      setRuntimePaneTitle: vi.fn((tabId: string, paneId: number, title: string) => {
        mockStoreState.runtimePaneTitlesByTabId = {
          ...mockStoreState.runtimePaneTitlesByTabId,
          [tabId]: {
            ...mockStoreState.runtimePaneTitlesByTabId[tabId],
            [paneId]: title
          }
        }
      })
    })

    connectPanePty(pane as never, manager as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Terminal')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Terminal')
  })

  it('does not clear title-only working indicators when interrupt writes are unacknowledged', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    delete transport.sendInputAccepted
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const deps = createDeps()

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(transport.sendInput).toHaveBeenCalledWith('\x03')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(deps.setRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.updateTabTitle).not.toHaveBeenCalled()
  })

  it('infers exact Ctrl+C terminal input when keydown capture misses the press', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop from real terminal byte',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop from real terminal byte',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
  })

  it('marks bracketed paste as stale after acknowledged Ctrl+C input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { pasteTerminalText } = await import('./terminal-bracketed-paste')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.modes.bracketedPasteMode = true
    const observedIgnoreValues: (boolean | undefined)[] = []
    pane.terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(pane.terminal.options.ignoreBracketedPasteMode)
    })
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    pasteTerminalText(pane.terminal as never, 'a69ce28e1d092e0c8825cd1a109ac36409962bc1')

    expect(observedIgnoreValues).toEqual([true])
    expect(pane.terminal.options.ignoreBracketedPasteMode).toBe(false)
  })

  it('infers captured Ctrl+C even when xterm emits an enhanced keyboard sequence', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop enhanced keyboard input',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x1b[99;5u')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(transport.sendInputAccepted).toHaveBeenCalledWith('\x1b[99;5u')
    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop enhanced keyboard input',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
  })

  it('infers interrupt for an explicit working status even if the title is already non-agent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop after process exit',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x1b[99;5u')
    await flushAsyncTicks()
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Terminal 1'
      }
    }
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop after process exit',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it('keeps inferred interrupted status after the pane settles on a non-agent title', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop and leave shell',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    vi.mocked(window.api.agentStatus.inferInterrupt).mockImplementation(async () => {
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'stop and leave shell',
        interrupted: true,
        updatedAt: 1_100,
        stateStartedAt: 1_100,
        agentType: 'codex',
        paneKey,
        terminalTitle: 'Terminal 1'
      }
      return true
    })
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const deps = createDeps({
      setRuntimePaneTitle: vi.fn((tabId: string, paneId: number, title: string) => {
        mockStoreState.runtimePaneTitlesByTabId = {
          ...mockStoreState.runtimePaneTitlesByTabId,
          [tabId]: {
            ...mockStoreState.runtimePaneTitlesByTabId[tabId],
            [paneId]: title
          }
        }
      })
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x1b[99;5u')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()
    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalled()
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()

    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it('does not infer exact interrupt input when the transport cannot acknowledge writes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    delete transport.sendInputAccepted
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'ssh style write',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(transport.sendInput).toHaveBeenCalledWith('\x03')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('removes agent status and pane title on PTY exit after inferred interrupt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(true)
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop then exit',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const deps = createDeps()

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    if (!onPtyExit) {
      throw new Error('expected onPtyExit callback to be registered')
    }

    onPtyExit('tab-pty')

    expect(deps.clearRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'tab-pty')
    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, null)
    expect(mockStoreState.removeAgentStatus).toHaveBeenCalledWith(paneKey)
  })

  it('ignores repeated and modified terminal interrupt keydowns', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'keep running',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    for (const event of [
      {
        key: 'Escape',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: true
      },
      {
        key: 'Escape',
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: false,
        repeat: false
      },
      {
        key: 'c',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        repeat: false
      }
    ]) {
      terminalTarget.dispatch(event as KeyboardEvent)
    }
    vi.advanceTimersByTime(500)

    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('does not infer Ctrl+C when terminal selection turns the chord into copy', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'copy selection',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown; hasSelection: ReturnType<typeof vi.fn> }).element =
      terminalTarget.target
    ;(pane.terminal as { hasSelection: ReturnType<typeof vi.fn> }).hasSelection.mockReturnValue(
      true
    )

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    vi.advanceTimersByTime(500)

    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('removes the terminal key listener on dispose before a remount adds another', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const firstTransport = createMockTransport()
    const secondTransport = createMockTransport()
    transportFactoryQueue.push(firstTransport, secondTransport)
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target

    const firstConnection = connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps() as never
    )
    expect(terminalTarget.handlers.size).toBe(1)

    firstConnection.dispose()
    expect(terminalTarget.handlers.size).toBe(0)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    expect(terminalTarget.handlers.size).toBe(1)
    expect(terminalTarget.target.addEventListener).toHaveBeenCalledTimes(2)
    expect(terminalTarget.target.removeEventListener).toHaveBeenCalledTimes(1)
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

  it('does not enumerate every worktree tab for ordinary input without Codex restart notices', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-live')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {}
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
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('uses the current worktree tab for Codex stale fallback without enumerating all worktrees', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {
        'pty-other': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
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
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('blocks stale Codex fallback input from the current worktree tab without enumerating all worktrees', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
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
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('blocks input to stale Codex panes until they restart', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
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
      },
      agentStatusByPaneKey: {
        [makePaneKey('tab-1', LEAF_1)]: {
          paneKey: makePaneKey('tab-1', LEAF_1),
          state: 'working',
          prompt: 'stale input',
          updatedAt: 1_000,
          stateStartedAt: 900,
          agentType: 'codex',
          stateHistory: []
        }
      }
    }

    const pane = createPane(1)
    const terminalTarget = createKeyboardEventTarget()
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
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
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    sendTerminalInput('\x03')
    vi.advanceTimersByTime(500)

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('does not infer interrupts when mobile presence lock blocks terminal input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const ptyId = 'pty-mobile-locked'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        ptyIdsByTabId: { 'tab-1': [ptyId] },
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            state: 'working',
            prompt: 'locked input',
            updatedAt: 1_000,
            stateStartedAt: 900,
            agentType: 'codex',
            stateHistory: []
          }
        }
      }

      const pane = createPane(1)
      const terminalTarget = createKeyboardEventTarget()
      ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
      ;(onDataHandler as unknown as (data: string) => void)('\x03')
      vi.advanceTimersByTime(500)

      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('does not infer interrupts when the transport rejects terminal input', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const transport = createMockTransport('pty-disconnected')
    transport.sendInput.mockReturnValue(false)
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'working',
      prompt: 'disconnected input',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      stateHistory: []
    }

    const pane = createPane(1)
    const terminalTarget = createKeyboardEventTarget()
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    vi.advanceTimersByTime(500)

    expect(transport.sendInput).toHaveBeenCalledWith('\x03')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('does not infer interrupts when the main process rejects acknowledged input', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const transport = createMockTransport('pty-mobile-race')
    transport.sendInputAccepted = vi.fn().mockResolvedValue(false)
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'working',
      prompt: 'mobile race input',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      stateHistory: []
    }

    const pane = createPane(1)
    const terminalTarget = createKeyboardEventTarget()
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)

    expect(transport.sendInputAccepted).toHaveBeenCalledWith('\x03')
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
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

  it('drops agent status without retaining when OSC 133 reports the command finished', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-local-1'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'done',
          prompt: 'hi',
          updatedAt: 1000,
          stateStartedAt: 1000,
          agentType: 'codex',
          stateHistory: []
        }
      }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ isVisibleRef: { current: false } })

    connectPanePty(pane as never, manager as never, deps as never)

    capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')

    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
    expect(mockStoreState.removeAgentStatus).not.toHaveBeenCalled()
  })

  it('flushes pending interrupt inference before dropping an exited foreground agent command', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    const writeAccepted = createDeferred<boolean>()
    transport.sendInputAccepted = vi.fn(() => writeAccepted.promise)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return { id: 'tab-pty' }
    })
    transport.attach.mockImplementation(({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
    })
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'stop quickly',
          updatedAt: 1_000,
          stateStartedAt: 900,
          agentType: 'codex',
          terminalTitle: 'Codex',
          stateHistory: []
        }
      }
    }
    vi.mocked(window.api.agentStatus.inferInterrupt).mockImplementation(async () => {
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        paneKey,
        state: 'done',
        prompt: 'stop quickly',
        updatedAt: 1_100,
        stateStartedAt: 1_100,
        agentType: 'codex',
        terminalTitle: 'Codex',
        interrupted: true,
        stateHistory: [
          {
            state: 'working',
            prompt: 'stop quickly',
            startedAt: 900
          }
        ]
      }
      return true
    })
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    vi.advanceTimersByTime(1_000)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(
      keyEvent({
        key: 'c',
        ctrlKey: true
      })
    )
    ;(onDataHandler as unknown as (data: string) => void)('\x03')

    capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()

    writeAccepted.resolve(true)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop quickly',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
  })

  it('drops the command-finished status when pending interrupt inference is rejected', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(false)
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return { id: 'tab-pty' }
    })
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'stop quickly',
          updatedAt: 1_000,
          stateStartedAt: 900,
          agentType: 'codex',
          terminalTitle: 'Codex',
          stateHistory: []
        }
      }
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    vi.advanceTimersByTime(1_000)
    await flushAsyncTicks()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')

    capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalled()
    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
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
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'leaf-pty-2' }
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
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'stale-pty' }
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

  it('spawns a fresh PTY when a non-deferred SSH reattach reports expired via onError', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(
      async (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (opts.sessionId) {
          opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: restored-session')
          return undefined
        }
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        onPtySpawn?.('fresh-ssh-pty')
        return 'fresh-ssh-pty'
      }
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(10)

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, null)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'restored-session')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-ssh-pty')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-ssh-pty')
  })

  it('resets reattach cursor/focus state after daemon snapshot replay without applying the full mode reset', async () => {
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
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H', expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '\x1b[?1004hrestored snapshot',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      POST_REPLAY_REATTACH_RESET,
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
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
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
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
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

  // Regression for foreground input lag with many background terminals:
  // hidden panes still feed xterm, but their writes are scheduled through
  // the shared output drain so 100 panes cannot all start xterm WriteBuffer
  // setTimeout handlers in the same event-loop burst.
  it('queues non-visible PTY bytes before writing them into xterm', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

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
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()
      capturedDataCallback.current?.('hello\r\n')
      expect(pane.terminal.write).not.toHaveBeenCalledWith('hello\r\n')

      for (const fn of pendingTimeouts) {
        fn()
      }

      expect(pane.terminal.write).toHaveBeenCalledWith('hello\r\n')
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('writes visible split-pane PTY bytes immediately even when the tab is not active', async () => {
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
    capturedDataCallback.current?.('visible split output\r\n')

    expect(pane.terminal.write).toHaveBeenCalledWith(
      'visible split output\r\n',
      expect.any(Function)
    )
  })

  it('restores visible pane PTY bytes from the main snapshot when the document was hidden', async () => {
    const visibilityListeners = new Set<() => void>()
    const documentStub = {
      visibilityState: 'hidden' as DocumentVisibilityState,
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange' && typeof listener === 'function') {
          visibilityListeners.add(listener as () => void)
        }
      }),
      removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange' && typeof listener === 'function') {
          visibilityListeners.delete(listener as () => void)
        }
      })
    }
    ;(globalThis as { document?: Document }).document = documentStub as unknown as Document
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
    const backgroundedOutput = 'backgrounded document output\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: backgroundedOutput,
      cols: 120,
      rows: 40,
      seq: backgroundedOutput.length
    })

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
    capturedDataCallback.current?.(backgroundedOutput, {
      seq: backgroundedOutput.length,
      rawLength: backgroundedOutput.length
    })

    expect(pane.terminal.write).not.toHaveBeenCalledWith(backgroundedOutput, expect.any(Function))

    vi.advanceTimersByTime(50)
    expect(pane.terminal.write).not.toHaveBeenCalledWith(backgroundedOutput, expect.any(Function))

    documentStub.visibilityState = 'visible'
    for (const listener of visibilityListeners) {
      listener()
    }
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.write).toHaveBeenCalledWith(backgroundedOutput, expect.any(Function))
  })

  it('restores ordinary hidden pane output from the main snapshot on foreground output', async () => {
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
    const hidden = 'hidden output\r\n'
    const live = 'visible-after\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: `${hidden}${live}`,
      cols: 120,
      rows: 40,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    vi.useFakeTimers()
    vi.advanceTimersByTime(50)
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden, expect.any(Function))

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.write).toHaveBeenCalledWith(`${hidden}${live}`, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden, expect.any(Function))
    disposable.dispose()
  })

  it('pauses renderer PTY output while hidden and restores from main snapshot on show', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    transport.connect.mockResolvedValue('pty-id')
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const pauseOutput = window.api.pty.pauseOutput as unknown as ReturnType<typeof vi.fn>
    getMainBufferSnapshot.mockResolvedValue({
      data: 'hidden while paused\r\n',
      cols: 120,
      rows: 40,
      seq: 21
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(pauseOutput).toHaveBeenCalledWith('pty-id', true)

    ;(deps.isVisibleRef as { current: boolean }).current = true
    binding.syncRendererOutputVisibility()
    await flushAsyncTicks(20)

    expect(pauseOutput).toHaveBeenCalledWith('pty-id', false)
    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'hidden while paused\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden Codex telemetry startup output parsing briefly before pausing renderer output', async () => {
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(0)
    const scheduledTimers: { callback: () => void; delay: number }[] = []
    globalThis.setTimeout = vi.fn((callback: () => void, delay?: number) => {
      scheduledTimers.push({ callback, delay: typeof delay === 'number' ? delay : 0 })
      return scheduledTimers.length as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = vi.fn() as unknown as typeof clearTimeout
    let binding: { dispose: () => void } | null = null
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const pauseOutput = window.api.pty.pauseOutput as unknown as ReturnType<typeof vi.fn>

      const pane = createPane(1)
      const manager = createManager(1)
      binding = connectPanePty(
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
      expect(pauseOutput).not.toHaveBeenCalledWith('pty-id', true)

      capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

      expect(pane.terminal.write).toHaveBeenCalledWith(
        '\x1b]11;?\x1b\\startup frame\r\n',
        expect.any(Function)
      )

      dateNowSpy.mockReturnValue(10_001)
      scheduledTimers.find((timer) => timer.delay === 10_000)?.callback()
      await flushAsyncTicks()

      expect(pauseOutput).toHaveBeenCalledWith('pty-id', true)
    } finally {
      binding?.dispose()
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
      dateNowSpy.mockRestore()
    }
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
    const pauseOutput = window.api.pty.pauseOutput as unknown as ReturnType<typeof vi.fn>

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
    expect(pauseOutput).not.toHaveBeenCalledWith('pty-id', true)

    capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

    expect(pane.terminal.write).toHaveBeenCalledWith(
      '\x1b]11;?\x1b\\startup frame\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('pauses arbitrary hidden startup commands immediately', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const pauseOutput = window.api.pty.pauseOutput as unknown as ReturnType<typeof vi.fn>

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
    expect(pauseOutput).toHaveBeenCalledWith('pty-id', true)

    capturedDataCallback.current?.('hidden startup output\r\n')

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'hidden startup output\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('answers mode 2031 in hidden snapshot-backed chunks skipped from xterm parsing', async () => {
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

    capturedDataCallback.current?.('\x1b[?2031h')

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b[?997;2n')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b[?2031h', expect.any(Function))

    binding.dispose()
  })

  it('restores hidden backlog overflow from the main terminal snapshot on foreground output', async () => {
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
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
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
    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H', expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith('snapshot-state\r\n', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('ignores an async hidden-backlog snapshot if the pane changes PTYs first', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('old-pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'old-pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'old-live-output\r\n'

    const pane = createPane(1)
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
    await flushAsyncTicks(2)
    transport.getPtyId.mockReturnValue('new-pty-id')
    snapshot.resolve({
      data: 'old-snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('old-pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'old-snapshot-state\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('does not recover stale hidden backlog state after the pane switches PTYs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('old-pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'old-pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const newPtyOutput = 'new-pty-output\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    transport.getPtyId.mockReturnValue('new-pty-id')
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(newPtyOutput, {
      seq: newPtyOutput.length,
      rawLength: newPtyOutput.length
    })
    await flushAsyncTicks(10)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(newPtyOutput, expect.any(Function))
    disposable.dispose()
  })

  it('does not replay pending hidden restore chunks after a terminal clear', async () => {
    const clearBufferCallback: {
      current: ((request: { ptyId: string }) => void) | null
    } = { current: null }
    window.api.pty.onClearBufferRequest = vi.fn((callback) => {
      clearBufferCallback.current = callback as (request: { ptyId: string }) => void
      return vi.fn()
    })
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
    const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'pre-clear-live-output\r\n'

    const pane = createPane(1)
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
    await flushAsyncTicks(2)
    expect(clearBufferCallback.current).not.toBeNull()

    clearBufferCallback.current?.({ ptyId: 'pty-id' })
    snapshot.resolve({
      data: '',
      cols: 120,
      rows: 40,
      seq: hidden.length + live.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.clear).toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b[2J\x1b[3J\x1b[H',
      expect.any(Function)
    )
    disposable.dispose()
  })

  it('keeps recovery pending when hidden output arrives during an in-flight snapshot', async () => {
    let visibilityState: DocumentVisibilityState = 'visible'
    const visibilityChangeHandler: { current: (() => void) | null } = { current: null }
    ;(globalThis as { document?: Document }).document = {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') {
          visibilityChangeHandler.current = listener as () => void
        }
      }),
      removeEventListener: vi.fn()
    } as unknown as Document

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
    const firstSnapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
    }>()
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const visibleLive = 'visible-before-hide\r\n'
    const hiddenAgain = 'hidden-during-restore\r\n'
    getMainBufferSnapshot.mockReturnValueOnce(firstSnapshot.promise).mockResolvedValueOnce({
      data: 'snapshot-after-hidden-again\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length + visibleLive.length + hiddenAgain.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    visibilityState = 'visible'
    capturedDataCallback.current?.(visibleLive, {
      seq: hidden.length + visibleLive.length,
      rawLength: visibleLive.length
    })
    await flushAsyncTicks(2)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

    ;(deps.isVisibleRef as { current: boolean }).current = false
    visibilityState = 'hidden'
    capturedDataCallback.current?.(hiddenAgain, {
      seq: hidden.length + visibleLive.length + hiddenAgain.length,
      rawLength: hiddenAgain.length
    })
    firstSnapshot.resolve({
      data: 'snapshot-before-hidden-again\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length + visibleLive.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-before-hidden-again\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hiddenAgain, expect.any(Function))

    ;(deps.isVisibleRef as { current: boolean }).current = true
    visibilityState = 'visible'
    visibilityChangeHandler.current?.()
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-after-hidden-again\r\n',
      expect.any(Function)
    )
    disposable.dispose()
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

  it('writes foreground chunks that are newer than the restored main snapshot', async () => {
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
    const live = 'new-live-output\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-before-live\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length
    })

    const pane = createPane(1)
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

    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-before-live\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('re-snapshots instead of duplicating partially overlapped chunks with stripped OSC bytes', async () => {
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
    const cleanedLive = 'clean-visible-output\r\n'
    const rawLiveLength = cleanedLive.length + 32
    getMainBufferSnapshot
      .mockResolvedValueOnce({
        data: 'snapshot-splits-osc-live\r\n',
        cols: 120,
        rows: 40,
        seq: hidden.length + 4
      })
      .mockResolvedValueOnce({
        data: 'snapshot-after-osc-live\r\n',
        cols: 120,
        rows: 40,
        seq: hidden.length + rawLiveLength
      })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(cleanedLive, {
      seq: hidden.length + rawLiveLength,
      rawLength: rawLiveLength
    })
    await flushAsyncTicks(30)

    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-after-osc-live\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(cleanedLive, expect.any(Function))
    disposable.dispose()
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
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'Arabic: السلام عليكم\r\n',
      expect.any(Function)
    )
  })

  it('keeps panes on WebGL for terminal UI drawing glyphs', async () => {
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

    capturedDataCallback.current?.('⠋ Working ├─ file.ts █ progress \uE0B0 prompt\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '⠋ Working ├─ file.ts █ progress \uE0B0 prompt\r\n',
      expect.any(Function)
    )
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

  it('attaches remote runtime PTY handles instead of creating a replacement terminal', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'remote:terminal-1' }]
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-1'
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'remote:terminal-1' })
    )
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:terminal-1')
  })

  it('constructs restored encoded remote PTYs with their owning runtime environment', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'remote:env-1@@terminal-1' }]
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-2'
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('env-1', expect.any(Object))
    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'remote:env-1@@terminal-1' })
    )
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:env-1@@terminal-1')
  })

  it('attaches restored remote PTYs for later split panes instead of spawning host tabs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const existingTransport = createMockTransport('remote:env-1@@terminal-1')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'remote:env-1@@terminal-1' }]
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-1'
      }
    } as StoreState

    const paneTransports = new Map([[1, existingTransport]])
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: {
        [LEAF_2]: 'remote:env-1@@terminal-2'
      },
      paneTransportsRef: { current: paneTransports }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'remote:env-1@@terminal-2' })
    )
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:env-1@@terminal-2')
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
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'pty-restarted' }
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
  // indicator, the pane marker, and an OS notification. The unread flags
  // clear when the user actually interacts with the pane — keystroke via
  // xterm onData or pointerdown on the container (see TerminalPane.tsx). This test
  // locks in the mark wiring; separate tests below cover the clear path.
  it('wires onBell to raise worktree unread, tab unread, and OS notification', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
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
    expect(deps.markTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'terminal-bell',
        paneKey: makePaneKey('tab-1', LEAF_1)
      })
    )
  })

  it('does not raise pane attention on bell when the experimental setting is disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: false
    }

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
    expect(deps.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  it('lets concurrent agent-complete notifications win over terminal bell notifications', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Fix notification payloads',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Codex done',
      stateHistory: [],
      lastAssistantMessage: 'Implemented the formatter.'
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!bellHandler || !idleHandler) {
      throw new Error('Expected bell and idle handlers to be registered')
    }

    bellHandler()
    idleHandler('* Codex done')
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()

    expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(1)
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: '* Codex done',
        agentType: 'codex',
        agentLastAssistantMessage: 'Implemented the formatter.'
      })
    )
  })

  it('does not suppress terminal bell notifications when agent-complete notifications are disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!bellHandler || !idleHandler) {
      throw new Error('Expected bell and idle handlers to be registered')
    }

    bellHandler()
    idleHandler('* Codex done')
    vi.advanceTimersByTime(250)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    vi.advanceTimersByTime(1000)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('shares one raw store subscriber for agent-complete notification settings across panes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    transportFactoryQueue.push(createMockTransport('pty-1'), createMockTransport('pty-2'))

    vi.useFakeTimers()
    const firstBinding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps() as never
    )
    const secondBinding = connectPanePty(
      createPane(2) as never,
      createManager(1) as never,
      createDeps() as never
    )
    await flushAsyncTicks()

    expect(storeSubscribers).toHaveLength(1)

    firstBinding.dispose()
    expect(storeSubscribers).toHaveLength(1)
    secondBinding.dispose()
    expect(storeSubscribers).toHaveLength(0)
  })

  it('does not dispatch generic title completions when agent-complete notifications are disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const api = (
      globalThis as unknown as {
        window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
      }
    ).window.api
    api.pty.getForegroundProcess.mockResolvedValue('codex')
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('⠋ experimental-agent-observability', '⠋ experimental-agent-observability')
    titleHandler('experimental-agent-observability', 'experimental-agent-observability')
    await flushAsyncTicks()
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('does not replay disabled generic title completions after notifications are re-enabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const inspection = createDeferred<string | null>()
    const api = (
      globalThis as unknown as {
        window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
      }
    ).window.api
    api.pty.getForegroundProcess.mockReturnValue(inspection.promise)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('⠋ experimental-agent-observability', '⠋ experimental-agent-observability')
    titleHandler('experimental-agent-observability', 'experimental-agent-observability')
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: true
      }
    }
    inspection.resolve('codex')
    await flushAsyncTicks()
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('clears title completion state when notifications are disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('Claude working', 'Claude working')
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: false
      }
    }
    notifyStoreSubscribers()
    titleHandler('Claude done', 'Claude done')
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: true
      }
    }
    notifyStoreSubscribers()
    titleHandler('Claude done', 'Claude done')
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('cancels scheduled agent completion when notifications are disabled before dispatch', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Codex done')
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: false
      }
    }
    notifyStoreSubscribers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: true
      }
    }
    notifyStoreSubscribers()
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('restores a suppressed terminal bell when disabling pending agent completion', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!bellHandler || !idleHandler) {
      throw new Error('Expected bell and idle handlers to be registered')
    }

    bellHandler()
    idleHandler('* Codex done')
    vi.advanceTimersByTime(250)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: false
      }
    }
    notifyStoreSubscribers()
    vi.advanceTimersByTime(250)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
  })

  it('requires fresh working evidence after notifications are disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!workingHandler || !idleHandler) {
      throw new Error('Expected working and idle handlers to be registered')
    }

    workingHandler()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: false
      }
    }
    notifyStoreSubscribers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: true
      }
    }
    notifyStoreSubscribers()
    idleHandler('* Codex done')
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('requires fresh working evidence when notifications start disabled then re-enable', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!workingHandler || !idleHandler) {
      throw new Error('Expected working and idle handlers to be registered')
    }

    workingHandler()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: true
      }
    }
    notifyStoreSubscribers()
    idleHandler('* Codex done')
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('dispatches agent-task-complete for generic Codex spinner titles after process identity is confirmed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const api = (
      globalThis as unknown as {
        window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
      }
    ).window.api
    api.pty.getForegroundProcess.mockResolvedValue('codex')
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('⠋ experimental-agent-observability', '⠋ experimental-agent-observability')
    titleHandler('experimental-agent-observability', 'experimental-agent-observability')
    await flushAsyncTicks()

    vi.advanceTimersByTime(1000)

    expect(deps.dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: 'experimental-agent-observability',
      paneKey: makePaneKey('tab-1', LEAF_1)
    })
  })

  it('does not dispatch generic spinner completions when process inspection finds no agent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-shell')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const api = (
      globalThis as unknown as {
        window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
      }
    ).window.api
    api.pty.getForegroundProcess.mockResolvedValue('zsh')
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('⠋ experimental-agent-observability', '⠋ experimental-agent-observability')
    titleHandler('experimental-agent-observability', 'experimental-agent-observability')
    await flushAsyncTicks()

    vi.advanceTimersByTime(16_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('dispatches agent-task-complete from recognized hook completion events', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage: string
        }) => void)
      | undefined
    if (!statusHandler) {
      throw new Error('Expected onAgentStatus to be registered')
    }

    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Done.'
    })
    vi.advanceTimersByTime(250)

    expect(deps.dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: 'codex',
      paneKey: makePaneKey('tab-1', LEAF_1)
    })
  })

  it('restores a suppressed terminal bell when the pending agent completion is canceled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    if (!bellHandler || !idleHandler || !workingHandler) {
      throw new Error('Expected bell, idle, and working handlers to be registered')
    }

    bellHandler()
    idleHandler('* Codex done')
    workingHandler()
    vi.advanceTimersByTime(250)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
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
    expect(deps.clearTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
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
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'leaf-session' }
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
      POST_REPLAY_REATTACH_RESET,
      expect.any(Function)
    )
    expect(api.pty.signal).toHaveBeenCalledWith('leaf-session', 'SIGWINCH')
  })

  it('does not auto-reconnect after a user cancels deferred SSH passphrase auth', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'disconnected' }]]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'saved-session' }
    }

    const api = (
      globalThis as unknown as {
        window: {
          api: {
            ssh: {
              connect: ReturnType<typeof vi.fn>
              needsPassphrasePrompt: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    ).window.api
    api.ssh.needsPassphrasePrompt.mockResolvedValue(true)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(3)

    mockStoreState.sshConnectionStates = new Map([['conn-1', { status: 'connecting' }]])
    notifyStoreSubscribers()
    mockStoreState.sshConnectionStates = new Map([['conn-1', { status: 'disconnected' }]])
    notifyStoreSubscribers()
    await flushAsyncTicks(10)

    expect(api.ssh.connect).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshSessionId).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshReconnectTarget).not.toHaveBeenCalled()
  })

  it('spawns a fresh PTY when a deferred SSH session expired', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts) => {
      if (opts.sessionId) {
        opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: expired-session')
        return undefined
      }
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('fresh-ssh-pty')
      return 'fresh-ssh-pty'
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
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, null)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'expired-session')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'fresh-ssh-pty')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-ssh-pty')
  })

  // Why: the working→idle transition fires an 'agent-task-complete' OS
  // notification (user-toggleable in Settings) and raises the same visual
  // attention marker as BEL so agents that don't emit BEL still leave a
  // findable terminal highlight. Double-firing with a concurrent BEL is
  // idempotent in the unread stores and collapsed by the per-worktree dedupe
  // in main/ipc/notifications.ts.
  //
  // This test deliberately wires the real useNotificationDispatch hook into
  // connectPanePty instead of a vi.fn() stub. A stub would let the producer
  // be silently deleted and the test still pass by asserting "not called";
  // routing through the real hook to window.api.notifications.dispatch means
  // removing the producer breaks the IPC assertion, which is the user-facing
  // contract.
  it('dispatches agent-task-complete on working→idle and raises tab/worktree unread', async () => {
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
    const realDispatchNotification = useNotificationDispatch('wt-1')
    const dispatchNotification = vi.fn((event) => realDispatchNotification(event))
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Fix notification payloads',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Claude done',
      stateHistory: [],
      toolName: 'Edit',
      toolInput: 'src/main/ipc/notifications.ts',
      lastAssistantMessage: 'Implemented the formatter.',
      interrupted: false
    }
    mockStoreState.worktreesByRepo.repo2 = [
      { id: 'wt-2', repoId: 'repo2', path: '/tmp/wt-2', displayName: 'feat/other' }
    ]
    mockStoreState.repos.push({ id: 'repo2', connectionId: null, displayName: 'docs' })
    mockStoreState.activeWorktreeId = 'wt-2'

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

    vi.useFakeTimers()
    idleHandler('* Claude done')

    expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockStoreState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(dispatchNotification).not.toHaveBeenCalled()

    vi.advanceTimersByTime(250)
    await flushAsyncTicks()

    expect(dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: '* Claude done',
      paneKey
    })
    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith('wt-1')
    expect(mockStoreState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockStoreState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-1',
        repoLabel: 'orca',
        worktreeLabel: 'feat/notis',
        hasMultipleActiveRepos: true,
        terminalTitle: '* Claude done',
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'Fix notification payloads',
        agentToolName: 'Edit',
        agentToolInput: 'src/main/ipc/notifications.ts',
        agentLastAssistantMessage: 'Implemented the formatter.',
        agentInterrupted: false
      })
    )
  })

  it('resets renderer cursor style when an agent becomes idle', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Codex done')

    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('queues the idle cursor reset behind hidden agent output', async () => {
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
    vi.useFakeTimers()

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!capturedDataCallback.current || !idleHandler) {
      throw new Error('Expected PTY data and idle handlers to be registered')
    }

    capturedDataCallback.current('\x1b[6 q')
    idleHandler('* Codex done')

    expect(pane.terminal.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(pane.terminal.write).toHaveBeenCalledWith(`\x1b[6 q${RESET_TERMINAL_CURSOR_STYLE}`)
  })

  it('waits briefly for delayed agent status before dispatching task-complete', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
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

    idleHandler('* Codex done')
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()

    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Use delayed hook status in notification',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Codex done',
      stateHistory: [],
      lastAssistantMessage: 'Delayed status arrived.'
    }

    vi.advanceTimersByTime(250)
    await flushAsyncTicks()

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: '* Codex done',
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'Use delayed hook status in notification',
        agentLastAssistantMessage: 'Delayed status arrived.'
      })
    )
  })

  it('waits past the grace delay when the assistant message arrives shortly after it', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
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

    idleHandler('* Codex done')
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Use the late hook status in notification',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Codex done',
      stateHistory: [],
      lastAssistantMessage: 'Late status arrived.'
    }
    notifyStoreSubscribers()
    await flushAsyncTicks()

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: '* Codex done',
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'Use the late hook status in notification',
        agentLastAssistantMessage: 'Late status arrived.'
      })
    )
  })

  it('does not use stale agent status from an earlier turn in task-complete notifications', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Previous task that must not leak',
      updatedAt: Date.now() - 15_000,
      stateStartedAt: Date.now() - 20_000,
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Codex done',
      stateHistory: [],
      lastAssistantMessage: 'Old response'
    }

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

    idleHandler('* Codex done')
    vi.advanceTimersByTime(1000)
    await flushAsyncTicks()

    const dispatchArgs = (window.api.notifications.dispatch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown> | undefined
    if (!dispatchArgs) {
      throw new Error('Expected notification dispatch')
    }
    expect(dispatchArgs).toMatchObject({
      source: 'agent-task-complete',
      worktreeId: 'wt-1',
      terminalTitle: '* Codex done'
    })
    expect('agentPrompt' in dispatchArgs).toBe(false)
    expect('agentLastAssistantMessage' in dispatchArgs).toBe(false)
    expect('agentType' in dispatchArgs).toBe(false)
  })

  it('does not attach agent fields to terminal-bell notifications', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Should not leak into BEL',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler) {
      throw new Error('Expected onBell to be registered')
    }

    vi.useFakeTimers()
    bellHandler()
    vi.advanceTimersByTime(250)

    const dispatchArgs = (window.api.notifications.dispatch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown> | undefined
    if (!dispatchArgs) {
      throw new Error('Expected notification dispatch')
    }
    expect(dispatchArgs.source).toBe('terminal-bell')
    expect('agentType' in dispatchArgs).toBe(false)
    expect('agentState' in dispatchArgs).toBe(false)
    expect('agentPrompt' in dispatchArgs).toBe(false)
    expect('agentToolName' in dispatchArgs).toBe(false)
    expect('agentToolInput' in dispatchArgs).toBe(false)
    expect('agentLastAssistantMessage' in dispatchArgs).toBe(false)
    expect('agentInterrupted' in dispatchArgs).toBe(false)
  })

  // Why: title reversion clears cache UI, but agent-row removal belongs to
  // process/PTY lifecycle so interrupts cannot disappear the activity row.
  it('clears the cache timer without removing agent status when the title tracker sees exit', async () => {
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

    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1), null)
    expect(mockStoreState.removeAgentStatus).not.toHaveBeenCalled()
  })
})
