/**
 * Carries a host-rejected paired-runtime write the whole way: the real
 * terminal.multiplex dispatcher rejects the authoritative PTY write, the real
 * renderer multiplexer and remote transport decode the WriteUnavailable frame,
 * and pty-connection must turn it into an actual tab remount.
 *
 * Every other test for this signal stops at a transport callback, so the last
 * hop was unproven — and that hop is where it died: pane recovery probes
 * `pty:hasPty`, which owns no registry entry for a `remote:` id. The parametrized
 * liveness answers below cover every reply main can produce for one.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { TERMINAL_METHODS } from '../../src/main/runtime/rpc/methods/terminal'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame
} from '../../src/shared/terminal-stream-protocol'

const ENVIRONMENT_ID = 'env-1'
const TERMINAL_HANDLE = 'terminal-1'
const REMOTE_PTY_ID = `remote:${ENVIRONMENT_ID}@@${TERMINAL_HANDLE}`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

type StoreState = Record<string, unknown>

let mockStoreState: StoreState
let storeSubscribers: ((state: StoreState) => void)[] = []
const remountTerminalTabForRecovery = vi.fn<(tabId: string) => boolean>(() => true)

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

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('@/runtime/web-runtime-session', () => ({
  refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => {})
}))

/** One live paired host: the real dispatcher, wired to a runtime that refuses the write. */
function startHost(): {
  bridge: {
    subscribe: (
      args: { method: string },
      callbacks: {
        onResponse: (response: unknown) => void
        onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
        onClose?: () => void
      }
    ) => Promise<{ unsubscribe: () => void; sendBinary: (bytes: Uint8Array) => void }>
    call: (request: { method: string; params?: unknown }) => Promise<unknown>
  }
  sendTerminal: ReturnType<typeof vi.fn>
  /** Opcodes the host pushed to this client, in order. */
  hostOpcodes: number[]
} {
  const hostOpcodes: number[] = []
  // The host's whole reason to emit the opcode: the PTY refused the bytes.
  const sendTerminal = vi.fn().mockResolvedValue({ accepted: false })
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    requestRendererTerminalTabMount: vi.fn().mockReturnValue(true),
    updateRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewers: vi.fn().mockResolvedValue(true),
    isPtyResizeDrivenRemotely: vi.fn().mockReturnValue(false),
    getRemoteDesktopFitHold: vi.fn().mockReturnValue({ mode: 'desktop-fit', cols: 120, rows: 40 }),
    isRemoteDesktopViewerOwner: vi.fn().mockReturnValue(false),
    getPtyOutputSequence: vi.fn().mockReturnValue(0),
    attachRemoteTerminalSourceRangeConsumer: vi.fn().mockReturnValue(false),
    detachRemoteTerminalSourceRangeConsumer: vi.fn(),
    getRendererTerminalSerializerGeneration: vi.fn().mockReturnValue(0),
    sendTerminal,
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
    serializeAuthoritativeTerminalBuffer: vi
      .fn()
      .mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    waitForTerminal: vi.fn(() => new Promise<never>(() => {}))
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

  const bridge = {
    async subscribe(
      args: { method: string },
      callbacks: {
        onResponse: (response: unknown) => void
        onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
        onClose?: () => void
      }
    ) {
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      void dispatcher.dispatchStreaming(
        { id: 'req-1', authToken: 'tok', method: args.method, params: {} },
        (message) => callbacks.onResponse(JSON.parse(message)),
        {
          connectionId: 'conn-e2e',
          sendBinary: (bytes) => {
            const opcode = decodeTerminalStreamFrame(bytes)?.opcode
            if (opcode !== undefined) {
              hostOpcodes.push(opcode)
            }
            callbacks.onBinary?.(bytes)
            return true
          },
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => {
              if (handlers.get(streamId) === handler) {
                handlers.delete(streamId)
              }
            }
          }
        }
      )
      return {
        unsubscribe: vi.fn(),
        sendBinary: (bytes: Uint8Array) => {
          const frame = decodeTerminalStreamFrame(bytes)
          if (frame) {
            handlers.get(frame.streamId)?.(frame)
          }
        }
      }
    },
    async call(request: { method: string; params?: unknown }) {
      if (request.method === 'terminal.resolvePane') {
        const params = request.params as { paneKey: string; worktreeId: string }
        const separator = params.paneKey.indexOf(':')
        return {
          ok: true,
          result: {
            terminal: {
              handle: TERMINAL_HANDLE,
              tabId: params.paneKey.slice(0, separator),
              leafId: params.paneKey.slice(separator + 1),
              worktreeId: params.worktreeId
            }
          }
        }
      }
      return { ok: true, result: { terminal: { handle: TERMINAL_HANDLE } } }
    }
  }
  return { bridge, sendTerminal, hostOpcodes }
}

