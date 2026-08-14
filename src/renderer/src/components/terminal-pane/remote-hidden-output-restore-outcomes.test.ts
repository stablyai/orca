import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAgentStartupDelayedDeliveryForTests } from '@/lib/agent-startup-delayed-delivery'

async function flushAsyncTicks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

async function drainFakeTimerWork(limit = 20): Promise<void> {
  await flushAsyncTicks(20)
  if (!vi.isFakeTimers()) {
    return
  }
  for (let iteration = 0; iteration < limit && vi.getTimerCount() > 0; iteration += 1) {
    await vi.runOnlyPendingTimersAsync()
    await flushAsyncTicks(20)
  }
  vi.clearAllTimers()
  await flushAsyncTicks(20)
  vi.clearAllTimers()
}

const LEAF_1 = '11111111-1111-4111-8111-111111111111' as const
const LEAF_2 = '22222222-2222-4222-8222-222222222222' as const

function leafIdForPane(paneId: number): string {
  return paneId === 2 ? LEAF_2 : LEAF_1
}

type ConnectCallbacks = {
  onReattachDetermined?: () => void
  onConnect?: () => void
  onStreamRecovered?: () => void
  onData?: (
    data: string,
    meta?: { seq?: number; rawLength?: number; background?: boolean; droppedOutput?: boolean }
  ) => void
  onReplayData?: (data: string, meta?: { clearBeforeReplay?: boolean }) => void
  onError?: (msg: string) => void
  onWriteUnavailable?: () => void
  onOutputPauseChanged?: (paused: boolean, supported: boolean) => void
}

type MockTransport = {
  attach: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn> & {
    mockImplementation: (
      impl: (opts: { callbacks?: ConnectCallbacks } & Record<string, unknown>) => Promise<unknown>
    ) => unknown
  }
  disconnect: ReturnType<typeof vi.fn>
  sendInput: ReturnType<typeof vi.fn>
  sendInputImmediate?: ReturnType<typeof vi.fn>
  sendInputAccepted?: ReturnType<typeof vi.fn>
  claimViewport: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  getPtyId: ReturnType<typeof vi.fn>
  getConnectionId: ReturnType<typeof vi.fn>
  serializeBuffer?: ReturnType<typeof vi.fn>
  serializeBufferOutcome?: ReturnType<typeof vi.fn>
}

const scheduleRuntimeGraphSync = vi.fn()
const shouldSeedCacheTimerOnInitialTitle = vi.fn(() => false)
const toastInfo = vi.fn()
const notifyCodexPaneBoundForStaleSweep = vi.fn()

let mockStoreState: Record<string, unknown>
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: Record<string, unknown>) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: Record<string, unknown>) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const isGeminiTerminalTitle = actual.isGeminiTerminalTitle as (title: string) => boolean
  return {
    ...actual,
    isGeminiTerminalTitle: vi.fn((title: string) => isGeminiTerminalTitle(title)),
    isClaudeAgent: vi.fn(() => false),
    detectAgentStatusFromTitle: vi.fn(() => null)
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

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

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
    disconnect: vi.fn(() => {
      ptyId = null
    }),
    sendInput: vi.fn(() => true),
    claimViewport: vi.fn(() => true),
    resize: vi.fn(() => true),
    getPtyId: vi.fn(() => ptyId),
    getConnectionId: vi.fn(() => null),
    serializeBuffer: undefined
  } as MockTransport
  const sendInput = transport.sendInput as unknown as (data: string) => boolean
  transport.sendInputImmediate = vi.fn((data: string) => sendInput(data))
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
    cursorY: 0,
    cursorX: 0
  }
  const terminal = {
    cols: 120,
    rows: 40,
    element: {},
    buffer: {
      active: activeBuffer
    },
    modes: {
      bracketedPasteMode: false,
      sendFocusMode: false
    },
    options: {
      scrollback: 5_000,
      ignoreBracketedPasteMode: false,
      theme: {
        foreground: '#eeeeee',
        background: '#111111'
      }
    },
    write: vi.fn<(data: string, callback?: () => void) => void>(function write(...args): void {
      const [data, callback] = args
      if (data === '' || callback?.name === 'runParsedSteps') {
        callback?.()
      }
    }),
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
    onRender: vi.fn((_listener: () => void) => ({ dispose: vi.fn() })),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    hasSelection: vi.fn(() => false),
    parser: {
      registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() }))
    }
  }
  return {
    id: paneId,
    leafId,
    stablePaneId: leafId,
    terminal,
    container: createPaneContainer(),
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: terminal.cols, rows: terminal.rows }))
    }
  }
}

