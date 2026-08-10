import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAgentStartupDelayedDeliveryForTests } from '@/lib/agent-startup-delayed-delivery'

// Deterministic reproduction for issue2-hidden-output-skip:
//   "[Orca skipped hidden terminal output because main recovery was unavailable.]"
//   printed into a live remote-runtime agent pane.
//
// Topology modeled (renderer contract level, per reproduce-orca-remote-server-issues):
//   remote-runtime-owned PTY ("remote:" id) -> transport.serializeBuffer is the ONLY
//   recovery for hidden-time output (canUseMainBufferSnapshot is structurally false;
//   the host DROPS paused/hidden stream output, so the reveal snapshot is the sole
//   carrier of hidden bytes). The fault is injected directly below the restore
//   pipeline at transport.serializeBuffer — the first seam that distinguishes
//   "host recovery is available but transiently null/slow" (flood-truncated
//   SnapshotResponse, resync window, Tailscale RTT) from true unavailability.
//
// Two mechanism tests pin the exact transition (they asserted the defect on main
// and now assert its fixed form); the invariant tests (RED on main) assert the
// contract: a host snapshot that is one retry tick away must not be declared
// "unavailable", hidden output must be recovered, and the added tolerance stays
// bounded — a host that never answers still banners once and stops requesting.
//
// Repro command:
//   pnpm exec vitest run --config config/vitest.config.ts \
//     src/renderer/src/components/terminal-pane/remote-hidden-output-restore-unavailable-banner.repro.test.ts

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
}

const scheduleRuntimeGraphSync = vi.fn()
const shouldSeedCacheTimerOnInitialTitle = vi.fn(() => false)
const scheduleTerminalWebglAtlasRecovery = vi.fn()
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

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
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
  writtenChunks: () => string[]
}

