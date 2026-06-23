/* oxlint-disable max-lines */
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_TERMINAL_CURSOR_STYLE
} from './layout-serialization'
import { TERMINAL_PASTE_DIRECT_MAX_BYTES } from './terminal-paste-coordinator'
import type * as UseNotificationDispatchModule from './use-notification-dispatch'
import { getEagerPtyBufferHandle } from './pty-dispatcher'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'

// Repro command:
//   pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/pty-connection.test.ts -t "OpenTUI-style small ANSI redraw"

// Why: the fresh-spawn and reattach paths now chain pre-signal → spawn →
// register/settle through multiple microtasks. Tests that previously flushed
// once with `await Promise.resolve()` must drain a few extra ticks before
// asserting against IPC mocks. See docs/mobile-prefer-renderer-scrollback.md.
async function flushAsyncTicks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

async function drainPendingTimeouts(pendingTimeouts: (() => void)[], limit = 100): Promise<void> {
  let iterations = 0
  while (pendingTimeouts.length > 0) {
    if (iterations >= limit) {
      throw new Error('Timed out draining pending timeouts')
    }
    iterations += 1
    pendingTimeouts.shift()?.()
    await flushAsyncTicks()
  }
}

const toastInfo = vi.fn()
const LEAF_1 = '11111111-1111-4111-8111-111111111111' as const
const LEAF_2 = '22222222-2222-4222-8222-222222222222' as const
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS = 250
const AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS = 1_500

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
  repos: {
    id: string
    connectionId?: string | null
    displayName?: string
    executionHostId?: string | null
  }[]
  projects: {
    id: string
    localWindowsRuntimePreference?:
      | { kind: 'inherit-global' }
      | { kind: 'windows-host' }
      | { kind: 'wsl'; distro: string }
  }[]
  sshConnectionStates: Map<string, { status: string }>
  cacheTimerByKey: Record<string, number | null>
  settings: {
    theme?: 'system' | 'dark' | 'light'
    promptCacheTimerEnabled?: boolean
    activeRuntimeEnvironmentId?: string | null
    experimentalTerminalAttention?: boolean
    terminalWindowsShell?: string
    terminalWindowsWslDistro?: string | null
    localWindowsRuntimeDefault?: { kind: 'windows-host' } | { kind: 'wsl'; distro: string | null }
    notifications?: {
      enabled?: boolean
      agentTaskComplete?: boolean
      terminalBell?: boolean
      suppressWhenFocused?: boolean
      customSoundPath?: string | null
    }
    agentCmdOverrides?: Record<string, string>
    agentDefaultArgs?: Record<string, string>
    agentDefaultEnv?: Record<string, Record<string, string>>
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
  sleepingAgentSessionsByPaneKey: Record<string, unknown>
  agentLaunchConfigByPaneKey: Record<string, { launchConfig: unknown }>
  getAgentLaunchConfigForStatusEntry: ReturnType<typeof vi.fn>
  clearSleepingAgentSession: ReturnType<typeof vi.fn>
  registerAgentLaunchConfig: ReturnType<typeof vi.fn>
  clearAgentLaunchConfig: ReturnType<typeof vi.fn>
  markWorktreeUnread: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
  recordTerminalInput: ReturnType<typeof vi.fn>
  setAgentStatus: ReturnType<typeof vi.fn>
  removeAgentStatus: ReturnType<typeof vi.fn>
  dropAgentStatus: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  markAgentCompletionPaneUnread: ReturnType<typeof vi.fn>
}

type ConnectCallbacks = {
  onData?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
  onReplayData?: (data: string) => void
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
  serializeBuffer?: ReturnType<typeof vi.fn>
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

// Why: the adopt-vs-reattach decision consults the eager-PTY buffer registry to
// tell a still-live locally-spawned PTY (attach + replay) from a daemon session
// to re-connect. Keep the real module but stub the lookup so tests can simulate
// a live eager buffer without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

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
    getPtyId: vi.fn(() => ptyId),
    serializeBuffer: undefined
  } as MockTransport
  const sendInput = transport.sendInput as unknown as (data: string) => boolean
  transport.sendInputAccepted = vi.fn(async (data: string) => sendInput(data))
  return transport
}

function createPaneContainer(): HTMLElement {
  const container = new EventTarget() as HTMLElement
  Object.defineProperty(container, 'dataset', {
    configurable: true,
    value: {}
  })
  return container
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
        registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
        registerOscHandler: vi.fn(() => ({ dispose: vi.fn() }))
      }
    },
    container: createPaneContainer(),
    fitAddon: {
      fit: vi.fn()
    }
  }
}

function createManager(paneCount = 1) {
  return {
    setPaneGpuRendering: vi.fn(),
    markPaneHasComplexScriptOutput: vi.fn(),
    rebuildPaneWebgl: vi.fn(),
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
    paneMode2031Ref: { current: new Map() },
    paneLastThemeModeRef: { current: new Map() },
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
    onShowSessionRestoredBanner: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    ...overrides
  }
}

