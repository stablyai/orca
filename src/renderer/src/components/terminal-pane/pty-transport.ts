import { attachIpcPty } from './ipc-pty-attach'
import { connectIpcPty } from './ipc-pty-connect'
import { createIpcPtySessionHandlers } from './ipc-pty-session-handlers'
import { createPtyInputWriteQueue } from './pty-input-write-queue'
import { waitAtTerminalPtyPreSpawnE2EBarrier } from './terminal-pty-pre-spawn-e2e-barrier'
import type { PtyDataMeta } from './pty-dispatcher'
import type {
  IpcPtyTransportOptions,
  PtyConnectAgentLaunchFailure,
  PtyConnectResult,
  PtyTransport
} from './pty-transport-types'
import { createBellDetector } from '../../../../shared/terminal-bell-detector'
import {
  hasTerminalDisplayContent,
  trimIncompleteTerminalControlTail
} from './terminal-output-visibility'
import {
  createAgentStatusOscProcessor,
  type ProcessedAgentStatusChunk
} from '../../../../shared/agent-status-osc'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import {
  registerPtySideEffectPendingGauge,
  type PtySideEffectGauge
} from './pty-side-effect-pending-census'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

export {
  ensurePtyDispatcher,
  getEagerPtyBufferHandle,
  registerEagerPtyBuffer,
  restorePtyDataHandlersAfterFailedShutdown,
  subscribeToPtyExit,
  unregisterPtyDataHandlers
} from './pty-dispatcher'
export type { EagerPtyHandle } from './pty-dispatcher'
export { extractLastOscTitle } from '../../../../shared/agent-detection'
export { createPtyOutputProcessor } from './pty-output-processor'
export {
  MAX_EVICTED_AGENT_STATUS_PAYLOAD_CARRY,
  MAX_PENDING_PTY_SIDE_EFFECTS
} from './pty-output-side-effect-queue'
export type {
  IpcPtyTransportOptions,
  LocalPtySessionMetadata,
  PtyBufferSnapshot,
  PtyConnectResult,
  PtyReplayDataMeta,
  PtyTransport
} from './pty-transport-types'

