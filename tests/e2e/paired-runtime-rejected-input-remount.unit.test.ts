// Carry real host PTY write refusal through dispatcher → WriteUnavailable → renderer transport → pty-connection remount.
// Main has no local registry for remote: ids; cover every liveness reply so that final recovery hop cannot drop refusal.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { TERMINAL_METHODS } from '../../src/main/runtime/rpc/methods/terminal'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import type { PanePtyBinding } from '../../src/renderer/src/components/terminal-pane/pty-connection/pane-pty-binding'
import {
  createPane,
  createManager,
  takeTerminalTestPanes
} from '../../src/renderer/src/components/terminal-pane/pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-deps'
import { mockPanePtyArgs } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-connect-mock-pane'
import type { StoreState as ConnectionStoreState } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-store-state'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamJson,
  type TerminalStreamFrame
} from '../../src/shared/terminal-stream-protocol'

// Only older, unsequenced streams remount; sequenced input retains its journal and resends on the same stream.
function withoutInputAck(frame: TerminalStreamFrame): TerminalStreamFrame {
  if (frame.opcode !== TerminalStreamOpcode.Subscribe) {
    return frame
  }
  const payload = decodeTerminalStreamJson<{ capabilities?: Record<string, unknown> }>(
    frame.payload
  )
  if (!payload?.capabilities) {
    return frame
  }
  const { inputAck: _inputAck, ...capabilities } = payload.capabilities
  return { ...frame, payload: encodeTerminalStreamJson({ ...payload, capabilities }) }
}

const ENVIRONMENT_ID = 'env-1'
const TERMINAL_HANDLE = 'terminal-1'
const REMOTE_PTY_ID = `remote:${ENVIRONMENT_ID}@@${TERMINAL_HANDLE}`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

type StoreState = ConnectionStoreState & {
  activeWorkspaceExecutionHostId: string
  remountTerminalTabForRecovery: typeof remountTerminalTabForRecovery
}

let mockStoreState: StoreState
let storeSubscribers: ((state: StoreState) => void)[] = []
/** The store action reports admission now, not a bare boolean. */
const REMOUNTED = { remounted: true as const, generation: 1 }
const remountTerminalTabForRecovery = vi.fn<(tabId: string, request?: unknown) => typeof REMOUNTED>(
  () => REMOUNTED
)

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
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
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
  const sendTerminal = vi.fn().mockResolvedValue({ accepted: false })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial runtime supplies the terminal RPC methods these tests invoke.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getPtyExecutionHostMetadata: () => ({ incarnationId: 'test-incarnation' }),
    getTerminalLaunchResult: () => undefined,
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
            handlers.get(frame.streamId)?.(withoutInputAck(frame))
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

function createDeps() {
  return buildPaneConnectionDeps(() => mockStoreState, {
    restoredLeafId: LEAF_ID,
    restoredPtyIdByLeafId: { [LEAF_ID]: REMOTE_PTY_ID },
    updateTabPtyId: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    readTerminalPaneOnInput: vi.fn()
  })
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
    remountTerminalTabForRecovery.mockReturnValue(REMOUNTED)
    mockStoreState = {
      activeWorktreeId: 'wt-1',
      activeWorkspaceExecutionHostId: `runtime:${ENVIRONMENT_ID}`,
      unifiedTabsByWorktree: {},
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
      clearSleepingAgentSession: vi.fn(),
      registerAgentLaunchConfig: vi.fn(),
      clearAgentLaunchConfig: vi.fn(),
      observeTerminalGitHubPullRequestLink: vi.fn(),
      recordTerminalInput: vi.fn(),
      setAgentStatus: vi.fn(),
      removeAgentStatus: vi.fn(),
      dropAgentStatus: vi.fn(),
      retireAgentPaneAuthority: vi.fn(),
      restoreAgentPaneAuthority: vi.fn(),
      setPaneForegroundAgent: vi.fn(),
      clearPaneForegroundAgent: vi.fn(),
      markTerminalBell: vi.fn(),
      markAgentAttentionUnread: vi.fn(),
      remountTerminalTabForRecovery
    }
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    globalThis.cancelAnimationFrame = vi.fn()
  })

  afterEach(() => {
    takeTerminalTestPanes()
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

      const pane = createPane(1)
      pane.container.querySelector = () => null
      const manager = createManager(1, 1)
      manager.getPanes.mockReturnValue([pane])
      manager.getActivePane.mockReturnValue(pane)
      const deps = createDeps()
      const { registerRuntimeTerminalTab } = await import('@/runtime/mounted-terminal-tab-registry')
      const args = mockPanePtyArgs(pane, manager, deps)
      const unregister = registerRuntimeTerminalTab({
        tabId: deps.tabId,
        worktreeId: deps.worktreeId,
        getManager: () => args[1],
        getContainer: () => null,
        getPtyIdForPane: (id) => args[2].paneTransportsRef.current.get(id)?.getPtyId() ?? null,
        getTabWideAgentHintLeafId: () => null
      })
      let binding: PanePtyBinding | undefined
      try {
        binding = connectPanePty(...args)
        await vi.waitFor(() => {
          expect(args[2].paneTransportsRef.current.get(1)?.getPtyId()).toBe(REMOTE_PTY_ID)
        })

        sendTerminalInput(pane, 'ls\r')
        await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalled())
        await vi.waitFor(() => expect(hostOpcodes).toContain(TerminalStreamOpcode.WriteUnavailable))
        await vi.waitFor(() =>
          expect(remountTerminalTabForRecovery).toHaveBeenCalledWith(
            'tab-1',
            expect.objectContaining({ reason: 'input-rejected-by-host', trigger: 'automatic' })
          )
        )
      } finally {
        binding?.dispose()
        unregister()
        _resetTerminalPaneRecoveryForTests()
      }
    })
  }
})

function sendTerminalInput(pane: ReturnType<typeof createPane>, data: string): void {
  const calls = pane.terminal.onData.mock.calls as unknown as [(data: string) => void][]
  const handler = calls[0]?.[0]
  expect(handler).toBeTypeOf('function')
  handler?.(data)
}