// Why: setting activeRuntimeEnvironmentId in mockStoreState exercises the
// remote-runtime path where the renderer still owns OSC 9999 status.
function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
  mockStoreState = {
    ...mockStoreState,
    settings: {
      ...mockStoreState.settings,
      activeRuntimeEnvironmentId: environmentId
    }
  } as StoreState
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
      projects: [],
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
      sleepingAgentSessionsByPaneKey: {},
      agentLaunchConfigByPaneKey: {},
      getAgentLaunchConfigForStatusEntry: vi.fn((entry: { paneKey: string }) => {
        return mockStoreState.agentLaunchConfigByPaneKey[entry.paneKey]?.launchConfig
      }),
      clearSleepingAgentSession: vi.fn((paneKey: string) => {
        delete mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]
      }),
      registerAgentLaunchConfig: vi.fn(),
      clearAgentLaunchConfig: vi.fn(),
      markWorktreeUnread: vi.fn(),
      observeTerminalGitHubPullRequestLink: vi.fn(),
      recordTerminalInput: vi.fn(),
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
      markTerminalPaneUnread: vi.fn(),
      markAgentCompletionPaneUnread: vi.fn()
    } as StoreState
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        ssh: {
          connect: vi.fn().mockResolvedValue({ status: 'connected' }),
          needsPassphrasePrompt: vi.fn().mockResolvedValue(false)
        },
        pty: {
          signal: vi.fn(),
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
        platform: {
          get: vi.fn(() => ({ platform: 'win32', osRelease: '10.0.26100' }))
        },
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true }),
          playSound: vi.fn().mockResolvedValue({ played: true })
        },
        runtime: {
          restoreTerminalFit: vi.fn().mockResolvedValue({ restored: true })
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
  }, 30_000)

  it('threads the resolved local project runtime into IPC terminal transport options', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: {
        ...mockStoreState.settings,
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' }
      },
      projects: [{ id: 'repo1', localWindowsRuntimePreference: { kind: 'windows-host' } }]
    }

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    expect(createdTransportOptions[0]?.projectRuntime).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: 'repo1',
        reason: 'project-override',
        cacheKey: 'repo1:windows-host'
      }
    })
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

  it('keeps a fresh split pane mounted when its newborn PTY exits before output or input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')

    onPtyExit?.('pty-pane-2')

    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, null)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-pane-2')
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('closes a split pane when an established PTY exits after output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-pane-2')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-pane-2'
    })
    transportFactoryQueue.push(transport)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    expect(capturedDataCallback.current).toBeTypeOf('function')

    capturedDataCallback.current?.('shell prompt')
    onPtyExit?.('pty-pane-2')

    expect(manager.closePane).toHaveBeenCalledWith(2)
  })

  it('closes a split pane when an established PTY exits after terminal input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(2)
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    const onDataMock = pane.terminal.onData as unknown as {
      mock: { calls: [[(data: string) => void] | []] }
    }
    const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(terminalInputHandler).toBeTypeOf('function')
    expect(onPtyExit).toBeTypeOf('function')

    terminalInputHandler?.('exit\r')
    onPtyExit?.('pty-pane-2')

    expect(manager.closePane).toHaveBeenCalledWith(2)
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
      const transport = createMockTransport('pty-id')
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
      await drainPendingTimeouts(pendingTimeouts)
      await flushAsyncTicks()

      expect(pane.terminal.paste).toHaveBeenCalledWith(command)
      expect(transport.sendInput).toHaveBeenCalledWith('\r')
      expect(transport.sendInput).not.toHaveBeenCalledWith(`${command}\r`)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('chunks large terminal-paste startup commands through the PTY before submitting', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-id')
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
      pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const command = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`
      const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(createdTransportOptions[0]?.command).toBeUndefined()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@host $ ')
      await drainPendingTimeouts(pendingTimeouts)
      await flushAsyncTicks()

      const writtenInput = transport.sendInput.mock.calls.map((call) => call[0])
      expect(pane.terminal.paste).not.toHaveBeenCalled()
      expect(writtenInput.at(-1)).toBe('\r')
      expect(writtenInput.slice(0, -1).join('')).toBe(command)
      expect(writtenInput.slice(0, -1).length).toBeGreaterThan(1)
      expect(transport.sendInput).not.toHaveBeenCalledWith(`${command}\r`)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('does not submit a terminal-paste startup command after the PTY changes mid-paste', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-id')
      let livePtyId = 'pty-local-paste'
      transport.getPtyId.mockImplementation(() => livePtyId)
      transport.sendInput.mockImplementation((data: string) => {
        if (data !== '\r') {
          livePtyId = 'pty-replaced'
        }
        return true
      })
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
      pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const command = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`
      const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@host $ ')
      await drainPendingTimeouts(pendingTimeouts)
      await flushAsyncTicks()

      expect(pane.terminal.paste).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalledWith('\r')
      expect(transport.sendInput.mock.calls.map((call) => call[0]).join('')).not.toBe(command)
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

  it('clears the mobile-fit pane binding when the pane connection is disposed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getFitOverrideForPane, setFitOverride } =
      await import('@/lib/pane-manager/mobile-fit-overrides')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)

    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    onPtySpawn?.('pty-fit')
    setFitOverride('pty-fit', 'mobile-fit', 49, 20)

    expect(getFitOverrideForPane(1, 'tab-1')).toEqual({ mode: 'mobile-fit', cols: 49, rows: 20 })
    expect(pane.container.dataset.ptyId).toBe('pty-fit')

    binding.dispose()

    expect(getFitOverrideForPane(1, 'tab-1')).toBeNull()
    expect(pane.container.dataset.ptyId).toBeUndefined()
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
      ;(onDataHandler as unknown as (data: string) => void)('x')
      vi.advanceTimersByTime(500)

      expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('drops xterm protocol replies from live TUI output while mobile presence lock is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    const ptyId = 'pty-mobile-tui-query'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        ptyIdsByTabId: { 'tab-1': [ptyId] }
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
      // Simulate xterm answering a TUI's DA1 query while the phone owns the PTY.
      ;(onDataHandler as unknown as (data: string) => void)('\x1b[?1;2c')
      await flushAsyncTicks()

      expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalled()
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('blocks remote locked terminal input before it reaches the runtime transport', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    const ptyId = 'remote:env-1@@terminal-1'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        ptyIdsByTabId: { 'tab-1': [ptyId] }
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
      ;(onDataHandler as unknown as (data: string) => void)('x')
      await flushAsyncTicks()

      expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalled()
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

  it('sends fast startup commands via sendInput for SSH connections', async () => {
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
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      // SSH connection: connectionId is set, relay receives command metadata
      // for spawn context but the renderer owns fast command delivery.
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

  it('waits for the SSH shell-ready marker before sending hinted startup commands', async () => {
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
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }]
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      expect(transport.sendInput).not.toHaveBeenCalled()

      capturedDataCallback.current?.('\x1b]777;orca-shell-ready\x07user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("codex 'linked issue context'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('falls back for SSH shell-ready startup commands when no marker arrives', async () => {
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
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }]
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      capturedDataCallback.current?.('fish prompt> ')

      expect(transport.sendInput).not.toHaveBeenCalled()
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("codex 'linked issue context'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('falls back for quiet SSH shell-ready startup commands with no output', async () => {
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
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }]
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()
      expect(transport.sendInput).not.toHaveBeenCalled()

      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("codex 'linked issue context'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('waits for shell-ready for SSH Codex native prefill commands without an explicit hint', async () => {
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
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }]
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: { command: "codex --prefill 'linked issue context'" }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      capturedDataCallback.current?.('user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      expect(transport.sendInput).not.toHaveBeenCalled()

      capturedDataCallback.current?.('\x1b]777;orca-shell-ready\x07user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("codex --prefill 'linked issue context'\r")
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

  it('clears pre-hook launch config when an Orca-started command exits', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-local-1'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        startup: {
          command: "codex '--dangerously-bypass-approvals-and-sandbox'",
          launchConfig: {
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          },
          launchAgent: 'codex'
        }
      }) as never
    )

    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(
      paneKey,
      {
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      expect.objectContaining({ agentType: 'codex' })
    )
    capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')

    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
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

  it('adopts a still-live background PTY via attach instead of reattaching when an eager buffer exists', async () => {
    // Why: background automation tabs spawn the agent PTY eagerly and register an
    // eager buffer, then never mount until opened. On first mount the restored
    // ptyId equals the tab ptyId, so without this guard the pane mis-routes into
    // the daemon-reattach branch (connect) and spawns a fresh shell, orphaning the
    // live agent PTY. A live eager buffer means "attach + replay", not "reattach".
    const eagerPtyId = 'auto-eager-pty'
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === eagerPtyId ? { flush: () => '', dispose: () => {} } : undefined
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: eagerPtyId }] },
      ptyIdsByTabId: { 'tab-1': [eagerPtyId] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: eagerPtyId }
        }
      }
    } as StoreState
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: eagerPtyId }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: eagerPtyId })
    )
    expect(transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: eagerPtyId })
    )
    const { hasPtySerializer } = await import('./pty-buffer-serializer')
    expect(hasPtySerializer(eagerPtyId)).toBe(true)
  })

  it('does not adopt another tab live eager PTY from a stale restored leaf binding', async () => {
    // Why: restored leaf bindings can outlive tab ownership. A global eager
    // buffer only proves the PTY is alive; ptyIdsByTabId proves this tab owns it.
    const otherTabPtyId = 'other-tab-eager-pty'
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === otherTabPtyId ? { flush: () => '', dispose: () => {} } : undefined
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        return { id: opts.sessionId }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [
          { id: 'tab-1', ptyId: 'tab-pty' },
          { id: 'tab-2', ptyId: otherTabPtyId }
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['tab-pty'],
        'tab-2': [otherTabPtyId]
      }
    } as StoreState
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: otherTabPtyId }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.attach).not.toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: otherTabPtyId })
    )
    expect(transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: otherTabPtyId })
    )
    expect(deps.updateTabPtyId).not.toHaveBeenCalledWith('tab-1', otherTabPtyId)
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

  it('submits a cold-restore resume command after SSH expired-session fallback', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_2)
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          if (opts.sessionId) {
            opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: restored-session')
            return undefined
          }
          capturedDataCallback.current = opts.callbacks?.onData ?? null
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
        sshConnectionStates: new Map([['conn-1', { status: 'connected' }]]),
        settings: {
          ...mockStoreState.settings,
          agentCmdOverrides: {}
        },
        sleepingAgentSessionsByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'codex-session-1' },
            prompt: 'finish the task',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      } as StoreState
      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      capturedDataCallback.current?.('user@remote $ ')
      for (const fn of pendingTimeouts) {
        fn()
      }

      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(transport.connect).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
          env: expect.objectContaining({
            ORCA_PANE_KEY: paneKey,
            ORCA_TAB_ID: 'tab-1',
            ORCA_WORKTREE_ID: 'wt-1',
            ORCA_WORKSPACE_ID: 'wt-1',
            ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
          })
        })
      )
      expect(transport.sendInput).toHaveBeenCalledWith(
        "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'\r"
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('clears the pending serializer when disposed before non-deferred SSH reattach expiry resolves', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<undefined>()
    const transport = createMockTransport()
    transport.connect.mockImplementation(
      (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (opts.sessionId) {
          opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: restored-session')
          return reattach.promise
        }
        return Promise.resolve('fresh-ssh-pty')
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

    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)
    binding.dispose()
    reattach.resolve(undefined)
    await flushAsyncTicks(10)

    expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_2),
      1
    )
    expect(transport.connect).toHaveBeenCalledTimes(1)
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

  it('resumes the provider agent session when daemon reattach cold-restores a fresh shell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          paneKey,
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'codex-session-1' }
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('cold-payload', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('--- session restored ---'),
      expect.any(Function)
    )
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
  })

  it('uses WSL quoting for cold-restored agent resume in Windows-path WSL projects', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: 'C:\\tmp\\wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {},
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      },
      projects: [
        {
          id: 'repo1',
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ],
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: 'C:\\tmp\\wt-1',
            displayName: 'feat/notis'
          }
        ]
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          paneKey,
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: "codex-session-1's" }
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('cold-payload', expect.any(Function))
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command:
          "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'\\''s'",
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
  })

  it('resumes from the quit-captured sleeping record when cold-restoring after an app restart', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    // Why: after an app restart agentStatusByPaneKey is empty — the persisted
    // sleeping record is the only source of the provider session id (#5232).
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('cold-payload', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('--- session restored ---'),
      expect.any(Function)
    )
    const writeCalls = pane.terminal.write.mock.calls.map(([data]) => data)
    expect(writeCalls.findIndex((data) => data.includes('--- session restored ---'))).toBe(-1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1)
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
    // Why: consuming the record prevents a later worktree activation from
    // launching a duplicate resume tab for the same session.
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
  })

  it('resumes from an unambiguous legacy sleeping record when cold-restoring a preserved pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const legacyPaneKey = 'tab-1:2'
    const duplicateLegacyPaneKey = 'tab-1:3'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [legacyPaneKey]: {
          paneKey: legacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        },
        [duplicateLegacyPaneKey]: {
          paneKey: duplicateLegacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 2,
          updatedAt: 2
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('cold-payload', expect.any(Function))
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1)
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'"
      })
    )
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(legacyPaneKey)
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(duplicateLegacyPaneKey)
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[legacyPaneKey]).toBeUndefined()
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[duplicateLegacyPaneKey]).toBeUndefined()
  })

  it('does not choose a non-exact legacy record when same-tab provider sessions differ', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const firstLegacyPaneKey = 'tab-1:2'
    const secondLegacyPaneKey = 'tab-1:3'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [firstLegacyPaneKey]: {
          paneKey: firstLegacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        },
        [secondLegacyPaneKey]: {
          paneKey: secondLegacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-2' },
          prompt: 'finish another task',
          state: 'working',
          capturedAt: 2,
          updatedAt: 2
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('cold-payload', expect.any(Function))
    expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('resume') })
    )
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('uses sleeping-record launch config for pane cold restore after settings change', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const launchConfig = {
      agentCommand: "codex '--model' 'gpt-5' '--reasoning-effort' 'high'",
      agentArgs: '--model gpt-5 --reasoning-effort high',
      agentEnv: {
        CODEX_PROFILE: 'captured',
        ORCA_PANE_KEY: 'wrong-pane',
        ORCA_TAB_ID: 'wrong-tab',
        ORCA_WORKTREE_ID: 'wrong-worktree',
        ORCA_WORKSPACE_ID: 'wrong-workspace'
      }
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--model changed' },
        agentDefaultEnv: { codex: { CODEX_PROFILE: 'changed' } }
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          launchConfig
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--model' 'gpt-5' '--reasoning-effort' 'high' 'resume' 'codex-session-1'",
        env: expect.objectContaining({
          CODEX_PROFILE: 'captured',
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(paneKey, launchConfig, {
      agentType: 'codex',
      launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)),
      tabId: 'tab-1',
      leafId: LEAF_1
    })
  })

  it('clears stale launch config when a pane consumes a non-agent startup command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ startup: { command: 'echo plain-command' } }) as never
    )
    await flushAsyncTicks()

    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)
  })

  it('prefers live-entry launch config for pane cold restore when status survived PTY loss', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const launchConfig = {
      agentCommand: "codex '--model' 'gpt-5-mini'",
      agentArgs: '--model gpt-5-mini',
      agentEnv: {}
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--model changed' }
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' }
        }
      },
      agentLaunchConfigByPaneKey: {
        [paneKey]: { launchConfig }
      },
      sleepingAgentSessionsByPaneKey: {}
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--model' 'gpt-5-mini' 'resume' 'codex-session-1'",
        env: expect.objectContaining({
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(paneKey, launchConfig, {
      agentType: 'codex',
      launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)),
      tabId: 'tab-1',
      leafId: LEAF_1
    })
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('ignores stale live launch config when cold restore identity lookup rejects it', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--model current' }
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' }
        }
      },
      agentLaunchConfigByPaneKey: {
        [paneKey]: {
          launchConfig: {
            agentCommand: "codex '--model' 'stale'",
            agentArgs: '--model stale',
            agentEnv: {}
          }
        }
      },
      getAgentLaunchConfigForStatusEntry: vi.fn(() => undefined),
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'older-codex-session' },
          prompt: 'older task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          launchConfig: {
            agentCommand: "codex '--model' 'sleeping-stale'",
            agentArgs: '--model sleeping-stale',
            agentEnv: { CODEX_PROFILE: 'sleeping-stale' }
          }
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(mockStoreState.getAgentLaunchConfigForStatusEntry).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey, agentType: 'codex' })
    )
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--model' 'current' 'resume' 'codex-session-1'"
      })
    )
    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(
      paneKey,
      expect.objectContaining({
        agentArgs: '--model current'
      }),
      expect.objectContaining({
        agentType: 'codex',
        tabId: 'tab-1',
        leafId: LEAF_1
      })
    )
  })

  it('shows the restored banner when a sleeping resume falls back to a fresh shell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const staleSessionId = 'wt-1@@stale-session'
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
    const paneKey = makePaneKey('tab-1', LEAF_2)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: staleSessionId }]
      },
      ptyIdsByTabId: {
        'tab-1': [staleSessionId]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_2]: staleSessionId }
        }
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: staleSessionId }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(10)

    expect(transport.connect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: staleSessionId })
    )
    expect(transport.connect).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', staleSessionId)
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('--- session restored ---'),
      expect.any(Function)
    )
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2)
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
  })

  it('keeps sleeping resume record when fresh cold-restore spawn fails', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const staleSessionId = 'wt-1@@stale-session'
    const transport = createMockTransport()
    transport.connect.mockResolvedValue(undefined)
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_2)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: staleSessionId }]
      },
      ptyIdsByTabId: {
        'tab-1': [staleSessionId]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_2]: staleSessionId }
        }
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    connectPanePty(
      createPane(2) as never,
      createManager(2) as never,
      createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: staleSessionId }
      }) as never
    )
    await flushAsyncTicks(20)

    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('does not write the restored banner through xterm bytes for sidebar-resumed startup commands', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-1')
    transportFactoryQueue.push(transport)
    const pane = createPane(1)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        startup: {
          command: "codex 'resume' 'codex-session-1'",
          showSessionRestoredBanner: true
        }
      }) as never
    )
    await flushAsyncTicks(10)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    onPtySpawn?.('pty-1')
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('--- session restored ---'),
      expect.any(Function)
    )
    expect(createdTransportOptions[0]?.command).toBe("codex 'resume' 'codex-session-1'")
  })

  it('does not consume the sleeping record when daemon reattach returns a live snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: 'live-snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
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
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('does not resume the provider session when daemon reattach returns a live snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: 'live-snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          paneKey,
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'codex-session-1' }
        }
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
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('live-snapshot', expect.any(Function))
    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('keeps non-visible local PTY bytes on the live xterm path for release', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

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

  it('keeps visually rich hidden PTY bytes on the live xterm path', async () => {
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
    const deps = createDeps({
      isVisibleRef: { current: false }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    try {
      const hiddenTuiChunk = '\x1b[2J\x1b[H╭ table 😀 ╮\r\n'
      capturedDataCallback.current?.(hiddenTuiChunk)

      expect(pane.terminal.write).not.toHaveBeenCalledWith(hiddenTuiChunk)
      vi.advanceTimersByTime(50)
      expect(pane.terminal.write).toHaveBeenCalledWith(hiddenTuiChunk)
      expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps split hidden synchronized output frames on the live xterm path', async () => {
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
    const deps = createDeps({
      isVisibleRef: { current: false }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    try {
      const startChunk = '\x1b[?2026h'
      const plainRowChunk = '| Sam Syntax | Compiler | Online |\r\n'
      const endChunk = 'LONG_TABLE_SCROLL_RESTORE_marker\r\n\x1b[?2026l'

      capturedDataCallback.current?.(startChunk)
      capturedDataCallback.current?.(plainRowChunk)
      capturedDataCallback.current?.(endChunk)

      expect(pane.terminal.write).not.toHaveBeenCalledWith(plainRowChunk)
      vi.advanceTimersByTime(50)
      expect(pane.terminal.write).toHaveBeenCalledWith(`${startChunk}${plainRowChunk}${endChunk}`)
      expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
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

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
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

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
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

  it('side-channel answers mode 2031 when hidden Codex output is snapshot-backed', async () => {
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
    const paneMode2031Ref = { current: new Map<number, boolean>() }
    const paneLastThemeModeRef = { current: new Map<number, 'dark' | 'light'>() }
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        paneMode2031Ref,
        paneLastThemeModeRef,
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('\x1b[?2031h')
      vi.advanceTimersByTime(50)

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[?997;2n')
      expect(paneMode2031Ref.current.get(1)).toBe(true)
      expect(paneLastThemeModeRef.current.get(1)).toBe('light')
      expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b[?2031h')
    } finally {
      vi.useRealTimers()
    }

    binding.dispose()
  })

  it('answers hidden Codex mode 2031 subscribes split across becoming visible', async () => {
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

    const isVisibleRef = { current: false }
    const paneMode2031Ref = { current: new Map<number, boolean>() }
    const paneLastThemeModeRef = { current: new Map<number, 'dark' | 'light'>() }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        paneMode2031Ref,
        paneLastThemeModeRef,
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[?20')
    isVisibleRef.current = true
    capturedDataCallback.current?.('31h')

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b[?997;2n')
    expect(paneMode2031Ref.current.get(1)).toBe(true)
    expect(paneLastThemeModeRef.current.get(1)).toBe('light')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('31h', expect.any(Function))

    binding.dispose()
  })

  it('does not keep mode 2031 subscribed when a skipped hidden chunk unsubscribes last', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const paneMode2031Ref = { current: new Map<number, boolean>() }
    const paneLastThemeModeRef = { current: new Map<number, 'dark' | 'light'>() }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        paneMode2031Ref,
        paneLastThemeModeRef,
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[?2031h\x1b[?2031l')

    expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
    expect(paneMode2031Ref.current.has(1)).toBe(false)
    expect(paneLastThemeModeRef.current.has(1)).toBe(false)

    binding.dispose()
  })

  it('keeps hidden Codex redraw floods off the live xterm path', async () => {
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
      const hiddenCodexRedraw = `\x1b[?2026h\x1b[2J\x1b[H${'codex redraw '.repeat(8_000)}`
      capturedDataCallback.current?.(hiddenCodexRedraw)
      vi.advanceTimersByTime(50)

      expect(pane.terminal.write).not.toHaveBeenCalledWith(hiddenCodexRedraw)
      expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }

    binding.dispose()
  })

  it('keeps hidden Codex terminal query chunks on the live xterm path', async () => {
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

    capturedDataCallback.current?.('\x1b[c')

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))

    binding.dispose()
  })

  it('keeps only coalesced hidden Codex terminal queries on the live xterm path', async () => {
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

    const coalescedChunk = `\x1b[c\x1b[?2026h\x1b[2J\x1b[H${'codex redraw '.repeat(8_000)}`
    capturedDataCallback.current?.(coalescedChunk)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(coalescedChunk, expect.any(Function))

    binding.dispose()
  })

  it('keeps a Yazi-style hidden capability-query burst on the live xterm path', async () => {
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

    const queryBurst = '\x1b[c\x1b]11;?\x1b\\\x1b[>q\x1b[14t\x1b[16t'
    const coalescedChunk = `${queryBurst}\x1b[?2026h${'codex redraw '.repeat(8_000)}`
    capturedDataCallback.current?.(coalescedChunk)

    expect(pane.terminal.write).toHaveBeenCalledWith(queryBurst, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(coalescedChunk, expect.any(Function))

    binding.dispose()
  })

  it('keeps split hidden Codex terminal queries on the live xterm path', async () => {
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

    capturedDataCallback.current?.('\x1b[')
    capturedDataCallback.current?.(`c\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `c\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden Codex terminal queries split after ESC on the live xterm path', async () => {
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

    capturedDataCallback.current?.('\x1b')
    capturedDataCallback.current?.(`[c\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `[c\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('flushes pending hidden Codex query prefixes when the pane becomes visible', async () => {
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
      isVisibleRef.current = true
      capturedDataCallback.current?.('[c')

      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('keeps split hidden-to-visible Codex stateful queries behind snapshot restore', async () => {
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
      data: 'snapshot-before-cpr\r\n',
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

      capturedDataCallback.current?.('\x1b[6')
      isVisibleRef.current = true
      capturedDataCallback.current?.('n')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        'snapshot-before-cpr\r\n',
        expect.any(Function)
      )
      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[6n', expect.any(Function))
    } finally {
      binding.dispose()
    }
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

  it('keeps split hidden Codex OSC color queries on the live xterm path', async () => {
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

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `\x1b\\\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden Codex OSC color queries split before the prefix on the live xterm path', async () => {
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

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
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

  it('writes ordinary hidden output live instead of proactively restoring a snapshot', async () => {
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
    const hidden = 'small-hidden-output\r\n'
    const live = 'visible-after-hidden\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: `snapshot-with-${hidden}`,
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
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden, expect.any(Function))

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(hidden)
    expect(pane.terminal.write).toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('writes ordinary hidden remote runtime output live instead of restoring a snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.serializeBuffer = vi.fn().mockResolvedValue({
      data: 'remote snapshot\r\n',
      cols: 120,
      rows: 40,
      seq: 40,
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
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    const hidden = 'hidden remote output\r\n'
    const live = 'visible remote output\r\n'
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden, expect.any(Function))

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: 40 + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(transport.serializeBuffer).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(hidden)
    expect(pane.terminal.write).toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('keeps inactive split-pane hidden output live instead of deferring snapshot restore', async () => {
    const { resetHiddenOutputRestoreSchedulerForTests } =
      await import('./hidden-output-restore-scheduler')
    let disposable: { dispose: () => void } | null = null
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'inactive snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })

      const pane = createPane(1)
      const manager = createManager(2)
      manager.getActivePane.mockReturnValue({ id: 2 })
      const deps = createDeps({ isVisibleRef: { current: false } })
      disposable = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      const hidden = 'hidden inactive output\r\n'
      const live = 'visible inactive output\r\n'
      expect(capturedDataCallback.current).not.toBeNull()
      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      await flushAsyncTicks(4)

      expect(getMainBufferSnapshot).not.toHaveBeenCalled()

      // Why: inactive split restore is frame-spaced, so this waits past one
      // scheduler tick without depending on fake timers for xterm callbacks.
      await new Promise((resolve) => setTimeout(resolve, 30))
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
      expect(pane.terminal.write).toHaveBeenCalledWith(hidden)
      expect(pane.terminal.write).toHaveBeenCalledWith(live, expect.any(Function))
    } finally {
      disposable?.dispose()
      resetHiddenOutputRestoreSchedulerForTests()
    }
  })

  it('drops a deferred inactive hidden restore when the pane is hidden again', async () => {
    const { resetHiddenOutputRestoreSchedulerForTests } =
      await import('./hidden-output-restore-scheduler')
    let disposable: { dispose: () => void } | null = null
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'inactive snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })

      const pane = createPane(1)
      const manager = createManager(2)
      manager.getActivePane.mockReturnValue({ id: 2 })
      const deps = createDeps({ isVisibleRef: { current: false } })
      disposable = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      const hidden = 'hidden inactive output\r\n'
      const live = 'visible inactive output\r\n'
      expect(capturedDataCallback.current).not.toBeNull()
      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      ;(deps.isVisibleRef as { current: boolean }).current = false
      await new Promise((resolve) => setTimeout(resolve, 30))
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        'inactive snapshot\r\n',
        expect.any(Function)
      )
    } finally {
      disposable?.dispose()
      resetHiddenOutputRestoreSchedulerForTests()
    }
  })

  it('does not retry remote snapshots for ordinary hidden runtime output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.serializeBuffer = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      data: 'remote recovered snapshot\r\n',
      cols: 120,
      rows: 40,
      seq: 80,
      source: 'headless'
    })
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'remote:env-1@@terminal-1'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ isVisibleRef: { current: false } })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    const hidden = 'hidden remote output\r\n'
    const firstLive = 'first visible output\r\n'
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(firstLive, {
      seq: hidden.length + firstLive.length,
      rawLength: firstLive.length
    })
    await flushAsyncTicks(20)

    expect(transport.serializeBuffer).not.toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('Orca skipped hidden terminal output'),
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'remote recovered snapshot\r\n',
      expect.any(Function)
    )

    await new Promise((resolve) => setTimeout(resolve, 80))
    await flushAsyncTicks(20)

    expect(transport.serializeBuffer).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(firstLive, expect.any(Function))
    disposable.dispose()
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

  it('writes only the live chunk suffix not covered by the restored main snapshot', async () => {
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
    const livePrefix = 'covered-by-snapshot:'
    const liveSuffix = 'still-new\r\n'
    const live = livePrefix + liveSuffix
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-through-live-prefix\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length + livePrefix.length
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

    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-through-live-prefix\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(liveSuffix, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
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

  it('refreshes visible rows after replaying a hidden TUI snapshot', async () => {
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
    const live = '\x1b[?2026h\x1b[2J\x1b[H╭────╮\r\n│ ok │\r\n╰────╯\x1b[?2026l'
    getMainBufferSnapshot.mockResolvedValue({
      data: live,
      cols: 120,
      rows: 40,
      seq: hidden.length + live.length
    })

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

    // Why: hidden restore replays bypass live foreground output; force a paint
    // after xterm parses the snapshot so stale WebGL cells cannot survive.
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
    expect(deps.replayingPanesRef.current.size).toBe(0)
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
    await flushAsyncTicks(2)

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

  it('does not switch renderers for Arabic output', async () => {
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

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'Arabic: السلام عليكم\r\n',
      expect.any(Function)
    )
  })

  it('does not switch renderers when background SGR is split across PTY chunks', async () => {
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

    capturedDataCallback.current?.('\x1b[48')
    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()

    capturedDataCallback.current?.(';2;52;52;52m codex block \x1b[0m\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
  })

  it('does not switch renderers across split background SGR PTY chunks', async () => {
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

    capturedDataCallback.current?.('\x1b[4')
    capturedDataCallback.current?.('8;2;52')
    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()

    capturedDataCallback.current?.(';52;52m codex block \x1b[0m\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
  })

  it('forces a viewport refresh for foreground Codex-style background redraws', async () => {
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

    capturedDataCallback.current?.('\x1b[2J\x1b[H\x1b[48;2;52;52;52m codex block text \x1b[0m\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
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

  it('keeps terminal UI drawing glyphs on the active renderer', async () => {
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

  it('cold-spawns slept remote runtime PTYs instead of reattaching the preserved handle', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment('env-1')
    const restoredPtyId = 'remote:env-1@@terminal-1'
    const freshPtyId = 'remote:env-1@@terminal-2'
    const transport = createMockTransport(freshPtyId)
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(
      async ({ callbacks, sessionId }: Record<string, unknown>) => {
        capturedDataCallback.current = (callbacks as ConnectCallbacks | undefined)?.onData ?? null
        if (sessionId) {
          throw new Error('slept remote runtime PTYs must not reattach by sessionId')
        }
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        onPtySpawn?.(freshPtyId)
        return freshPtyId
      }
    )
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId }]
      },
      ptyIdsByTabId: {
        'tab-1': []
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-1',
        agentCmdOverrides: {}
      },
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: restoredPtyId }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    capturedDataCallback.current?.('shell ready\r\n')
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.attach).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
        launchAgent: 'codex',
        launchConfig: {
          agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
          agentArgs: '--dangerously-bypass-approvals-and-sandbox',
          agentEnv: {}
        },
        launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)),
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
    expect(transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, null)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', restoredPtyId)
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, freshPtyId)
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', freshPtyId)
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
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

  it('spawns fresh PTYs through the worktree owner runtime when focus differs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport('remote:owner-runtime@@terminal-1')
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: null }]
      },
      repos: [
        {
          id: 'repo1',
          connectionId: null,
          displayName: 'orca',
          executionHostId: 'runtime:owner-runtime'
        }
      ],
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'focused-runtime'
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith(
      'owner-runtime',
      expect.any(Object)
    )
    expect(transport.connect).toHaveBeenCalled()
  })

  it('spawns fresh PTYs locally for explicitly local worktrees while a runtime is focused', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport('pty-local-1')
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: null }]
      },
      repos: [
        {
          id: 'repo1',
          connectionId: null,
          displayName: 'orca',
          executionHostId: 'local'
        }
      ],
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'focused-runtime'
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalled()
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
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
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
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        suppressOsNotification: true
      })
    )
  })

  it('raises terminal attention for agent completion when OS completion notifications are disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: true,
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

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected idle handler to be registered')
    }

    idleHandler('* Codex done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey: makePaneKey('tab-1', LEAF_1),
        suppressOsNotification: true
      })
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

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

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
    enableActiveRuntimeEnvironment()

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
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey: makePaneKey('tab-1', LEAF_1)
      })
    )
  })

  it('resolves synthetic terminal titles for remote hook status updates', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-devin')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: '\u280b Devin' } }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'devin' }) => void)
      | undefined
    if (!statusHandler) {
      throw new Error('Expected onAgentStatus to be registered')
    }

    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'devin'
    })

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'done',
        prompt: 'finish the implementation',
        agentType: 'devin'
      },
      'Devin ready'
    )
  })

  it('leaves local IPC OSC 9999 status ownership in the main runtime', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-local')
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createdTransportOptions[0]?.onAgentStatus).toBeUndefined()
  })

  it('leaves SSH IPC OSC 9999 status ownership in the main runtime', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-ssh')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createdTransportOptions[0]?.onAgentStatus).toBeUndefined()
  })

  it('lets delayed hook completion notifications win over concurrent terminal bells', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!statusHandler || !bellHandler) {
      throw new Error('Expected hook status and bell handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Done.'
    })
    bellHandler()

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    vi.advanceTimersByTime(
      AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey: makePaneKey('tab-1', LEAF_1),
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          prompt: 'finish the implementation',
          agentType: 'codex',
          lastAssistantMessage: 'Done.'
        })
      })
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
  })

  it('restores a suppressed terminal bell when a delayed hook completion resumes work', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!statusHandler || !bellHandler) {
      throw new Error('Expected hook status and bell handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Done.'
    })
    bellHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('restores a suppressed terminal bell when a delayed hook completion resumes via title tracking', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    if (!statusHandler || !bellHandler || !workingHandler) {
      throw new Error('Expected hook status, bell, and working handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Milestone complete.'
    })
    bellHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    workingHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
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

  it('cancels a title task-complete notification when the agent resumes before quiet', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    if (!idleHandler || !workingHandler) {
      throw new Error('Expected idle and working handlers to be registered')
    }

    idleHandler('* Codex done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 1)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )

    workingHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )

    idleHandler('* Codex done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: '* Codex done',
      paneKey: makePaneKey('tab-1', LEAF_1)
    })
  })

  // Why: show-until-interact — a DOM keydown is the keyboard "user is here"
  // signal that dismisses attention. Raw xterm onData is intentionally lower
  // level because it can include terminal-generated replies/control bytes.
  it('clears tab and worktree unread on real keydown', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    pane.terminal.element = createPaneContainer()
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const keydown = new Event('keydown')
    Object.defineProperty(keydown, 'key', { value: 'a' })
    Object.defineProperty(keydown, 'repeat', { value: false })
    Object.defineProperty(keydown, 'ctrlKey', { value: false })
    Object.defineProperty(keydown, 'metaKey', { value: false })
    Object.defineProperty(keydown, 'shiftKey', { value: false })
    ;(pane.terminal.element as EventTarget).dispatchEvent(keydown)

    expect(deps.clearTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.clearTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.clearWorktreeUnread).toHaveBeenCalledWith('wt-1')
    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('clears tab, pane, and worktree unread on plain Escape keydown', async () => {
    // Why: plain Escape produces real terminal input (\x1b) and so is a genuine
    // "user is here" signal. The interrupt-intent early return must not skip the
    // unread clears, or the attention dot would linger after the user presses Escape.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    pane.terminal.element = createPaneContainer()
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const keydown = new Event('keydown')
    Object.defineProperty(keydown, 'key', { value: 'Escape' })
    Object.defineProperty(keydown, 'repeat', { value: false })
    Object.defineProperty(keydown, 'ctrlKey', { value: false })
    Object.defineProperty(keydown, 'metaKey', { value: false })
    Object.defineProperty(keydown, 'altKey', { value: false })
    Object.defineProperty(keydown, 'shiftKey', { value: false })
    ;(pane.terminal.element as EventTarget).dispatchEvent(keydown)

    expect(deps.clearTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.clearTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.clearWorktreeUnread).toHaveBeenCalledWith('wt-1')
  })

  it('does not clear pane attention from raw onData after a bell', async () => {
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

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler || !onDataHandler) {
      throw new Error('expected bell and onData handlers to be registered')
    }

    bellHandler()
    ;(onDataHandler as (data: string) => void)('a')

    expect(deps.markTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.clearTerminalPaneUnread).not.toHaveBeenCalled()
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

  it('clears the pending serializer when disposed before deferred SSH expiry resolves', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<undefined>()
    const transport = createMockTransport()
    transport.connect.mockImplementation(
      (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (opts.sessionId) {
          opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: expired-session')
          return reattach.promise
        }
        return Promise.resolve('fresh-ssh-pty')
      }
    )
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

    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(10)
    binding.dispose()
    reattach.resolve(undefined)
    await flushAsyncTicks(10)

    expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      1
    )
    expect(transport.connect).toHaveBeenCalledTimes(1)
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

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
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

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
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
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 350)
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
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
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