async function connectHiddenRemoteAgentPane(
  serializeBuffer: ReturnType<typeof vi.fn>
): Promise<RemotePaneDrive> {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport(REMOTE_PTY_ID)
  transport.serializeBuffer = serializeBuffer
  const capturedDataCallback: {
    current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
  } = { current: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    capturedDataCallback.current = callbacks?.onData ?? null
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
async function allowSelfHealWindow(): Promise<void> {
  for (let step = 0; step < 10; step += 1) {
    await vi.advanceTimersByTimeAsync(500)
    await flushAsyncTicks(20)
  }
}

function observeFinalPaneState(drive: RemotePaneDrive): {
  localMainSnapshotCalls: number
  rawHiddenBacklogWritten: boolean
  liveAgentChunkWritten: boolean
  unavailableBannerWritten: boolean
  hiddenOutputRecoveredFromHostSnapshot: boolean
} {
  const written = drive.writtenChunks()
  const joined = written.join('')
  return {
    localMainSnapshotCalls: vi.mocked(window.api.pty.getMainBufferSnapshot).mock.calls.length,
    rawHiddenBacklogWritten: joined.includes('x'.repeat(1024)),
    liveAgentChunkWritten: joined.includes('LIVE_AGENT_CHUNK'),
    unavailableBannerWritten: joined.includes(BANNER_FRAGMENT),
    hiddenOutputRecoveredFromHostSnapshot: joined.includes(HOST_SNAPSHOT_MARKER)
  }
}

describe('remote hidden-output restore abandonment (issue2-hidden-output-skip)', () => {
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

  // ── Mechanism (GREEN on main): pins the defective transition exactly ──────

  it('[mechanism] 4 transient-null host snapshots end the retry budget: live drains immediately, no banner, and the restore re-arms until the host answers', async () => {
    const serializeBuffer = vi.fn(async () =>
      serializeBuffer.mock.calls.length <= 4 ? null : HOST_SNAPSHOT
    )
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    // Reveal triggered exactly one remote snapshot request against the owning runtime.
    expect(serializeBuffer).toHaveBeenCalledTimes(1)
    expect(serializeBuffer).toHaveBeenNthCalledWith(1, { scrollbackRows: 5000 })

    await advanceThroughNullRetryBudget(drive)

    const written = drive.writtenChunks()
    // 1 initial + 3 deferred retries (50ms each), then abandonment unblocks live
    // output — but for a remote pane it must stay quiet, not claim loss.
    expect(serializeBuffer).toHaveBeenCalledTimes(4)
    expect(serializeBuffer).toHaveBeenNthCalledWith(4, { scrollbackRows: 5000 })
    expect(written.some((data) => data.includes('LIVE_AGENT_CHUNK'))).toBe(true)
    expect(written.some((data) => data.includes(BANNER_FRAGMENT))).toBe(false)
    // Remote pane never consulted local main recovery — the banner's "main
    // recovery" claim is structurally impossible for this PTY.
    expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    expect((drive.transport.getPtyId as unknown as () => string | null)()).toBe(REMOTE_PTY_ID)

    // Abandonment re-arms: the host answers the next request and the hidden
    // bytes are repainted from its authoritative buffer.
    await allowSelfHealWindow()
    expect(serializeBuffer.mock.calls.length).toBeGreaterThan(4)
    const joined = drive.writtenChunks().join('')
    expect(joined).toContain(HOST_SNAPSHOT_MARKER)
    expect(joined).not.toContain('x'.repeat(1024))
    drive.disposable.dispose()
  })

  it('[mechanism] slow-but-valid host snapshot: the 750ms foreground deadline unblocks live output quietly and refetches the discarded snapshot', async () => {
    const slowSnapshot = createDeferred<HostSnapshot>()
    const serializeBuffer = vi.fn().mockReturnValue(slowSnapshot.promise)
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    expect(serializeBuffer).toHaveBeenCalledTimes(1)
    expect(drive.pane.terminal.write).not.toHaveBeenCalledWith(
      LIVE_AGENT_CHUNK,
      expect.any(Function)
    )

    // Negative control: one tick before the deadline no banner exists.
    vi.advanceTimersByTime(749)
    await flushAsyncTicks(6)
    expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)

    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)

    const written = drive.writtenChunks()
    expect(written.some((data) => data.includes('LIVE_AGENT_CHUNK'))).toBe(true)
    expect(written.some((data) => data.includes(BANNER_FRAGMENT))).toBe(false)

    // The host's serialization completes just after the deadline; the stale
    // generation guard discards that snapshot, so the re-arm must refetch it.
    slowSnapshot.resolve(HOST_SNAPSHOT)
    await flushAsyncTicks(20)
    expect(serializeBuffer).toHaveBeenCalledTimes(1)
    expect(drive.writtenChunks().join('')).not.toContain(HOST_SNAPSHOT_MARKER)

    await allowSelfHealWindow()
    expect(serializeBuffer.mock.calls.length).toBeGreaterThan(1)
    expect(drive.writtenChunks().join('')).toContain(HOST_SNAPSHOT_MARKER)
    expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    drive.disposable.dispose()
  })

  // ── Invariants (RED on main): the contract a fix must satisfy ─────────────

  it('[invariant] must not declare recovery unavailable when the host snapshot is one retry tick away', async () => {
    const serializeBuffer = vi.fn(async () =>
      serializeBuffer.mock.calls.length <= 4 ? null : HOST_SNAPSHOT
    )
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)
    await advanceThroughNullRetryBudget(drive)
    await allowSelfHealWindow()

    expect(observeFinalPaneState(drive)).toEqual({
      localMainSnapshotCalls: 0,
      rawHiddenBacklogWritten: false,
      liveAgentChunkWritten: true,
      unavailableBannerWritten: false,
      hiddenOutputRecoveredFromHostSnapshot: true
    })
    drive.disposable.dispose()
  })

  it('[invariant] must not turn a merely-slow host snapshot into a loss banner and a permanent scrollback gap', async () => {
    const slowSnapshot = createDeferred<HostSnapshot>()
    const serializeBuffer = vi.fn(async () => HOST_SNAPSHOT)
    serializeBuffer.mockReturnValueOnce(slowSnapshot.promise)
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)

    // Deadline elapses while the host is still serializing its buffer.
    vi.advanceTimersByTime(750)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)
    // Host serialization finishes with the authoritative hidden bytes; every
    // later snapshot request would succeed instantly.
    slowSnapshot.resolve(HOST_SNAPSHOT)
    await flushAsyncTicks(20)
    await allowSelfHealWindow()

    expect(observeFinalPaneState(drive)).toEqual({
      localMainSnapshotCalls: 0,
      rawHiddenBacklogWritten: false,
      liveAgentChunkWritten: true,
      unavailableBannerWritten: false,
      hiddenOutputRecoveredFromHostSnapshot: true
    })
    drive.disposable.dispose()
  })

  // Bounds the tolerance: patience must not become an unbounded snapshot poll,
  // and a host that truly never answers still owes the user a loss signal.
  it('[invariant] a permanently silent host banners once after a bounded number of re-arms and then stops requesting', async () => {
    const serializeBuffer = vi.fn(async () => null)
    const drive = await connectHiddenRemoteAgentPane(serializeBuffer)
    vi.useFakeTimers()
    driveHiddenBacklogThenReveal(drive)
    await flushAsyncTicks(20)
    await advanceThroughNullRetryBudget(drive)

    // Live output is never held hostage by the re-arm budget, and the first
    // abandonment stays quiet.
    expect(drive.writtenChunks().join('')).toContain('LIVE_AGENT_CHUNK')
    expect(drive.writtenChunks().join('')).not.toContain(BANNER_FRAGMENT)

    // ~30s: far past the 5 re-arm cycles (~2.15s each).
    for (let step = 0; step < 6; step += 1) {
      await allowSelfHealWindow()
    }
    const bannerCount = drive
      .writtenChunks()
      .filter((data) => data.includes(BANNER_FRAGMENT)).length
    expect(bannerCount).toBe(1)
    const settledRequests = serializeBuffer.mock.calls.length
    // Re-armed past the initial budget, but bounded — no permanent polling.
    expect(settledRequests).toBeGreaterThan(4)
    expect(settledRequests).toBeLessThan(40)

    for (let step = 0; step < 4; step += 1) {
      await allowSelfHealWindow()
    }
    expect(serializeBuffer.mock.calls.length).toBe(settledRequests)
    expect(drive.writtenChunks().filter((data) => data.includes(BANNER_FRAGMENT)).length).toBe(1)
    drive.disposable.dispose()
  })
})