function createManager(paneCount = 1, initialActivePaneId: number | null = null) {
  let activePaneId = initialActivePaneId
  const panes = Array.from({ length: paneCount }, (_, index) => ({
    id: index + 1,
    leafId: leafIdForPane(index + 1)
  }))
  return {
    setPaneGpuRendering: vi.fn(),
    markPaneHasComplexScriptOutput: vi.fn(),
    rebuildPaneWebgl: vi.fn(),
    hasWebglRenderer: vi.fn(() => false),
    getPanes: vi.fn(() => panes),
    closePane: vi.fn(),
    getActivePane: vi.fn<() => { id: number; leafId?: string } | null>(() =>
      activePaneId === null
        ? null
        : (panes.find((candidate) => candidate.id === activePaneId) ?? null)
    ),
    getNumericIdForLeaf: vi.fn((leafId: string) => {
      return panes.find((candidate) => candidate.leafId === leafId)?.id ?? null
    }),
    setActivePane: vi.fn((paneId: number) => {
      activePaneId = paneId
    })
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
    paneKittyKeyboardModesRef: { current: new Map() },
    paneLastThemeModeRef: { current: new Map() },
    replayingPanesRef: { current: new Map() },
    isActiveRef: { current: true },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    onAgentExitedRef: { current: vi.fn() },
    onPtyErrorRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(() => false),
    isPtyShutdownPending: vi.fn(() => false),
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: vi.fn((tabId: string, ptyId: string, replacedPtyId?: string) => {
      const byTab = (mockStoreState.ptyIdsByTabId ?? {}) as Record<string, string[]>
      const current = byTab[tabId] ?? []
      const next =
        replacedPtyId && current.includes(replacedPtyId)
          ? current.map((candidate) => (candidate === replacedPtyId ? ptyId : candidate))
          : current.includes(ptyId)
            ? current
            : [...current, ptyId]
      mockStoreState.ptyIdsByTabId = { ...byTab, [tabId]: next }
    }),
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
    clearExitedPanePtyLayoutBinding: vi.fn(),
    ...overrides
  }
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolveDeferred!: (value: T) => void
  let rejectDeferred!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise, resolve: resolveDeferred, reject: rejectDeferred }
}

// ── Scenario identities ─────────────────────────────────────────────────────
const REMOTE_PTY_ID = 'remote:env-1@@terminal-agent-1'
// Overflows the renderer's hidden background queue (2MB lossy cap), dropping the
// backlog and latching model restore — mirrors the real remote pause semantics
// where hidden-time bytes exist ONLY in the host's authoritative buffer.
const HIDDEN_BYTES = 'x'.repeat(2 * 1024 * 1024 + 1)
const LIVE_AGENT_CHUNK = 'LIVE_AGENT_CHUNK\r\n'
const HOST_SNAPSHOT_MARKER = 'HOST_SNAPSHOT_HIDDEN_AGENT_CONTENT'
const HOST_SNAPSHOT = {
  data: `${HOST_SNAPSHOT_MARKER}\r\n`,
  cols: 120,
  rows: 40,
  seq: HIDDEN_BYTES.length + LIVE_AGENT_CHUNK.length,
  source: 'headless'
}
const BANNER_FRAGMENT = 'main recovery was unavailable'

type HostSnapshot = typeof HOST_SNAPSHOT

type RemotePaneDrive = {
  transport: MockTransport
  pane: ReturnType<typeof createPane>
  deps: ReturnType<typeof createDeps>
  disposable: { dispose: () => void }
  deliver: (data: string, seq: number) => void
  setOutputPaused: (paused: boolean) => void
  recoverStream: () => void
  writtenChunks: () => string[]
}