function createPane() {
  const activeBuffer = { type: 'normal' as const, viewportY: 0, baseY: 0, cursorY: 0, cursorX: 0 }
  const container = new EventTarget() as HTMLElement
  Object.defineProperty(container, 'dataset', { configurable: true, value: {} })
  const terminal = {
    cols: 120,
    rows: 40,
    element: {},
    buffer: { active: activeBuffer },
    modes: { bracketedPasteMode: false, sendFocusMode: false },
    options: { scrollback: 5_000, ignoreBracketedPasteMode: false, theme: {} },
    write: vi.fn((data: string, callback?: () => void) => {
      if (data === '' || callback?.name === 'runParsedSteps') {
        callback?.()
      }
    }),
    resize: vi.fn(),
    clear: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
    scrollLines: vi.fn(),
    paste: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    onRender: vi.fn(() => ({ dispose: vi.fn() })),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    hasSelection: vi.fn(() => false),
    parser: {
      registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() }))
    }
  }
  return { id: 1, leafId: LEAF_ID, stablePaneId: LEAF_ID, terminal, container }
}

function createManager() {
  const panes = [{ id: 1, leafId: LEAF_ID }]
  return {
    setPaneGpuRendering: vi.fn(),
    markPaneHasComplexScriptOutput: vi.fn(),
    rebuildPaneWebgl: vi.fn(),
    hasWebglRenderer: vi.fn(() => false),
    getPanes: vi.fn(() => panes),
    closePane: vi.fn(),
    getActivePane: vi.fn(() => panes[0]),
    getNumericIdForLeaf: vi.fn(() => 1),
    setActivePane: vi.fn()
  }
}

function createDeps() {
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    cwd: '/tmp/wt-1',
    startup: null,
    restoredLeafId: LEAF_ID,
    restoredPtyIdByLeafId: { [LEAF_ID]: REMOTE_PTY_ID },
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
    clearExitedPanePtyLayoutBinding: vi.fn()
  }
}

/** Every answer main can give for a `remote:` id it owns no registry entry for. */
const LIVENESS_ANSWERS: [string, () => Promise<boolean | null>][] = [
  ['a fabricated dead answer from the local registry', async () => false],
  ['an explicit unknown', async () => null],
  [
    'a failed probe',
    async () => {
      throw new Error('ipc unavailable')
    }
  ]
]