export function createIpcPtyTransport(opts: IpcPtyTransportOptions = {}): PtyTransport {
  const {
    cwd,
    cwdFallback,
    env,
    envToDelete,
    command,
    commandDelivery,
    launchConfig,
    resumeProviderSession,
    launchToken,
    launchAgent,
    agentLaunch,
    legacyResumeRecordedConnectionId,
    startupCommandDelivery,
    connectionId,
    shellOverride,
    onPtyExit,
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  } = opts
  let connected = false
  let destroyed = false
  let ptyId: string | null = null
  let lifecycleGeneration = 0
  let lastExitGeneration: number | null = null
  let suppressAttentionEvents = false
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}
  const preconnectInputBuffer =
    opts.bufferInputUntilConnect || opts.preconnectInput?.length
      ? createPtyPreconnectInputBuffer(opts.preconnectInput)
      : null

  const inputWriteQueue = createPtyInputWriteQueue({
    isWritable: (id) => !destroyed && connected && ptyId === id,
    write: (id, data) => window.api.pty.write(id, data),
    writeAccepted: (id, data) => window.api.pty.writeAccepted(id, data),
    onDrainFailure: (id) => {
      if (ptyId === id) {
        storedCallbacks.onWriteUnavailable?.()
      }
    }
  })
  const advancePtyLifecycle = (): number => {
    lifecycleGeneration += 1
    lastExitGeneration = null
    inputWriteQueue.clear()
    return lifecycleGeneration
  }
  const outputProcessor = createPtyOutputProcessor({
    onTitleChange,
    onBell,
    onAgentBecameIdle: (title) => {
      if (!suppressAttentionEvents) {
        onAgentBecameIdle?.(title)
      }
    },
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  })
  const handlers = createIpcPtySessionHandlers({
    outputProcessor,
    getPtyId: () => ptyId,
    getCallbacks: () => storedCallbacks,
    getSuppressAttentionEvents: () => suppressAttentionEvents,
    markExited: () => {
      advancePtyLifecycle()
      lastExitGeneration = lifecycleGeneration
      connected = false
      ptyId = null
      preconnectInputBuffer?.clear()
    },
    onPtyExit
  })
  const bind = (id: string): void => {
    ptyId = id
    connected = true
  }
  const setCallbacks = (callbacks: typeof storedCallbacks): void => {
    storedCallbacks = callbacks
  }
  const flushPreconnectInput = async (): Promise<void> => {
    if (!preconnectInputBuffer?.isBuffering()) {
      return
    }
    const id = ptyId
    if (destroyed || !connected || !id) {
      preconnectInputBuffer.clear()
      return
    }
    await preconnectInputBuffer.flush({
      isCurrent: () => !destroyed && connected && ptyId === id,
      sendInput: (data) => inputWriteQueue.enqueue(id, data),
      sendInputImmediate: (data) => inputWriteQueue.enqueueQueryReply(id, data),
      ...(connectionId
        ? {}
        : {
            sendInputAccepted: (data: string) => inputWriteQueue.enqueueAccepted(id, data)
          })
    })
  }

  return {
    connect: async (options) => {
      const connectGeneration = advancePtyLifecycle()
      try {
        const preSpawnBarrier = waitAtTerminalPtyPreSpawnE2EBarrier()
        if (preSpawnBarrier) {
          await preSpawnBarrier
          if (destroyed) {
            return
          }
        }
        if (options.shouldContinue && !options.shouldContinue()) {
          return
        }
        // Why: cwd fallback is only for fresh local spawns — reattach keeps the session's cwd and SSH transports resolve cwd on the remote host.
        const shouldSendLocalCwdFallback =
          cwdFallback === 'worktree' && !connectionId && !admittedSessionId
        const resolvedAgentLaunch = options.agentLaunch ?? agentLaunch
        // Why: `null` (a local legacy record) is a meaningful value distinct from
        // "not provided", so resolve the per-call override before the construction
        // default without collapsing null via `??`.
        const resolvedLegacyRecordedConnectionId =
          options.legacyResumeRecordedConnectionId !== undefined
            ? options.legacyResumeRecordedConnectionId
            : legacyResumeRecordedConnectionId
        // The agentLaunch overload may resolve to a pre-spawn typed failure with
        // no PTY; the conditional spread erases that at the type level, so widen
        // back to the union we narrow below.
        const result = (await window.api.pty.spawn({
          cols: options.cols ?? 80,
          rows: options.rows ?? 24,
          cwd,
          ...(shouldSendLocalCwdFallback ? { cwdFallback } : {}),
          env: options.env ?? env,
          // Why: on the host-resolved agentLaunch path the host owns command,
          // launchConfig, and token assembly and ignores these client fields, so
          // we send only the request; the legacy/resume path keeps sending the
          // resolved command and any stored config/token. Exception: a pre-U5
          // legacy record's captured config + recorded owner ride ALONGSIDE the
          // resume variant (one-release handoff) so the host can prove and ingest
          // them on first resume; it ignores them until its ingest lands.
          ...(resolvedAgentLaunch
            ? {
                agentLaunch: resolvedAgentLaunch,
                ...((options.launchConfig ?? launchConfig)
                  ? { launchConfig: options.launchConfig ?? launchConfig }
                  : {}),
                // Not redundant with the host's own record: on a pre-U5 FIRST
                // resume there is no record yet, and pty.ts reads
                // `args.resumeProviderSession?.transcriptPath` to build the
                // legacy handoff. Pi/Prime-Agent resume by transcript path, not
                // by id, so omitting this loses the session (BUG-7). Rides only
                // alongside launchConfig, which is what marks the handoff.
                ...((options.resumeProviderSession ?? resumeProviderSession)
                  ? {
                      resumeProviderSession: options.resumeProviderSession ?? resumeProviderSession
                    }
                  : {}),
                ...(resolvedLegacyRecordedConnectionId !== undefined
                  ? { legacyResumeRecordedConnectionId: resolvedLegacyRecordedConnectionId }
                  : {})
              }
            : {
                command: options.command ?? command,
                // Rides with `command`, never with agentLaunch: it names who runs
                // that command (relay/pty-handler.ts reads it), and on the
                // host-resolved path the host assembles and delivers its own.
                ...((options.commandDelivery ?? commandDelivery)
                  ? { commandDelivery: options.commandDelivery ?? commandDelivery }
                  : {}),
                ...((options.envToDelete ?? envToDelete)
                  ? { envToDelete: options.envToDelete ?? envToDelete }
                  : {}),
                ...((options.launchConfig ?? launchConfig)
                  ? { launchConfig: options.launchConfig ?? launchConfig }
                  : {}),
                ...((options.resumeProviderSession ?? resumeProviderSession)
                  ? {
                      resumeProviderSession: options.resumeProviderSession ?? resumeProviderSession
                    }
                  : {}),
                ...((options.launchToken ?? launchToken)
                  ? { launchToken: options.launchToken ?? launchToken }
                  : {}),
                ...((options.launchAgent ?? launchAgent)
                  ? { launchAgent: options.launchAgent ?? launchAgent }
                  : {}),
                ...((options.startupCommandDelivery ?? startupCommandDelivery)
                  ? {
                      startupCommandDelivery:
                        options.startupCommandDelivery ?? startupCommandDelivery
                    }
                  : {})
              }),
          ...(connectionId ? { connectionId } : {}),
          ...(admittedSessionId ? { sessionId: admittedSessionId } : {}),
          // Why: hidden-at-spawn mark must reach main before the PTY's first byte — ride the spawn IPC, not the visibility sync (terminal-query-authority.md).
          ...(options.initiallyHidden ? { initiallyHidden: true } : {}),
          worktreeId,
          ...(tabId ? { tabId } : {}),
          ...(leafId ? { leafId } : {}),
          ...(shellOverride ? { shellOverride } : {}),
          ...(projectRuntime ? { projectRuntime } : {}),
          ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
          ...(telemetry ? { telemetry } : {})
        })) as (PtyConnectResult & { isReattach?: boolean }) | PtyConnectAgentLaunchFailure
        // Pre-spawn agentLaunch failure/rejection: the host created no PTY, so
        // there is no id. Surface the outcome so the caller shows the localized
        // affordance and creates no pane.
        if (!('id' in result)) {
          connected = false
          ptyId = null
          return { agentLaunch: result.agentLaunch } satisfies PtyConnectAgentLaunchFailure
        }
        const spawnResult = result
        const resultLaunchAgent = isTuiAgent(spawnResult.launchAgent)
          ? spawnResult.launchAgent
          : undefined
        const retireFreshSpawn = async (): Promise<void> => {
          if (!spawnResult.isReattach && !spawnResult.coldRestore) {
            await window.api.pty.kill(spawnResult.id)
          }
        }
        const launchedOutcome =
          spawnResult.agentLaunch?.status === 'launched' ? spawnResult.agentLaunch : undefined

        // Why: on destroy mid-connect, kill only a fresh spawn — killing a reattached session (owned by the tab lifecycle) loses a live shell.
        if (destroyed) {
          await retireFreshSpawn()
          return
        }

        if (options.admitPtyId && !options.admitPtyId(spawnResult.id)) {
          // Why: a rejected session-expired fallback has no owner to retire its newly created process.
          await retireFreshSpawn()
          return spawnResult
        }

        if (spawnResult.isReattach && !admittedSessionId) {
          storedCallbacks.onReattachDetermined?.()
        }
        ptyId = spawnResult.id
        connected = true

        // Why: skip onPtySpawn for reattach/coldRestore — it would reset lastActivityAt and destroy the recency sort order.
        if (!spawnResult.isReattach && !spawnResult.coldRestore) {
          onPtySpawn?.(spawnResult.id)
        }

        registerPtyDataHandler(spawnResult.id)
        const exitedBeforeAttach = registerPtyExitHandler(spawnResult.id)
        if (exitedBeforeAttach) {
          return { id: spawnResult.id, exitedBeforeAttach: true } satisfies PtyConnectResult
        }
        if (!connected || ptyId !== spawnResult.id) {
          return undefined
        }

        storedCallbacks.onConnect?.()
        storedCallbacks.onStatus?.('shell')

        if (spawnResult.isReattach || spawnResult.coldRestore || spawnResult.sessionExpired) {
          return {
            id: spawnResult.id,
            // Why: recovery needs to distinguish an attach that ignored startup intent from a fresh spawn that ran it.
            ...(spawnResult.isReattach ? { isReattach: true } : {}),
            ...(resultLaunchAgent ? { launchAgent: resultLaunchAgent } : {}),
            ...(spawnResult.launchConfig ? { launchConfig: spawnResult.launchConfig } : {}),
            snapshot: spawnResult.snapshot,
            snapshotCols: spawnResult.snapshotCols,
            snapshotRows: spawnResult.snapshotRows,
            ...(spawnResult.snapshotPrefixAnsi !== undefined
              ? { snapshotPrefixAnsi: spawnResult.snapshotPrefixAnsi }
              : {}),
            ...(spawnResult.snapshotFrameAnsi !== undefined
              ? { snapshotFrameAnsi: spawnResult.snapshotFrameAnsi }
              : {}),
            ...(spawnResult.snapshotFrameRestoreAnsi !== undefined
              ? { snapshotFrameRestoreAnsi: spawnResult.snapshotFrameRestoreAnsi }
              : {}),
            isAlternateScreen: spawnResult.isAlternateScreen,
            sessionExpired: spawnResult.sessionExpired,
            coldRestore: spawnResult.coldRestore,
            replay: spawnResult.replay,
            pendingEscapeTailAnsi: spawnResult.pendingEscapeTailAnsi,
            // Why: the cold-restore path re-runs the launch command, so it needs the
            // same "main declined the resume" signal the fresh-spawn path gets.
            ...(spawnResult.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {})
          } satisfies PtyConnectResult
        }
        if (
          resultLaunchAgent ||
          spawnResult.launchConfig ||
          spawnResult.startupCwdFallback ||
          spawnResult.agentResumeUnavailable ||
          spawnResult.launchNotices ||
          launchedOutcome
        ) {
          return {
            id: spawnResult.id,
            ...(resultLaunchAgent ? { launchAgent: resultLaunchAgent } : {}),
            ...(spawnResult.launchConfig ? { launchConfig: spawnResult.launchConfig } : {}),
            ...(spawnResult.startupCwdFallback
              ? { startupCwdFallback: spawnResult.startupCwdFallback }
              : {}),
            ...(spawnResult.agentResumeUnavailable
              ? { agentResumeUnavailable: true as const }
              : {}),
            ...(spawnResult.launchNotices ? { launchNotices: spawnResult.launchNotices } : {}),
            ...(launchedOutcome ? { agentLaunch: launchedOutcome } : {}),
            // Why: forward the host-resolved followup/draft prompt so the
            // pty-connection paste writer can deliver it after readiness. Present
            // only when the host could not fold the prompt into the launch command.
            ...(spawnResult.followupPrompt ? { followupPrompt: spawnResult.followupPrompt } : {}),
            ...(spawnResult.draftPrompt ? { draftPrompt: spawnResult.draftPrompt } : {})
          } satisfies PtyConnectResult
        }
        return spawnResult.id
      } catch (err) {
        const msg = extractIpcErrorMessage(err, err instanceof Error ? err.message : String(err))
        if (
          connectionId &&
          options.sessionId &&
          (msg.includes(SSH_SESSION_EXPIRED_ERROR) ||
            msg.includes(SSH_PTY_CONNECTION_MISMATCH_MARKER))
        ) {
          return {
            id: options.sessionId,
            sessionExpired: true
          } satisfies PtyConnectResult
        }
        // Why: re-spawning a Kill-All'd session throws TerminalKilledError; swallow it (pane still shows "Process exited"), don't toast (src/main/daemon/daemon-pty-adapter.ts).
        if (msg.includes('was explicitly killed')) {
          return undefined
        }
        // Why: on cold start the SSH provider isn't registered yet, so pty:spawn throws a raw IPC error; replace with a friendly message.
        if (connectionId && msg.includes('No PTY provider for connection')) {
          // Why: a disappearing runtime-owned SSH target is expected teardown (e.g. workspace deleted); don't surface a reconnect toast.
          if (!isRuntimeOwnedSshTargetId(connectionId)) {
            storedCallbacks.onError?.(
              'SSH connection is not active. Use the reconnect dialog or Settings to connect.'
            )
          }
        } else {
          storedCallbacks.onError?.(msg)
        }
        return undefined
      }
    },

    attach: (options) => {
      const attachGeneration = advancePtyLifecycle()
      try {
        attachIpcPty(options, {
          handlers,
          outputProcessor,
          isDestroyed: () => destroyed || lifecycleGeneration !== attachGeneration,
          bind,
          isCurrent: (id) => lifecycleGeneration === attachGeneration && connected && ptyId === id,
          setCallbacks,
          setSuppressAttentionEvents: (value) => {
            suppressAttentionEvents = value
          }
        })
      } catch (error) {
        preconnectInputBuffer?.clear()
        throw error
      }
      if (lifecycleGeneration === attachGeneration) {
        void flushPreconnectInput()
      }
    },

    abandonPreconnectInput() {
      preconnectInputBuffer?.clear()
    },

    disconnect() {
      advancePtyLifecycle()
      preconnectInputBuffer?.clear()
      const id = ptyId
      connected = false
      ptyId = null
      handlers.clearAccumulatedState()
      if (id) {
        try {
          window.api.pty.kill(id)
        } finally {
          handlers.unregisterAll(id)
          storedCallbacks.onDisconnect?.()
        }
      }
    },

    detach(options) {
      advancePtyLifecycle()
      outputProcessor.disposePendingSideEffectGauge()
      handlers.clearAccumulatedState()
      preconnectInputBuffer?.clear()
      if (ptyId) {
        if (options?.preserveExitObserver === false) {
          handlers.unregisterAll(ptyId)
        } else {
          handlers.unregisterData(ptyId)
        }
      }
      connected = false
      ptyId = null
      storedCallbacks = {}
    },

    sendInput(data) {
      if (!destroyed && preconnectInputBuffer?.isBuffering()) {
        return preconnectInputBuffer.enqueue(data, 'ordinary', opts.onPreconnectInput)
      }
      return !destroyed && connected && ptyId ? inputWriteQueue.enqueue(ptyId, data) : false
    },

    sendInputImmediate(data) {
      if (!destroyed && preconnectInputBuffer?.isBuffering()) {
        return preconnectInputBuffer.enqueue(data, 'immediate', opts.onPreconnectInput)
      }
      return !destroyed && connected && ptyId
        ? inputWriteQueue.enqueueQueryReply(ptyId, data)
        : false
    },

    ...(connectionId
      ? {}
      : {
          async sendInputAccepted(data: string): Promise<boolean> {
            if (!destroyed && preconnectInputBuffer?.isBuffering()) {
              return preconnectInputBuffer.enqueueAccepted(data, opts.onPreconnectInput)
            }
            if (destroyed || !connected || !ptyId) {
              return false
            }
            return inputWriteQueue.enqueueAccepted(ptyId, data)
          }
        }),

    claimViewport(cols, rows) {
      if (!connected || !ptyId) {
        return false
      }
      window.api.pty.claimViewport(ptyId, cols, rows)
      return true
    },

    resize(cols, rows, meta) {
      if (!connected || !ptyId) {
        return false
      }
      window.api.pty.resize(ptyId, cols, rows)
      if (meta?.claim) {
        window.api.pty.claimViewport(ptyId, cols, rows)
      }
      return true
    },

    isConnected: () => connected,
    getPtyId: () => ptyId,
    getConnectionId: () => connectionId ?? null,
    getLocalSessionMetadata: () =>
      connectionId
        ? null
        : { ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(shellOverride ? { shellOverride } : {}) },
    resetCrossChunkParserState: outputProcessor.resetAgentStatusCarry,

    destroy() {
      destroyed = true
      try {
        this.disconnect()
      } finally {
        outputProcessor.disposePendingSideEffectGauge()
      }
    }
  }
}