async function connectHiddenRemoteAgentPane(
  serializeBuffer: ReturnType<typeof vi.fn>,
  serializeBufferOutcome?: ReturnType<typeof vi.fn>
): Promise<RemotePaneDrive> {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport(REMOTE_PTY_ID)
  transport.serializeBuffer = serializeBuffer
  transport.serializeBufferOutcome = serializeBufferOutcome
  const capturedDataCallback: {
    current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
  } = { current: null }
  const capturedOutputPauseCallback: {
    current: ((paused: boolean, supported: boolean) => void) | null
  } = { current: null }
  const capturedStreamRecoveredCallback: { current: (() => void) | null } = { current: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    capturedDataCallback.current = callbacks?.onData ?? null
    capturedOutputPauseCallback.current = callbacks?.onOutputPauseChanged ?? null
    capturedStreamRecoveredCallback.current = callbacks?.onStreamRecovered ?? null
    return REMOTE_PTY_ID
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const manager = createManager(1)
  const deps = createDeps({ isVisibleRef: { current: false } })
  const disposable = connectPanePty(pane as never, manager as never, deps as never)
  await flushAsyncTicks(6)
  expect(capturedDataCallback.current).not.toBeNull()
  return {
    transport,
    pane,
    deps,
    disposable,
    deliver: (data, seq) => capturedDataCallback.current?.(data, { seq, rawLength: data.length }),
    setOutputPaused: (paused) => capturedOutputPauseCallback.current?.(paused, true),
    recoverStream: () => capturedStreamRecoveredCallback.current?.(),
    writtenChunks: () => pane.terminal.write.mock.calls.map(([data]) => String(data))
  }
}

// Delivers the hidden backlog, reveals the pane, and delivers one live agent
// chunk — the exact user flow in the screenshot (agent streaming on reveal).
function driveHiddenBacklogThenReveal(drive: RemotePaneDrive): void {
  drive.deliver(HIDDEN_BYTES, HIDDEN_BYTES.length)
  ;(drive.deps.isVisibleRef as { current: boolean }).current = true
  drive.deliver(LIVE_AGENT_CHUNK, HIDDEN_BYTES.length + LIVE_AGENT_CHUNK.length)
}

async function advanceThroughNullRetryBudget(drive: RemotePaneDrive): Promise<void> {
  for (let retry = 0; retry < 3; retry++) {
    // Live output stays gated behind the in-flight restore during the window.
    expect(drive.pane.terminal.write).not.toHaveBeenCalledWith(
      LIVE_AGENT_CHUNK,
      expect.any(Function)
    )
    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)
  }
}

// Generous self-heal window: lets any corrected pipeline (extended retries,
// restore re-arm, post-abandon repaint) run to completion under fake timers.
async function advanceModernRetryProbe(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_000)
  await flushAsyncTicks(20)
}