describe('host-rejected paired-runtime input reaches a pane remount', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    storeSubscribers = []
    remountTerminalTabForRecovery.mockReturnValue(true)
    mockStoreState = {
      activeWorktreeId: 'wt-1',
      activeWorkspaceExecutionHostId: `runtime:${ENVIRONMENT_ID}`,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: REMOTE_PTY_ID }] },
      ptyIdsByTabId: { 'tab-1': [REMOTE_PTY_ID] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: REMOTE_PTY_ID }
        }
      },
      unreadTerminalTabs: {},
      deleteStateByWorktreeId: {},
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
      },
      runtimeStatusByEnvironmentId: new Map(),
      repos: [{ id: 'repo1', connectionId: null, displayName: 'orca' }],
      projects: [],
      sshConnectionStates: new Map(),
      transientClearedAgentStatusConnectionIds: {},
      cacheTimerByKey: {},
      settings: { terminalMainSideEffectAuthority: false },
      codexRestartNoticeByPtyId: {},
      deferredSshReconnectTargets: [],
      deferredSshSessionIdsByTabId: {},
      removeDeferredSshReconnectTarget: vi.fn(),
      removeDeferredSshSessionId: vi.fn(),
      consumePendingColdRestore: vi.fn(() => null),
      consumePendingSnapshot: vi.fn(() => null),
      runtimePaneTitlesByTabId: {},
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      suppressedPtyExitIds: {},
      agentLaunchConfigByPaneKey: {},
      getAgentLaunchConfigForStatusEntry: vi.fn(),
      getAgentLaunchConfigForStatusMetadata: vi.fn(),
      clearSleepingAgentSession: vi.fn(),
      registerAgentLaunchConfig: vi.fn(),
      clearAgentLaunchConfig: vi.fn(),
      markWorktreeUnread: vi.fn(),
      observeTerminalGitHubPullRequestLink: vi.fn(),
      recordTerminalInput: vi.fn(),
      setAgentStatus: vi.fn(),
      removeAgentStatus: vi.fn(),
      dropAgentStatus: vi.fn(),
      retireAgentPaneAuthority: vi.fn(),
      setPaneForegroundAgent: vi.fn(),
      clearPaneForegroundAgent: vi.fn(),
      markTerminalTabUnread: vi.fn(),
      markTerminalPaneUnread: vi.fn(),
      markAgentCompletionPaneUnread: vi.fn(),
      remountTerminalTabForRecovery
    }
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    globalThis.cancelAnimationFrame = vi.fn()
  })

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  for (const [label, hasPty] of LIVENESS_ANSWERS) {
    it(`remounts the tab when the pane liveness probe returns ${label}`, async () => {
      const { bridge, sendTerminal, hostOpcodes } = startHost()
      ;(globalThis as unknown as { window: unknown }).window = {
        api: {
          runtimeEnvironments: { call: bridge.call, subscribe: bridge.subscribe },
          pty: {
            hasPty: vi.fn(hasPty),
            kill: vi.fn(),
            signal: vi.fn(),
            listSessions: vi.fn().mockResolvedValue([]),
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
          platform: { get: vi.fn(() => ({ platform: 'darwin', osRelease: '25.0.0' })) },
          notifications: {
            dispatch: vi.fn().mockResolvedValue({ delivered: true }),
            playSound: vi.fn().mockResolvedValue({ played: true })
          },
          runtime: { restoreTerminalFit: vi.fn().mockResolvedValue({ restored: true }) },
          agentStatus: { inferInterrupt: vi.fn().mockResolvedValue(false) },
          ssh: {
            connect: vi.fn().mockResolvedValue({ status: 'connected' }),
            needsPassphrasePrompt: vi.fn().mockResolvedValue(false)
          }
        },
        dispatchEvent: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }

      const { connectPanePty } = await import('@/components/terminal-pane/pty-connection')
      const { _resetTerminalPaneRecoveryForTests } =
        await import('@/components/terminal-pane/terminal-pane-recovery')
      _resetTerminalPaneRecoveryForTests()

      const pane = createPane()
      const deps = createDeps()
      const binding = connectPanePty(pane as never, createManager() as never, deps as never)
      await vi.waitFor(() => {
        expect(deps.paneTransportsRef.current.get(1)?.getPtyId()).toBe(REMOTE_PTY_ID)
      })

      // The user types; the host accepts the frame and the PTY refuses the bytes.
      sendTerminalInput(pane, 'ls\r')
      await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalled())
      // Hop 1: the host turned the refusal into the negotiated frame.
      await vi.waitFor(() => expect(hostOpcodes).toContain(TerminalStreamOpcode.WriteUnavailable))
      // Hop 2 (the one that was missing): it survives pane recovery as a remount.
      await vi.waitFor(() => expect(remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1'))

      binding.dispose()
      _resetTerminalPaneRecoveryForTests()
    })
  }
})

function sendTerminalInput(pane: ReturnType<typeof createPane>, data: string): void {
  const calls = pane.terminal.onData.mock.calls as unknown as [(data: string) => void][]
  const handler = calls[0]?.[0]
  expect(handler).toBeTypeOf('function')
  handler?.(data)
}