describe('remote hidden-output restore outcomes', () => {
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
      deleteStateByWorktreeId: {},
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', displayName: 'feat/notis' }]
      },
      runtimeStatusByEnvironmentId: new Map(),
      repos: [{ id: 'repo1', connectionId: null, displayName: 'orca' }],
      projects: [],
      sshConnectionStates: new Map(),
      transientClearedAgentStatusConnectionIds: {},
      cacheTimerByKey: {},
      settings: {
        promptCacheTimerEnabled: true,
        experimentalTerminalAttention: true,
        terminalMainSideEffectAuthority: false
      },
      codexRestartNoticeByPtyId: {},
      deferredSshReconnectTargets: [],
      deferredSshSessionIdsByTabId: {},
      removeDeferredSshReconnectTarget: vi.fn(),
      removeDeferredSshSessionId: vi.fn(),
      consumePendingColdRestore: vi.fn(() => null),
      consumePendingSnapshot: vi.fn(() => null),
      runtimePaneTitlesByTabId: {},
      agentStatusByPaneKey: {} as Record<string, unknown>,
      retainedAgentsByPaneKey: {},
      paneForegroundAgentByPaneKey: {} as Record<string, unknown>,
      sleepingAgentSessionsByPaneKey: {} as Record<string, unknown>,
      suppressedPtyExitIds: {},
      agentLaunchConfigByPaneKey: {} as Record<string, { launchConfig: unknown }>,
      getAgentLaunchConfigForStatusEntry: vi.fn((entry: { paneKey: string }) => {
        const byPaneKey = mockStoreState.agentLaunchConfigByPaneKey as Record<
          string,
          { launchConfig: unknown } | undefined
        >
        return byPaneKey[entry.paneKey]?.launchConfig
      }),
      getAgentLaunchConfigForStatusMetadata: vi.fn(() => undefined),
      clearSleepingAgentSession: vi.fn((paneKey: string) => {
        delete (mockStoreState.sleepingAgentSessionsByPaneKey as Record<string, unknown>)[paneKey]
      }),
      registerAgentLaunchConfig: vi.fn(),
      clearAgentLaunchConfig: vi.fn(),
      markWorktreeUnread: vi.fn(),
      observeTerminalGitHubPullRequestLink: vi.fn(),
      recordTerminalInput: vi.fn(),
      setAgentStatus: vi.fn(),
      removeAgentStatus: vi.fn(),
      dropAgentStatus: vi.fn(),
      retireAgentPaneAuthority: vi.fn(),
      setPaneForegroundAgent: vi.fn((paneKey: string, entry: unknown) => {
        ;(mockStoreState.paneForegroundAgentByPaneKey as Record<string, unknown>)[paneKey] = entry
      }),
      clearPaneForegroundAgent: vi.fn((paneKey: string) => {
        delete (mockStoreState.paneForegroundAgentByPaneKey as Record<string, unknown>)[paneKey]
      }),
      markTerminalTabUnread: vi.fn(),
      markTerminalPaneUnread: vi.fn(),
      markAgentCompletionPaneUnread: vi.fn()
    }
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        ssh: {
          connect: vi.fn().mockResolvedValue({ status: 'connected' }),
          needsPassphrasePrompt: vi.fn().mockResolvedValue(false)
        },
        pty: {
          kill: vi.fn(),
          signal: vi.fn(),
          listSessions: vi.fn().mockResolvedValue([]),
          hasPty: vi.fn().mockResolvedValue(true),
          getSize: vi.fn().mockResolvedValue(null),
          reportGeometry: vi.fn(),
          getMainBufferSnapshot: vi.fn().mockResolvedValue(null),
          getForegroundProcess: vi.fn().mockResolvedValue(null),
          inspectProcess: vi.fn().mockResolvedValue({
            foregroundProcess: null,
            hasChildProcesses: false
          }),
          confirmForegroundProcess: vi.fn().mockResolvedValue(null),
          hasChildProcesses: vi.fn().mockResolvedValue(false),
          write: vi.fn(),
          writeAccepted: vi.fn().mockResolvedValue(true),
          setHiddenRendererPty: vi.fn(),
          setPtyDeliveryInterest: vi.fn(),
          ackColdRestore: vi.fn(),
          onClearBufferRequest: vi.fn(() => vi.fn()),
          onSerializeBufferRequest: vi.fn(() => vi.fn()),
          sendSerializedBuffer: vi.fn(),
          declarePendingPaneSerializer: vi.fn().mockResolvedValue(1),
          settlePaneSerializer: vi.fn().mockResolvedValue(undefined),
          clearPendingPaneSerializer: vi.fn().mockResolvedValue(undefined),
          reportRendererSerializerReady: vi.fn().mockResolvedValue(undefined)
        },
        platform: {
          get: vi.fn(() => ({ platform: 'darwin', osRelease: '25.0.0' }))
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
      },
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    globalThis.cancelAnimationFrame = vi.fn()
  })

  afterEach(async () => {
    await drainFakeTimerWork()
    vi.useRealTimers()
    vi.restoreAllMocks()
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
    resetAgentStartupDelayedDeliveryForTests()
  })

  it('[modern] repaints a recovered visible pane from the retained host buffer', async () => {
    const serializeBuffer = vi.fn()
    const serializeBufferOutcome = vi.fn().mockResolvedValue({
      availability: { kind: 'snapshot' },
      snapshot: HOST_SNAPSHOT
    })
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer, serializeBufferOutcome)
    ;(drive.deps.isVisibleRef as { current: boolean }).current = true

    drive.recoverStream()
    await flushAsyncTicks(20)

    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    expect(drive.writtenChunks().join('')).toContain(HOST_SNAPSHOT_MARKER)
    expect(serializeBuffer).not.toHaveBeenCalled()
    drive.disposable.dispose()
  })

  it('[modern] accepts an empty snapshot as successful recovery without a loss banner', async () => {
    const serializeBuffer = vi.fn()
    const serializeBufferOutcome = vi.fn().mockResolvedValue({
      availability: { kind: 'snapshot' },
      snapshot: { ...HOST_SNAPSHOT, data: '' }
    })
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer, serializeBufferOutcome)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    expect(serializeBuffer).not.toHaveBeenCalled()
    expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    drive.disposable.dispose()
  })

  it('[modern] waits for a reported outcome instead of applying the old elapsed-time deadline', async () => {
    const pendingOutcome = createDeferred<{
      availability: { kind: 'snapshot' }
      snapshot: HostSnapshot
    }>()
    const serializeBuffer = vi.fn()
    const serializeBufferOutcome = vi.fn().mockReturnValue(pendingOutcome.promise)
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer, serializeBufferOutcome)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)

    pendingOutcome.resolve({ availability: { kind: 'snapshot' }, snapshot: HOST_SNAPSHOT })
    await flushAsyncTicks(20)
    expect(drive.writtenChunks().join('')).toContain(HOST_SNAPSHOT_MARKER)
    expect(serializeBuffer).not.toHaveBeenCalled()
    drive.disposable.dispose()
  })

  it('[modern] banners on the seventh retry-worthy host answer and never sends an eighth request', async () => {
    const serializeBuffer = vi.fn()
    const serializeBufferOutcome = vi.fn().mockResolvedValue({
      availability: { kind: 'retry-worthy', cause: 'host-pending-output-overflowed' },
      snapshot: null
    })
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer, serializeBufferOutcome)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    for (let expectedRequests = 2; expectedRequests <= 7; expectedRequests += 1) {
      await advanceModernRetryProbe()
      expect(serializeBufferOutcome).toHaveBeenCalledTimes(expectedRequests)
      expect(drive.writtenChunks().join('').includes(BANNER_FRAGMENT)).toBe(expectedRequests === 7)
    }
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(7)
    expect(drive.writtenChunks().filter((data) => data.includes(BANNER_FRAGMENT))).toHaveLength(1)
    expect(serializeBuffer).not.toHaveBeenCalled()
    drive.disposable.dispose()
  })

  // Regression: these causes are returned before any frame leaves the client, so the host
  // declined nothing. Charging them to its budget banners a healthy pane at ~12s — the very
  // elapsed-time guess this change removes.
  it('[modern] does not spend the host answer budget on locally-gated retries', async () => {
    const serializeBuffer = vi.fn()
    const serializeBufferOutcome = vi.fn().mockResolvedValue({
      availability: { kind: 'retry-worthy', cause: 'resync-in-flight' },
      snapshot: null
    })
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer, serializeBufferOutcome)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    // Well past the 7-answer host budget: a stuck local gate must not be mistaken for host refusals.
    for (let expectedRequests = 2; expectedRequests <= 12; expectedRequests += 1) {
      await advanceModernRetryProbe()
      expect(serializeBufferOutcome).toHaveBeenCalledTimes(expectedRequests)
      expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
    }

    // The gate clears: the pane recovers the hidden bytes it would otherwise have declared lost.
    serializeBufferOutcome.mockResolvedValue({
      availability: { kind: 'snapshot' },
      snapshot: HOST_SNAPSHOT
    })
    await advanceModernRetryProbe()
    expect(drive.writtenChunks().join('')).toContain(HOST_SNAPSHOT_MARKER)
    expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
    expect(serializeBuffer).not.toHaveBeenCalled()
    drive.disposable.dispose()
  })

  it('[modern] still bounds locally-gated retries at their own cap', async () => {
    const serializeBuffer = vi.fn()
    const serializeBufferOutcome = vi.fn().mockResolvedValue({
      availability: { kind: 'retry-worthy', cause: 'connection-not-ready' },
      snapshot: null
    })
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer, serializeBufferOutcome)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    for (let expectedRequests = 2; expectedRequests <= 30; expectedRequests += 1) {
      await advanceModernRetryProbe()
      expect(serializeBufferOutcome).toHaveBeenCalledTimes(expectedRequests)
      expect(drive.writtenChunks().join('').includes(BANNER_FRAGMENT)).toBe(expectedRequests === 30)
    }
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(30)
    expect(drive.writtenChunks().filter((data) => data.includes(BANNER_FRAGMENT))).toHaveLength(1)
    drive.disposable.dispose()
  })

  it('[modern] banners immediately on permanent unavailability without retrying', async () => {
    const serializeBuffer = vi.fn()
    const serializeBufferOutcome = vi.fn().mockResolvedValue({
      availability: {
        kind: 'permanently-unavailable',
        reason: 'exceeds-client-replay-limit'
      },
      snapshot: null
    })
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer, serializeBufferOutcome)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    await vi.advanceTimersByTimeAsync(0)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    expect(drive.writtenChunks().filter((data) => data.includes(BANNER_FRAGMENT))).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    expect(serializeBuffer).not.toHaveBeenCalled()
    drive.disposable.dispose()
  })

  it('[modern] cancels a live flood repaint when it declares the output unrecoverable', async () => {
    const serializeBuffer = vi.fn()
    const serializeBufferOutcome = vi
      .fn()
      .mockResolvedValueOnce({
        availability: { kind: 'retry-worthy', cause: 'host-no-serializable-buffer' },
        snapshot: null
      })
      .mockResolvedValue({
        availability: { kind: 'permanently-unavailable', reason: 'exceeds-client-replay-limit' },
        snapshot: null
      })
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer, serializeBufferOutcome)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)

    // The retry answer arms a post-flood repaint 2s out; interrupt it partway with an
    // ungated re-arm (remote output unpause) whose answer is permanently unavailable.
    await vi.advanceTimersByTimeAsync(1_000)
    drive.setOutputPaused(true)
    drive.setOutputPaused(false)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(2)
    expect(drive.writtenChunks().filter((data) => data.includes(BANNER_FRAGMENT))).toHaveLength(1)

    // The still-armed repaint must not resurrect recovery the pane already declared dead.
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncTicks(20)
    expect(drive.writtenChunks().filter((data) => data.includes(BANNER_FRAGMENT))).toHaveLength(1)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(2)
    drive.disposable.dispose()
  })

  it('[legacy] switches an explicit unknown-host answer to the existing four-request heuristic', async () => {
    const serializeBuffer = vi.fn().mockResolvedValue(null)
    const serializeBufferOutcome = vi.fn().mockResolvedValue({
      availability: { kind: 'unknown-legacy-host' },
      snapshot: null
    })
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer, serializeBufferOutcome)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    await advanceThroughNullRetryBudget(drive)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    expect(serializeBuffer).toHaveBeenCalledTimes(3)
    expect(drive.writtenChunks().join('')).toContain(LIVE_AGENT_CHUNK)
    expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)
    drive.disposable.dispose()
  })

  it('[modern] parks retry repaint while scrolled back and resumes when following output', async () => {
    const { markTerminalFollowOutput, markTerminalPinnedViewport } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const serializeBuffer = vi.fn()
    const serializeBufferOutcome = vi.fn().mockResolvedValue({
      availability: { kind: 'retry-worthy', cause: 'request-already-in-flight' },
      snapshot: null
    })
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer, serializeBufferOutcome)
    drive.pane.terminal.buffer.active.baseY = 100
    drive.pane.terminal.buffer.active.viewportY = 42
    markTerminalPinnedViewport(drive.pane.terminal)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(1)
    expect(drive.pane.terminal.buffer.active.viewportY).toBe(42)

    drive.pane.terminal.buffer.active.viewportY = drive.pane.terminal.buffer.active.baseY
    markTerminalFollowOutput(drive.pane.terminal)
    await flushAsyncTicks(20)
    expect(serializeBufferOutcome).toHaveBeenCalledTimes(2)
    drive.disposable.dispose()
  })
})
