import { readTerminalSpawnDeferral } from '../../../../shared/host-spawn-admission'
import { agentProviderSessionForEnsure } from '../../../../shared/agent-session-resume'
import { remoteRestoreSpawnIntentParams } from '../../runtime/remote-restore-spawn-intent'
import { createAgentSessionKeyboardOptions } from '@/runtime/agent-session-keyboard-capability'
import { createRemoteRuntimeDisconnectedInputGrace } from './remote-runtime-disconnected-input-grace'
import {
  createRemoteRuntimeRecoveryInputHold,
  type RemoteRuntimeInputEndpoint
} from './remote-runtime-recovery-input-hold'
import {
  createRemoteRuntimeInputJournal,
  type RemoteRuntimeInputSegment
} from './remote-runtime-input-journal'
import type { AcceptedInputOptions } from './pty-preconnect-input-buffer'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import { isSshSignInPendingTerminalError } from './terminal-ssh-sign-in-error'
/* eslint-disable max-lines -- Why: remote PTY transport keeps lifecycle, JSON fallback, and binary stream wiring together so reconnect/destroy ordering stays testable as one behavior surface. */
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  isRecoverableRemoteRuntimeConnectionError,
  isRuntimeRpcQueueOverloadError,
  toRemoteRuntimeClientErrorLike
} from '../../../../shared/remote-runtime/remote-runtime-client-error-classification'
import type {
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionResult
} from '../../../../shared/agent-session-host-authority'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TabActivationIntent } from '../../../../shared/tab-activation-intent'
import type {
  RuntimeMobileSessionTerminalClientTab,
  RuntimeMobileSessionTabsResult,
  RuntimeStatus,
  RuntimeTerminalCreate,
  RuntimeTerminalResolvePane,
  RuntimeTerminalSend,
  RuntimeTerminalShow
} from '../../../../shared/runtime-types'
import { TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { agentResumeHostAuthorityCapability } from '../../runtime/agent-resume-host-authority-capability'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import type {
  IpcPtyTransportOptions,
  PtyConnectResult,
  PtyRecoveryCause,
  PtyTransport,
  PtyTransportRecoveryState
} from './pty-transport-types'
import { createPtyOutputProcessor } from './pty-output-processor'
import { isSshSessionGoneError } from './pty-connection/pty-connect-limits'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from '../../runtime/runtime-rpc-result'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle,
  runtimeTerminalErrorMessage
} from '../../runtime/runtime-terminal-stream'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { getRemoteRuntimeTerminalMultiplexer } from '../../runtime/remote-runtime-terminal-multiplexer'
import { REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE } from '../../runtime/remote-runtime-terminal-snapshot-state'
import { restoredSnapshotPaintsPrintableContent } from './restored-snapshot-coverage'
import { hostRecordsTerminalExit, sameWhenBothKnown } from './remote-terminal-host-exit-record'
import {
  watchHostRebindAfterExit,
  type HostRebindAfterExitWatch
} from './remote-terminal-host-rebind-after-exit'
import type {
  RemoteRuntimeMultiplexedTerminal,
  RemoteRuntimeSnapshotOutcome
} from '../../runtime/remote-runtime-terminal-multiplexer-types'
import {
  toRuntimeTerminalWorktreeSelector,
  toRuntimeWorktreeSelector
} from '../../runtime/runtime-worktree-selector'
import {
  createRemoteRuntimePtyTextBatcher,
  createRemoteRuntimeViewportBatcher
} from './remote-runtime-pty-batching'
import {
  REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS,
  RemoteRuntimePtyRecoveryState,
  registerRemoteRuntimePtyControlReadyReviver,
  type RemoteRuntimePtyRecoveryPhase
} from './remote-runtime-pty-recovery-state'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  createAgentSessionCreateOperation,
  withAgentSessionCreateOperationId
} from '@/runtime/agent-session-create-operation'
import { replaceFitOverridePtyId, setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import { replaceDriverPtyId, setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId
} from '../../../../shared/terminal-surface-id'
import { listRemoteRuntimeSessionTabsAfterCurrentInFlight } from '@/runtime/remote-runtime-session-tabs-inflight'
import { subscribeAcceptedWebSessionTerminalHandle } from '@/runtime/web-session-terminal-handle-events'
import { hostSnapshotAffirmsWorktreeContents } from '@/runtime/host-session-snapshot-authority'
import { runRemoteAgentSessionLaunch } from '@/runtime/remote-agent-session-launch'
import { useAppStore } from '@/store'
import { recordWebAgentSessionHandoff } from '@/runtime/web-agent-session-handoff'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-runtime-session-snapshot'
import {
  bufferPtyShutdownData,
  bufferPtyShutdownReplayData,
  drainRolledBackPtyShutdownData,
  isPtyDataHandlerShutdownPending,
  ptyDataHandlers,
  ptyReplayHandlers,
  ptyShutdownLifecycleHandlers
} from './pty-shutdown-data-suspension'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import {
  isRuntimeEnvironmentPairingChangedError,
  refreshRuntimeEnvironmentsAfterPairingChange,
  runtimeEnvironmentPairingChangedError
} from '@/runtime/runtime-environment-pairing-refresh'

const REMOTE_TERMINAL_INPUT_FLUSH_MS = 8
const REMOTE_TERMINAL_VIEWPORT_FLUSH_MS = 33
const REMOTE_VIEWPORT_CLAIM_CONFIRM_WINDOW_MS = 1_000
const REMOTE_RUNTIME_MAX_PENDING_QUERY_REPLIES = 64
const HOST_SESSION_ATTACH_POLL_MS = 150
const HOST_SESSION_POLL_MAX_MS = 1_000
const HOST_SESSION_ATTACH_TIMEOUT_MS = 15_000
const HOST_SESSION_SAME_HANDLE_END_REUSE_LIMIT = 2
// Flap timing is separate from recovery duration; only quick same-handle ends pay growing backoff, not later reveals (#27178).
const HOST_SESSION_SAME_HANDLE_END_REUSE_WINDOW_MS = 10_000
// Why: a flapping handle the host still reports ready is reattached ever more slowly before it is fenced.
const HOST_SESSION_SAME_HANDLE_FLAP_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000
] as const
const MAX_SURFACED_TERMINAL_ERRORS = 8
const TERMINAL_CREATE_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const

type HostHandleReplacementPolicy = 'reuse' | 'prefer-replacement' | 'require-replacement'

type PersistedHostPaneResolution =
  | { kind: 'resolved'; terminal: RuntimeTerminalResolvePane }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

function stricterReplacementPolicy(
  left: HostHandleReplacementPolicy,
  right: HostHandleReplacementPolicy
): HostHandleReplacementPolicy {
  const rank: Record<HostHandleReplacementPolicy, number> = {
    reuse: 0,
    'prefer-replacement': 1,
    'require-replacement': 2
  }
  return rank[left] >= rank[right] ? left : right
}

type RemoteAgentSessionLaunchResult =
  | RuntimeEnsureAgentSessionResult
  | RuntimeCreateAgentSessionResult
  | { terminal: RuntimeTerminalCreate; disposition?: undefined }

function inputSegments(text: string): RemoteRuntimeInputSegment[] {
  return Array.from(iterateTerminalInputChunks(text), (chunk) => ({
    text: chunk,
    queryReply: false
  }))
}

function isRemoteTerminalStaleMessage(message: string): boolean {
  return message.includes('terminal_handle_stale')
}

// Contact loss, backpressure, new handles and pending sign-in remain resolvable; preserve retries for post-sign-in revival (#31942).
function isRetryableUnboundAttachError(error: unknown): boolean {
  const clientError = toRemoteRuntimeClientErrorLike(error)
  return (
    isSshSignInPendingTerminalError(runtimeTerminalErrorMessage(error)) ||
    isRecoverableRemoteRuntimeConnectionError(clientError) ||
    isRuntimeRpcQueueOverloadError(clientError) ||
    isRemoteTerminalStaleMessage(runtimeTerminalErrorMessage(error))
  )
}

// Stale pairing is refused before host dispatch; retry the binding on refreshed pairing without treating the terminal as changed.
function isRecoverablePaneBindingError(error: unknown): boolean {
  return (
    isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error)) ||
    isRuntimeEnvironmentPairingChangedError(error)
  )
}

function isRemoteTerminalGoneMessage(message: string): boolean {
  return (
    message.includes('terminal_exited') ||
    message.includes('terminal_gone') ||
    message.toLocaleLowerCase('en-US').includes('explicitly killed')
  )
}

/** PTY transport for a renderer pane backed by a terminal on a remote Orca runtime, over runtime RPC plus the multiplexed stream. */
export function createRemoteRuntimePtyTransport(
  runtimeEnvironmentId: string,
  opts: IpcPtyTransportOptions = {}
): PtyTransport {
  const {
    command,
    startupCommandDelivery,
    env,
    envToDelete,
    launchConfig,
    resumeProviderSession,
    launchToken,
    launchAgent,
    terminalColorQueryReplies,
    terminalKittyKeyboardProtocol,
    agentPrompt,
    agentPromptDelivery,
    agentArgsOverride,
    agentLaunchPreferences,
    worktreeId,
    executionHostId,
    tabId,
    leafId,
    activate,
    onPtyExit,
    onPtySpawn,
    onPtyRebind,
    onHostReboundExitedPty,
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  } = opts
  let connected = false
  let attachmentReady = false
  let destroyed = false
  let terminalEnded = false
  let connecting = false
  const attachmentReadyWaiters = new Set<(ready: boolean) => void>()
  // Why: transport methods overlap during remounts; only the latest pane lifecycle may install a returned PTY.
  let lifecycleEpoch = 0
  let handle: string | null = null
  let remotePtyId: string | null = null
  let authoritativeExecutionHostId: ExecutionHostId | null = executionHostId ?? null
  let authoritativeHostPlatform: NodeJS.Platform | null = null
  let authoritativePtyIncarnationId: string | null = null
  // Why: never adopts a persisted existingPtyId's environment; the worktree owner chose this transport.
  const currentRuntimeEnvironmentId = runtimeEnvironmentId
  // Follow re-pair only with proof of the original host; same environment ID cannot authorize a different/unverified machine.
  let paneRevision = resolveContinuedRuntimeEnvironmentRevision(
    runtimeEnvironmentId,
    getRuntimeEnvironmentRevision(runtimeEnvironmentId)
  )
  function currentPaneRevision(): number | undefined {
    paneRevision = resolveContinuedRuntimeEnvironmentRevision(runtimeEnvironmentId, paneRevision)
    return paneRevision
  }
  let multiplexedStream: RemoteRuntimeMultiplexedTerminal | null = null
  let multiplexedStreamHandle: string | null = null
  let desiredOutputPaused = false
  let desiredViewport: { cols: number; rows: number } | null = null
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}
  const surfacedErrorMessages = new Set<string>()
  const ownerChanged = 'terminal_pane_owner_changed'
  let resubscribeEpoch: number | null = null
  let resubscribeRequestedHandle: string | null = null
  let resubscribeRequestedReplacementPolicy: HostHandleReplacementPolicy = 'reuse'
  let recoveryReplacementPolicy: HostHandleReplacementPolicy = 'reuse'
  let recoveryReplacementPolicyHandle: string | null = null
  let stopWaitingForPublishedHandle: (() => void) | null = null
  let stopWatchingHostRebind: (() => void) | null = null
  let publishedHandleWaitEpoch: number | null = null
  // Why: a spent auto-recovery window is the evidence that licenses reattaching the fenced handle; explicit retries must not erase it.
  let autoRecoveryWindowSpent = false
  let settleHostSessionAttachRetry: ((retry: boolean) => void) | null = null
  let sameHandleEndReuseHandle: string | null = null
  let sameHandleEndReuseCount = 0
  let sameHandleEndReuseAttachedAt: number | null = null
  let attachGeneration = 0
  let subscriptionGeneration = 0
  // A terminal this pane just created has no history, so an empty first image there is not a gap.
  let spawnedHandle: string | null = null
  let inputReadySubscription: number | null = null

  function setAttachmentReady(ready: boolean): void {
    attachmentReady = ready
    if (!ready) {
      return
    }
    for (const resolve of attachmentReadyWaiters) {
      resolve(true)
    }
    attachmentReadyWaiters.clear()
  }

  function setAttachmentUnavailable(): void {
    attachmentReady = false
    for (const resolve of attachmentReadyWaiters) {
      resolve(false)
    }
    attachmentReadyWaiters.clear()
  }

  function waitForAttachmentReady(): Promise<boolean> {
    if (attachmentReady) {
      return Promise.resolve(true)
    }
    if (destroyed || terminalEnded || !connected || !handle) {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        attachmentReadyWaiters.delete(settle)
        resolve(false)
      }, HOST_SESSION_ATTACH_TIMEOUT_MS)
      const settle = (ready: boolean): void => {
        clearTimeout(timer)
        resolve(ready)
      }
      attachmentReadyWaiters.add(settle)
    })
  }

  const recoveryInputHold = createRemoteRuntimeRecoveryInputHold({ holdBeforeFirstConnect: true })
  let heldInputRelease: {
    stream: RemoteRuntimeMultiplexedTerminal
    waitingForValidation: boolean
  } | null = null
  const inputJournal = createRemoteRuntimeInputJournal({
    currentStream: sequencedInputTarget,
    // Why: a refusal that never clears would drop every keystroke behind a connected-looking pane.
    onRefusalsPersist: () => notifyWriteUnavailable()
  })
  const disconnectedInputGrace = createRemoteRuntimeDisconnectedInputGrace()
  let previousRecoveryPhase: RemoteRuntimePtyRecoveryPhase = 'idle'
  let unregisterControlReadyReviver: (() => void) | null = null
  // Why: the pane's retry is waiting on the user's SSH sign-in, not on a lost link.
  let awaitingSshSignIn = false
  // Keep connect pending through sign-in recovery so launch finalization receives the recovered terminal binding.
  let signInConnectWait: PromiseWithResolvers<PtyConnectResult | undefined> | null = null
  function settleSignInConnectWait(result?: PtyConnectResult): void {
    const wait = signInConnectWait
    signInConnectWait = null
    wait?.resolve(result)
  }
  function setAwaitingSshSignIn(next: boolean): void {
    if (awaitingSshSignIn !== next) {
      awaitingSshSignIn = next
      emitRecoveryState()
    }
  }
  // Why registered only while recovering: detach and destroy go idle, so a discarded transport is never retained.
  function syncControlReadyReviver(): void {
    const wantsRevival = recovery.isActive || recovery.currentPhase === 'disconnected'
    if (wantsRevival && !unregisterControlReadyReviver) {
      // Why: a backoff advances and a latched pane replays its attach, exactly as online/resume/Reconnect would.
      unregisterControlReadyReviver = registerRemoteRuntimePtyControlReadyReviver(
        runtimeEnvironmentId,
        () => {
          if (destroyed) {
            return false
          }
          // Why: a ready control socket proves sign-in finished, whatever the replay meets next.
          setAwaitingSshSignIn(false)
          return recovery.retryNow() || (transport.retryRecovery?.() ?? false)
        }
      )
    } else if (!wantsRevival && unregisterControlReadyReviver) {
      unregisterControlReadyReviver()
      unregisterControlReadyReviver = null
    }
  }
  const recovery = new RemoteRuntimePtyRecoveryState(() => {
    syncControlReadyReviver()
    // Why: any recovery transition after the ack (a stale send, a close, the deadline) re-holds typing.
    inputReadySubscription = null
    const leftLatchForRetry = previousRecoveryPhase === 'disconnected' && recovery.isActive
    previousRecoveryPhase = recovery.currentPhase
    if (recovery.currentPhase === 'disposed') {
      clearPublishedHandleWait()
      disconnectedInputGrace.reset()
      discardPendingInput()
    }
    if (leftLatchForRetry) {
      if (discardExpiredDisconnectedInput()) {
        // Why: a retry after the grace starts fresh; keys typed during it belong to this attempt.
        disconnectedInputGrace.reset()
      } else {
        disconnectedInputGrace.carryThroughRetry()
      }
    }
    if (recovery.currentPhase === 'disconnected') {
      disconnectedInputGrace.start()
      // Why: only the wall-clock deadline is evidence the window was spent; a UI latch from a fatal
      // resubscribe must not license reattaching a fenced same handle (#12683).
      autoRecoveryWindowSpent ||= recovery.autoRecoveryDeadlineExpired
      // Why: cached pixels may remain, but no stream from the exhausted epoch may keep delivering or accepting terminal traffic.
      subscriptionGeneration += 1
      closeMultiplexedStream()
    }
    if (recovery.currentPhase === 'idle' || recovery.currentPhase === 'disposed') {
      awaitingSshSignIn = false
      // Why: a healthy recovery settled it first with the bound terminal; anything else gave up.
      settleSignInConnectWait()
    }
    if (recovery.currentPhase === 'idle') {
      recoveryCause = null
      autoRecoveryWindowSpent = false
      // Why before the reset: input that outlived the grace must not release into the recovered pane.
      discardExpiredDisconnectedInput()
      disconnectedInputGrace.reset()
    }
    if (
      recovery.currentPhase === 'disconnected' ||
      recovery.currentPhase === 'disposed' ||
      recovery.currentPhase === 'idle'
    ) {
      settleHostSessionAttachRetry?.(false)
    }
    emitRecoveryState()
  })
  let lastRecoveryStateKey = ''
  let recoveryCause: PtyRecoveryCause | null = null
  let pendingViewportClaim = false
  // Why: recovery holds viewport sends, so the intent must survive to the stream that releases typing.
  let recoveryDeferredViewport: 'claim' | 'resize' | null = null
  let pendingClaimInput: { text: string; queryReply: boolean }[] = []
  let pendingClaimQueryReplyCount = 0
  let terminalCreateRetryWait: {
    timer: ReturnType<typeof setTimeout>
    resolve: (continueRetrying: boolean) => void
  } | null = null
  // Why: after an unknown result, every later attempt must reconcile first so older runtimes cannot duplicate the PTY.
  let terminalCreateNeedsReconciliation = false
  // Why: once a structured outcome is ambiguous, only its stable host operation may be replayed.
  let agentSessionRequiresHostAuthorityReplay = false
  let terminalCreateUnknownOutcomeError: unknown = null
  let lastConnectOptions: Parameters<PtyTransport['connect']>[0] | null = null
  let lastAttachOptions: Parameters<PtyTransport['attach']>[0] | null = null
  let resolvePaneUnavailable = false
  let recoveringPaneHandle: string | null = null
  let hostExitProbeHandle: string | null = null
  const getRecoveryReplacementPolicy = (targetHandle: string): HostHandleReplacementPolicy =>
    recoveryReplacementPolicyHandle === targetHandle ? recoveryReplacementPolicy : 'reuse'
  const resetRecoveryReplacementPolicy = (): void => {
    recoveryReplacementPolicy = 'reuse'
    recoveryReplacementPolicyHandle = null
  }
  const strengthenRecoveryReplacementPolicy = (
    targetHandle: string,
    replacementPolicy: HostHandleReplacementPolicy
  ): void => {
    if (recoveryReplacementPolicyHandle !== targetHandle) {
      recoveryReplacementPolicyHandle = targetHandle
      recoveryReplacementPolicy = replacementPolicy
      return
    }
    recoveryReplacementPolicy = stricterReplacementPolicy(
      recoveryReplacementPolicy,
      replacementPolicy
    )
  }
  const resetSameHandleEndReuse = (): void => {
    sameHandleEndReuseHandle = null
    sameHandleEndReuseCount = 0
    sameHandleEndReuseAttachedAt = null
  }
  const recordSameHandleEndReuse = (targetHandle: string): void => {
    if (sameHandleEndReuseHandle !== targetHandle) {
      sameHandleEndReuseHandle = targetHandle
      sameHandleEndReuseCount = 0
    }
    sameHandleEndReuseCount += 1
    sameHandleEndReuseAttachedAt = Date.now()
  }
  // Attachment-loss flaps use growing backoff; once exhausted, wait for replacement so repeated reattach cannot reset recovery forever (#27178).
  const sameHandleEndFlapDelayMs = (targetHandle: string): number | null => {
    if (
      sameHandleEndReuseHandle !== targetHandle ||
      sameHandleEndReuseAttachedAt === null ||
      Date.now() - sameHandleEndReuseAttachedAt >= HOST_SESSION_SAME_HANDLE_END_REUSE_WINDOW_MS
    ) {
      resetSameHandleEndReuse()
      return 0
    }
    const flaps = sameHandleEndReuseCount - HOST_SESSION_SAME_HANDLE_END_REUSE_LIMIT
    return flaps < 0 ? 0 : (HOST_SESSION_SAME_HANDLE_FLAP_DELAYS_MS[flaps] ?? null)
  }
  // Why: an unanswered send can still come back terminal_handle_stale, so its handle is not yet safe to reuse.
  const terminalSendsInFlight = new Map<string, number>()
  const trackTerminalSend = <T>(targetHandle: string, request: Promise<T>): Promise<T> => {
    terminalSendsInFlight.set(targetHandle, (terminalSendsInFlight.get(targetHandle) ?? 0) + 1)
    return request.finally(() => {
      const remaining = (terminalSendsInFlight.get(targetHandle) ?? 1) - 1
      if (remaining > 0) {
        terminalSendsInFlight.set(targetHandle, remaining)
      } else {
        terminalSendsInFlight.delete(targetHandle)
      }
    })
  }
  const adoptExecutionMetadata = (terminal: {
    executionHostId?: ExecutionHostId
    hostPlatform?: NodeJS.Platform
    incarnationId?: string | null
  }): void => {
    authoritativeExecutionHostId = terminal.executionHostId ?? authoritativeExecutionHostId
    authoritativeHostPlatform = terminal.hostPlatform ?? authoritativeHostPlatform
    authoritativePtyIncarnationId = terminal.incarnationId ?? null
  }
  const viewportClaimReadyWaiters = new Set<(ready: boolean) => void>()
  const clearPendingViewportClaim = (): void => {
    pendingViewportClaim = false
    pendingClaimInput = []
    pendingClaimQueryReplyCount = 0
    for (const resolve of viewportClaimReadyWaiters) {
      resolve(false)
    }
    viewportClaimReadyWaiters.clear()
  }
  const queuePendingClaimInput = (text: string, queryReply: boolean): void => {
    if (queryReply && pendingClaimQueryReplyCount >= REMOTE_RUNTIME_MAX_PENDING_QUERY_REPLIES) {
      const oldestReply = pendingClaimInput.findIndex((segment) => segment.queryReply)
      if (oldestReply !== -1) {
        pendingClaimInput.splice(oldestReply, 1)
        pendingClaimQueryReplyCount -= 1
        const left = pendingClaimInput[oldestReply - 1]
        const right = pendingClaimInput[oldestReply]
        if (left && right && !left.queryReply && !right.queryReply) {
          left.text += right.text
          pendingClaimInput.splice(oldestReply, 1)
        }
      }
    }
    const tail = pendingClaimInput.at(-1)
    if (!queryReply && tail && !tail.queryReply) {
      tail.text += text
      return
    }
    pendingClaimInput.push({ text, queryReply })
    if (queryReply) {
      pendingClaimQueryReplyCount += 1
    }
  }
  // Why: clearing the claim flag without draining strands the queued bytes.
  const flushPendingClaimInput = (stream: RemoteRuntimeMultiplexedTerminal): void => {
    const queued = pendingClaimInput
    pendingViewportClaim = false
    pendingClaimInput = []
    pendingClaimQueryReplyCount = 0
    const boundHandle = multiplexedStreamHandle
    if (stream.acknowledgesInput() && boundHandle) {
      inputJournal.send(stream, heldInputEndpoint(boundHandle), queued)
    } else {
      for (const segment of queued) {
        stream.sendInput(segment.text)
      }
    }
    for (const resolve of viewportClaimReadyWaiters) {
      resolve(true)
    }
    viewportClaimReadyWaiters.clear()
  }
  // Why: tab/leaf ids are shared by paired viewers; the instance suffix keeps one viewer's refresh off peer records.
  const clientId = `desktop:${tabId ?? 'tab'}:${leafId ?? 'leaf'}:${createBrowserUuid()}`
  const terminalCreateMutationId = createBrowserUuid()
  // Replay one stable host operation after lost responses so reconnect cannot launch a second agent.
  const agentCreateOperation = createAgentSessionCreateOperation()
  const agentKeyboardOptions = createAgentSessionKeyboardOptions(terminalKittyKeyboardProtocol)
  const outputProcessor = createPtyOutputProcessor({
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  })
  const shutdownDataHandler = (
    data: string,
    meta?: Parameters<typeof outputProcessor.processData>[3]
  ): void => {
    outputProcessor.processData(data, storedCallbacks, undefined, meta)
  }
  // Why flagged: only pushed snapshots are buffered for this pty during a shutdown.
  const shutdownReplayHandler = (data: string): void => {
    outputProcessor.processData(data, storedCallbacks, {
      replayingBufferedData: true,
      suppressAttentionEvents: true,
      carriesNormalBuffer: true
    })
  }
  const shutdownLifecycle = {
    pause: outputProcessor.pausePendingSideEffects,
    rollback: outputProcessor.flushPendingSideEffects,
    commit: outputProcessor.clearAccumulatedState
  }
  const registerShutdownHandlers = (ptyId: string): void => {
    ptyDataHandlers.set(ptyId, shutdownDataHandler)
    ptyReplayHandlers.set(ptyId, shutdownReplayHandler)
    ptyShutdownLifecycleHandlers.set(ptyId, shutdownLifecycle)
    if (!isPtyDataHandlerShutdownPending(ptyId)) {
      drainRolledBackPtyShutdownData(ptyId)
    }
  }
  const unregisterShutdownHandlers = (ptyId: string | null): void => {
    if (!ptyId) {
      return
    }
    if (ptyDataHandlers.get(ptyId) === shutdownDataHandler) {
      ptyDataHandlers.delete(ptyId)
    }
    if (ptyReplayHandlers.get(ptyId) === shutdownReplayHandler) {
      ptyReplayHandlers.delete(ptyId)
    }
    if (ptyShutdownLifecycleHandlers.get(ptyId) === shutdownLifecycle) {
      ptyShutdownLifecycleHandlers.delete(ptyId)
    }
  }

  function getRecoveryState(): PtyTransportRecoveryState {
    const phase = destroyed
      ? 'disposed'
      : terminalEnded
        ? 'ended'
        : recovery.currentPhase === 'recovering'
          ? 'recovering'
          : recovery.currentPhase === 'backoff'
            ? 'backoff'
            : recovery.currentPhase === 'disconnected'
              ? 'disconnected'
              : connecting
                ? 'connecting'
                : connected && attachmentReady
                  ? 'connected'
                  : 'offline'
    const ownership =
      (recovery.isActive && recovery.hasOwnerRefresh) || surfacedErrorMessages.has(ownerChanged)
    const awaitingSignIn =
      awaitingSshSignIn &&
      (phase === 'recovering' || phase === 'backoff' || phase === 'disconnected')
    return {
      phase,
      epoch: recovery.currentEpoch,
      attempt: recovery.attemptCount,
      ...(recoveryCause && recovery.currentPhase !== 'idle' ? { cause: recoveryCause } : {}),
      ...(recovery.awaitingExternalTrigger ? { waiting: true as const } : {}),
      ...(ownership
        ? { reason: 'ownership' as const }
        : awaitingSignIn
          ? { reason: 'ssh-sign-in' as const }
          : {})
    }
  }

  function emitRecoveryState(force = false): void {
    const state = getRecoveryState()
    const key = `${state.phase}:${state.epoch}:${state.attempt}:${state.reason ?? ''}:${state.cause ?? ''}:${state.waiting ?? ''}`
    if (!force && key === lastRecoveryStateKey) {
      return
    }
    lastRecoveryStateKey = key
    storedCallbacks.onRecoveryStateChange?.(state)
  }

  function surfaceErrorMessage(message: string): void {
    if (surfacedErrorMessages.has(message)) {
      return
    }
    while (surfacedErrorMessages.size >= MAX_SURFACED_TERMINAL_ERRORS) {
      const oldest = surfacedErrorMessages.values().next().value
      if (typeof oldest !== 'string') {
        break
      }
      surfacedErrorMessages.delete(oldest)
    }
    surfacedErrorMessages.add(message)
    storedCallbacks.onError?.(message)
  }

  function markRecoveryHealthy(result?: PtyConnectResult): void {
    if (signInConnectWait) {
      settleSignInConnectWait(
        remotePtyId
          ? {
              id: remotePtyId,
              replay: '',
              ...(spawnedHandle === handle ? {} : { isReattach: true }),
              ...(authoritativePtyIncarnationId
                ? { incarnationId: authoritativePtyIncarnationId }
                : {})
            }
          : undefined
      )
    }
    const recoveredErrors = [...surfacedErrorMessages]
    surfacedErrorMessages.clear()
    recovery.markHealthy(result)
    for (const message of recoveredErrors) {
      storedCallbacks.onErrorCleared?.(message)
    }
  }

  function hostSnapshotOwnsLaunch(
    result: RemoteAgentSessionLaunchResult,
    environmentId: string
  ): boolean {
    if (result.disposition !== undefined || result.terminal.isReattach === true) {
      // Structured launches are host-owned; provisional teardown cannot close their canonical terminal during reconciliation.
      return true
    }
    const scopedPtyId = toRemoteRuntimePtyId(result.terminal.handle, environmentId)
    return (useAppStore.getState().tabsByWorktree[worktreeId ?? ''] ?? []).some(
      (tab) =>
        tab.ptyId === scopedPtyId ||
        (result.terminal.tabId !== undefined &&
          isWebTerminalSurfaceTabId(tab.id) &&
          toHostSessionTabId(tab.id) === result.terminal.tabId)
    )
  }

  function findReadyHostSessionHandle(
    snapshot: RuntimeMobileSessionTabsResult,
    hostTabId: string
  ): string | null {
    const terminalTabs = getHostSessionTerminalSurfaces(snapshot, hostTabId, {
      matchRequestedLeaf: false
    })
    const selected = leafId
      ? terminalTabs.find(
          (tab) => tab.status === 'ready' && tab.parentTabId === hostTabId && tab.leafId === leafId
        )
      : (terminalTabs.find(
          (tab) => tab.status === 'ready' && tab.parentTabId === hostTabId && tab.isActive
        ) ?? terminalTabs.find((tab) => tab.status === 'ready' && tab.parentTabId === hostTabId))
    if (selected?.status === 'ready') {
      authoritativePtyIncarnationId = selected.incarnationId ?? null
      return selected.terminal
    }
    return null
  }

  function getHostSessionTerminalSurfaces(
    snapshot: RuntimeMobileSessionTabsResult,
    hostTabId: string,
    options: { matchRequestedLeaf: boolean }
  ): RuntimeMobileSessionTerminalClientTab[] {
    return snapshot.tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalClientTab =>
        tab.type === 'terminal' &&
        (tab.parentTabId === hostTabId || tab.id === hostTabId) &&
        (!options.matchRequestedLeaf || !leafId || tab.leafId === leafId)
    )
  }

  function hasHostSessionTerminalSurface(
    snapshot: RuntimeMobileSessionTabsResult,
    hostTabId: string
  ): boolean {
    return (
      getHostSessionTerminalSurfaces(snapshot, hostTabId, {
        matchRequestedLeaf: true
      }).length > 0
    )
  }

  // Why: pending host surfaces materialize only through activation.
  function activateHostSessionSurface(
    hostTabId: string,
    worktree: string,
    intent: TabActivationIntent,
    timeoutMs?: number
  ): Promise<RuntimeMobileSessionTabsResult> {
    return callRuntime<RuntimeMobileSessionTabsResult>(
      'session.tabs.activate',
      {
        worktree,
        tabId: hostTabId,
        ...(leafId ? { leafId } : {}),
        notifyClients: false,
        navigation: 'caller',
        intent
      },
      timeoutMs
    )
  }

  function isMissingHostSessionSurfaceError(error: unknown): boolean {
    const message = runtimeTerminalErrorMessage(error)
    return message.includes('tab_not_found') || message.includes('terminal_not_found')
  }

  async function waitForHostSessionHandle(
    hostTabId: string,
    isCurrent: () => boolean
  ): Promise<string | undefined | false> {
    if (!worktreeId) {
      return undefined
    }
    const worktree = toRuntimeWorktreeSelector(worktreeId)
    let activated: RuntimeMobileSessionTabsResult | undefined
    try {
      // Why: this runs when the pane itself is opened/attached — the user's wake gesture.
      activated = await activateHostSessionSurface(hostTabId, worktree, 'user')
    } catch (error) {
      // Activation cannot distinguish pre-hydration from true absence; only scoped inventory may prove removal (#21852).
      if (!isMissingHostSessionSurfaceError(error)) {
        throw error
      }
    }
    const immediate = activated ? findReadyHostSessionHandle(activated, hostTabId) : undefined
    if (immediate) {
      return immediate
    }

    const startedAt = Date.now()
    let pollMs = HOST_SESSION_ATTACH_POLL_MS
    let nextRequest: 'activate' | 'list' = 'list'
    let activationOutcomeUnknown = false
    while (isCurrent()) {
      const remainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (remainingMs <= 0) {
        return undefined
      }
      // Why: host mirrors can publish before their PTY handle is ready, but a stuck pending surface must not poll forever.
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)))
      pollMs = Math.min(pollMs * 2, HOST_SESSION_POLL_MAX_MS)
      // Why: an RPC left on its own 15s default would stretch this bounded wait to ~30s before the pane reports any terminal state.
      const requestRemainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (requestRemainingMs <= 0) {
        return undefined
      }
      const request = nextRequest
      let snapshot: RuntimeMobileSessionTabsResult
      try {
        // Why: a joined pre-publication inventory cannot prove this leaf is gone (#20923).
        snapshot =
          request === 'list'
            ? (
                await listRemoteRuntimeSessionTabsAfterCurrentInFlight({
                  environmentId: currentRuntimeEnvironmentId,
                  worktreeId,
                  load: async () => ({
                    snapshot: await callRuntime<RuntimeMobileSessionTabsResult>(
                      'session.tabs.list',
                      {
                        worktree
                      },
                      requestRemainingMs
                    )
                  })
                })
              ).snapshot
            : await activateHostSessionSurface(hostTabId, worktree, 'user', requestRemainingMs)
      } catch (error) {
        if (request === 'list') {
          throw error
        }
        // Activation failure proves no absence, including old-method errors; ambiguous activation may already have spawned and cannot be repeated blindly.
        activationOutcomeUnknown = true
        nextRequest = 'list'
        continue
      }
      const handle = findReadyHostSessionHandle(snapshot, hostTabId)
      if (handle) {
        return handle
      }
      if (request === 'activate') {
        // Why: an activation response can race host publication, so inventory — not this snapshot — decides what exists.
        nextRequest = 'list'
        continue
      }
      if (!hasHostSessionTerminalSurface(snapshot, hostTabId)) {
        const siblingStillExists =
          getHostSessionTerminalSurfaces(snapshot, hostTabId, {
            matchRequestedLeaf: false
          }).length > 0
        if (siblingStillExists) {
          return false
        }
        // Sibling-present inventory can prove this leaf absent; missing tab surfaces during republish remain unknown and use bounded polling.
        nextRequest = 'list'
        continue
      }
      // Why: a host relaunch republishes the surface unmaterialized, and only activation can mint its PTY — list-only polling waits forever.
      nextRequest = activationOutcomeUnknown ? 'list' : 'activate'
    }
    return undefined
  }

  function waitForHostSessionAttachRetry(recoveryEpoch: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const settle = (retry: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        if (settleHostSessionAttachRetry === settle) {
          settleHostSessionAttachRetry = null
        }
        // Why: this wait is single-shot, so replaying it after the cutoff would strand the pane in 'recovering' with no RPC in flight.
        recovery.discardPendingRetry(scheduledRetry)
        resolve(retry)
      }
      const scheduledRetry = (): void => {
        settle(true)
      }
      settleHostSessionAttachRetry?.(false)
      settleHostSessionAttachRetry = settle
      if (!recovery.schedule(recoveryEpoch, scheduledRetry)) {
        settle(false)
      }
    })
  }

  async function waitForHostSessionHandleWithRecovery(
    hostTabId: string,
    isCurrent: () => boolean,
    outcome: { boundedWaitEnded: boolean }
  ): Promise<string | undefined | false> {
    let recoveryEpoch = recovery.isActive ? recovery.currentEpoch : undefined
    while (isCurrent()) {
      try {
        const hostHandle = await waitForHostSessionHandle(hostTabId, isCurrent)
        if (!isCurrent()) {
          return undefined
        }
        outcome.boundedWaitEnded = hostHandle === undefined
        if (recoveryEpoch !== undefined) {
          if (!recovery.isCurrent(recoveryEpoch)) {
            return undefined
          }
        }
        return hostHandle
      } catch (error) {
        if (!isRecoverablePaneBindingError(error) || !isCurrent()) {
          throw error
        }
        if (recoveryEpoch !== undefined && !recovery.isCurrent(recoveryEpoch)) {
          return undefined
        }
        recoveryEpoch ??= recovery.begin()
        if (!(await waitForHostSessionAttachRetry(recoveryEpoch)) || !isCurrent()) {
          return undefined
        }
      }
    }
    return undefined
  }

  async function waitForResubscribeHostSessionHandle(
    hostTabId: string,
    previousHandle: string,
    replacementPolicy: HostHandleReplacementPolicy,
    recoveryEpoch: number
  ): Promise<string | null | undefined> {
    if (!worktreeId) {
      return null
    }
    const worktree = toRuntimeWorktreeSelector(worktreeId)
    const startedAt = Date.now()
    let pollMs = HOST_SESSION_ATTACH_POLL_MS
    // Why: list-only polling cannot recreate a host PTY lost across desktop generations.
    let nextRequest: 'activate' | 'list' = 'activate'
    let lastRequestError: unknown = null
    let lastReadyHandle: string | null = null
    const finishBoundedWait = (): string | undefined => {
      const effectivePolicy = stricterReplacementPolicy(
        replacementPolicy,
        getRecoveryReplacementPolicy(previousHandle)
      )
      if (effectivePolicy === 'prefer-replacement' && lastReadyHandle) {
        return lastReadyHandle
      }
      if (lastRequestError) {
        console.warn(
          '[remote-runtime-pty] host session recovery request failed during reconnect:',
          runtimeTerminalErrorMessage(lastRequestError)
        )
      }
      // Why: a bounded wait without removal evidence is unknown liveness; keep the pane for a later snapshot to reattach.
      return undefined
    }
    while (
      !destroyed &&
      connected &&
      handle === previousHandle &&
      recovery.isCurrent(recoveryEpoch)
    ) {
      const requestRemainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (requestRemainingMs <= 0) {
        return finishBoundedWait()
      }
      const request = nextRequest
      try {
        // Why: a joined pre-publication inventory cannot prove this leaf is gone (#20923).
        const listed =
          request === 'list'
            ? (
                await listRemoteRuntimeSessionTabsAfterCurrentInFlight({
                  environmentId: currentRuntimeEnvironmentId,
                  worktreeId,
                  load: async () => ({
                    snapshot: await callRuntime<RuntimeMobileSessionTabsResult>(
                      'session.tabs.list',
                      {
                        worktree
                      },
                      requestRemainingMs
                    )
                  })
                })
              ).snapshot
            : // Reconnect is machinery, not user wake; leave intentionally slept pending panes asleep.
              await activateHostSessionSurface(hostTabId, worktree, 'automatic', requestRemainingMs)
        lastRequestError = null
        const nextHandle = findReadyHostSessionHandle(listed, hostTabId)
        if (nextHandle) {
          lastReadyHandle = nextHandle
        }
        const effectivePolicy = stricterReplacementPolicy(
          replacementPolicy,
          getRecoveryReplacementPolicy(previousHandle)
        )
        if (nextHandle && (effectivePolicy === 'reuse' || nextHandle !== previousHandle)) {
          return nextHandle
        }
        // A ready ended handle may still own a live PTY; same-handle recovery avoids a 15s replacement wait on every switch (#27178).
        if (
          nextHandle === previousHandle &&
          effectivePolicy === 'prefer-replacement' &&
          !terminalSendsInFlight.has(previousHandle)
        ) {
          return nextHandle
        }
        if (request === 'list') {
          if (hasHostSessionTerminalSurface(listed, hostTabId)) {
            if (!nextHandle) {
              // Why: the surface is published but unmaterialized, and only activation can mint its PTY.
              nextRequest = 'activate'
            }
          } else if (hostSnapshotAffirmsWorktreeContents(listed)) {
            return null
          }
          // Why: an unpublished frame from a relaunched host is unknown liveness, so keep asking.
        } else {
          // Why: an activation response can race host publication, so inventory — not this snapshot — decides what exists.
          nextRequest = 'list'
        }
      } catch (error) {
        // Why: the inventory can race the reconnect that invalidated the handle; unknown liveness must not retire the pane.
        lastRequestError = error
        if (request === 'activate') {
          // Why: no activation failure is absence proof, whether the surface is missing or the host predates the method.
          nextRequest = 'list'
        }
      }
      const remainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (remainingMs <= 0) {
        return finishBoundedWait()
      }
      // Why: a stale response can precede its replacement; bounded backoff avoids retrying the stale handle in a hot loop.
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)))
      pollMs = Math.min(pollMs * 2, HOST_SESSION_POLL_MAX_MS)
    }
    return undefined
  }

  // Why: the reconnect button and a parked external trigger revive a pane the same way — replay whichever entry point opened it.
  function replayLastTransportEntryPoint(): boolean {
    if (destroyed || terminalEnded || connected) {
      return false
    }
    if (lastAttachOptions) {
      attachPane(lastAttachOptions, true)
      return true
    }
    if (lastConnectOptions) {
      void connectHoldingRestoredInput(lastConnectOptions, true)
      return true
    }
    return false
  }

  // Recoverable connect failure proves contact loss, not process death; retain the retry path that can still reach the pane (#12684).
  function retryAfterRecoverableConnectFailure(nextEpoch: number): void {
    if (destroyed || terminalEnded) {
      return
    }
    if (connected && handle) {
      scheduleResubscribeAfterTransportClose(getRecoveryReplacementPolicy(handle), nextEpoch)
      return
    }
    replayLastTransportEntryPoint()
  }

  // Schedule bounded auto-retries and retain a parked retry after deadline so external triggers always have work to revive.
  function scheduleConnectRetryAfterRecoverableFailure(): void {
    if (destroyed) {
      return
    }
    // Ambiguous creates require explicit reconciliation-gated retry; automatic replay could repeatedly probe an incapable runtime.
    if (terminalCreateNeedsReconciliation || agentSessionRequiresHostAuthorityReplay) {
      recovery.markDisconnected()
      return
    }
    // Silent-drop RPCs can reject after deadline; park without restarting the whole recovery epoch.
    if (recovery.currentPhase === 'disconnected') {
      recovery.parkRetryAfterDeadline(retryAfterRecoverableConnectFailure)
      return
    }
    const recoveryEpoch = recovery.isActive ? recovery.currentEpoch : recovery.begin()
    if (!recovery.schedule(recoveryEpoch, retryAfterRecoverableConnectFailure)) {
      recovery.markDisconnected()
    }
  }

  async function resolveHostSessionPane(
    hostTabId: string
  ): Promise<RuntimeTerminalResolvePane | null> {
    if (!leafId || !worktreeId || resolvePaneUnavailable) {
      return null
    }
    try {
      const resolved = await callRuntime<{ terminal: RuntimeTerminalResolvePane }>(
        'terminal.resolvePane',
        { paneKey: `${hostTabId}:${leafId}`, worktreeId }
      )
      // Why: wire data; an answer without a pane must read as unresolved, not throw past this catch.
      return resolved.terminal ?? null
    } catch (error) {
      if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
        resolvePaneUnavailable = true
      }
      return null
    }
  }

  async function attachHostSessionMirror(
    options: { cols?: number; rows?: number },
    notifySpawn = true,
    expectedAttachGeneration?: number,
    expectedLifecycleEpoch?: number
  ): Promise<PtyConnectResult | undefined> {
    if (!tabId || !isWebTerminalSurfaceTabId(tabId)) {
      return undefined
    }
    const isCurrent = (): boolean =>
      !destroyed &&
      (expectedAttachGeneration === undefined || expectedAttachGeneration === attachGeneration) &&
      (expectedLifecycleEpoch === undefined || expectedLifecycleEpoch === lifecycleEpoch)
    const hostTabId = toHostSessionTabId(tabId)
    const waitOutcome = { boundedWaitEnded: false }
    // Why overlap: resolvePane is a read keyed only by the pane, so it need not wait an activation round trip.
    const earlyPaneResolution = resolveHostSessionPane(hostTabId)
    const hostHandle = await waitForHostSessionHandleWithRecovery(hostTabId, isCurrent, waitOutcome)
    if (!isCurrent()) {
      return undefined
    }
    if (hostHandle === undefined) {
      connecting = false
      // Unknown missing handles need scheduled recovery, not silent connecting or event-only parking on a healthy link; scheduling still leaves a parked retry after deadline (#27178).
      const replayAttach = (): void => {
        replayLastTransportEntryPoint()
      }
      if (recovery.currentPhase === 'disconnected') {
        // Why: a bounded wait still in flight at the cutoff stays revivable; a settled single-shot retry wait does not.
        if (waitOutcome.boundedWaitEnded) {
          recovery.parkRetryAfterDeadline(replayAttach)
        }
      } else {
        recovery.schedule(
          recovery.isActive ? recovery.currentEpoch : recovery.begin(),
          replayAttach
        )
      }
      emitRecoveryState()
      return undefined
    }
    if (!hostHandle) {
      connecting = false
      emitRecoveryState()
      surfaceErrorMessage('Remote terminal was closed.')
      return undefined
    }

    const matchesHostHandle = (
      terminal: RuntimeTerminalResolvePane | null
    ): terminal is RuntimeTerminalResolvePane =>
      terminal !== null &&
      terminal.handle === hostHandle &&
      terminal.tabId === hostTabId &&
      terminal.leafId === leafId &&
      (!terminal.worktreeId || terminal.worktreeId === worktreeId)
    let resolvedPane = await earlyPaneResolution
    const activationIncarnationId = authoritativePtyIncarnationId
    if (
      !matchesHostHandle(resolvedPane) ||
      (activationIncarnationId !== null &&
        (resolvedPane.incarnationId ?? null) !== activationIncarnationId)
    ) {
      // Why: activation can materialize the surface or learn its incarnation, so an earlier read may be stale.
      resolvedPane = await resolveHostSessionPane(hostTabId)
    }
    if (matchesHostHandle(resolvedPane)) {
      adoptExecutionMetadata(resolvedPane)
    }

    if (!isCurrent() || recovery.currentPhase === 'disconnected') {
      return undefined
    }
    handle = hostHandle
    remotePtyId = toRemoteRuntimePtyId(hostHandle, currentRuntimeEnvironmentId)
    registerShutdownHandlers(remotePtyId)
    connected = true
    desiredViewport = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24
    }
    if (notifySpawn) {
      onPtySpawn?.(remotePtyId)
    }

    try {
      await subscribeToHandle()
    } catch (error) {
      if (!recoverAfterSubscribeFailure(error, hostHandle, remotePtyId)) {
        throw error
      }
    }
    if (!connected || !remotePtyId || !isCurrent()) {
      return undefined
    }

    return {
      id: remotePtyId,
      replay: '',
      isReattach: true,
      ...(authoritativePtyIncarnationId ? { incarnationId: authoritativePtyIncarnationId } : {})
    } satisfies PtyConnectResult
  }

  async function callRuntimeForEnvironment<TResult>(
    environmentId: string,
    method: string,
    params?: unknown,
    timeoutMs = 15_000
  ): Promise<TResult> {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method,
      params,
      timeoutMs,
      expectedEnvironmentPairingRevision: currentPaneRevision()
    })
    try {
      return unwrapRuntimeRpcResult(response as RuntimeRpcResponse<TResult>)
    } catch (error) {
      // Why await: the caller's retry must read the new revision, not race the catalog re-read.
      await refreshRuntimeEnvironmentsAfterPairingChange(error)
      throw error
    }
  }

  async function callRuntime<TResult>(
    method: string,
    params?: unknown,
    timeoutMs = 15_000
  ): Promise<TResult> {
    return callRuntimeForEnvironment(currentRuntimeEnvironmentId, method, params, timeoutMs)
  }

  function cancelTerminalCreateRetryWait(): void {
    const waiting = terminalCreateRetryWait
    terminalCreateRetryWait = null
    if (waiting) {
      clearTimeout(waiting.timer)
      waiting.resolve(false)
    }
  }

  function waitForTerminalCreateRetry(delayMs: number): Promise<boolean> {
    if (destroyed) {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (terminalCreateRetryWait?.timer === timer) {
          terminalCreateRetryWait = null
        }
        resolve(!destroyed)
      }, delayMs)
      timer.unref?.()
      terminalCreateRetryWait = { timer, resolve }
    })
  }

  function terminalCreateRecoveryCutoffReached(): boolean {
    return recovery.currentPhase === 'disconnected'
  }

  async function createWithUnknownOutcomeRecovery(
    kind: 'terminal' | 'agent-session',
    invoke: (
      timeoutMs: number,
      reconcileExisting: boolean
    ) => Promise<RemoteAgentSessionLaunchResult>,
    environmentId: string,
    expectedLifecycleEpoch: number
  ): Promise<RemoteAgentSessionLaunchResult | null> {
    let retryAttempt = 0
    // Ordinary create needs proven v2 replay support before retrying unknown outcomes; structured operations already carry that proof.
    let idempotencySupported = kind === 'agent-session'
    let reconcileExisting =
      kind === 'agent-session'
        ? agentSessionRequiresHostAuthorityReplay
        : terminalCreateNeedsReconciliation
    // Share recovery’s full deadline so create reconciliation cannot abandon while UI remains recovering without work.
    let recoveryDeadlineAt: number | null = recovery.isActive
      ? Date.now() + REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS
      : null
    let lastError: unknown =
      terminalCreateUnknownOutcomeError ?? new Error('Remote terminal creation was cancelled.')
    while (
      !destroyed &&
      lifecycleEpoch === expectedLifecycleEpoch &&
      !terminalCreateRecoveryCutoffReached()
    ) {
      if (recoveryDeadlineAt !== null && recoveryDeadlineAt - Date.now() <= 0) {
        break
      }
      while (
        reconcileExisting &&
        !idempotencySupported &&
        !destroyed &&
        lifecycleEpoch === expectedLifecycleEpoch &&
        !terminalCreateRecoveryCutoffReached()
      ) {
        let status: RuntimeStatus
        try {
          const statusRemainingMs =
            recoveryDeadlineAt === null ? 5_000 : recoveryDeadlineAt - Date.now()
          if (statusRemainingMs <= 0) {
            break
          }
          status = await callRuntimeForEnvironment<RuntimeStatus>(
            environmentId,
            'status.get',
            undefined,
            Math.min(5_000, statusRemainingMs)
          )
        } catch (statusError) {
          const statusClientError = toRemoteRuntimeClientErrorLike(statusError)
          if (!isRecoverableRemoteRuntimeConnectionError(statusClientError)) {
            throw statusError
          }
          setAwaitingSshSignIn(false)
          const startsRecovery = recoveryDeadlineAt === null
          recoveryDeadlineAt ??= Date.now() + REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS
          if (startsRecovery && !recovery.isActive) {
            recovery.begin()
          }
          const statusDelayMs =
            TERMINAL_CREATE_RETRY_DELAYS_MS[
              Math.min(retryAttempt, TERMINAL_CREATE_RETRY_DELAYS_MS.length - 1)
            ]
          retryAttempt += 1
          const remainingMs = recoveryDeadlineAt - Date.now()
          if (
            remainingMs <= 0 ||
            terminalCreateRecoveryCutoffReached() ||
            !(await waitForTerminalCreateRetry(Math.min(statusDelayMs, remainingMs)))
          ) {
            break
          }
          continue
        }
        if (!status.capabilities?.includes(TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY)) {
          throw lastError
        }
        idempotencySupported = true
      }
      if (
        destroyed ||
        lifecycleEpoch !== expectedLifecycleEpoch ||
        (recoveryDeadlineAt !== null && recoveryDeadlineAt - Date.now() <= 0)
      ) {
        break
      }
      const createRemainingMs = recoveryDeadlineAt === null ? null : recoveryDeadlineAt - Date.now()
      if (createRemainingMs !== null && createRemainingMs <= 0) {
        break
      }
      try {
        return await invoke(Math.min(15_000, createRemainingMs ?? 15_000), reconcileExisting)
      } catch (error) {
        lastError = error
        const clientError = toRemoteRuntimeClientErrorLike(error)
        if (!isRecoverableRemoteRuntimeConnectionError(clientError)) {
          throw error
        }
        setAwaitingSshSignIn(false)
        if (kind === 'agent-session') {
          agentSessionRequiresHostAuthorityReplay = true
        } else {
          terminalCreateNeedsReconciliation = true
        }
        terminalCreateUnknownOutcomeError ??= error
        reconcileExisting = true
        const startsRecovery = recoveryDeadlineAt === null
        recoveryDeadlineAt ??= Date.now() + REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS
        if (startsRecovery && !recovery.isActive) {
          recovery.begin()
        }
        if (destroyed || lifecycleEpoch !== expectedLifecycleEpoch) {
          break
        }
        const remainingMs = recoveryDeadlineAt - Date.now()
        if (remainingMs <= 0 || terminalCreateRecoveryCutoffReached()) {
          break
        }
        const delayMs =
          TERMINAL_CREATE_RETRY_DELAYS_MS[
            Math.min(retryAttempt, TERMINAL_CREATE_RETRY_DELAYS_MS.length - 1)
          ]
        retryAttempt += 1
        if (!(await waitForTerminalCreateRetry(Math.min(delayMs, remainingMs)))) {
          break
        }
      }
    }
    return null
  }

  async function resolvePersistedHostPane(): Promise<PersistedHostPaneResolution> {
    if (!tabId || !leafId || !worktreeId) {
      return { kind: 'unavailable' }
    }
    const paneKey = `${tabId}:${leafId}`
    if (resolvePaneUnavailable) {
      return { kind: 'unavailable' }
    }
    let terminal: RuntimeTerminalResolvePane
    try {
      const resolved = await callRuntime<{ terminal: RuntimeTerminalResolvePane }>(
        'terminal.resolvePane',
        { paneKey, worktreeId }
      )
      terminal = resolved.terminal
    } catch (error) {
      const message = runtimeTerminalErrorMessage(error)
      if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
        resolvePaneUnavailable = true
        return { kind: 'unavailable' }
      }
      if (message.includes('terminal_not_found')) {
        // Why: the host's own pane registry answered, so this is removal evidence, not lost contact.
        return { kind: 'absent' }
      }
      if (message.includes('method_not_found')) {
        return { kind: 'unavailable' }
      }
      throw error
    }
    if (
      terminal.tabId !== tabId ||
      terminal.leafId !== leafId ||
      (terminal.worktreeId !== undefined && terminal.worktreeId !== worktreeId)
    ) {
      throw new Error('terminal_owner_mismatch')
    }
    if (terminal.worktreeId === undefined) {
      const worktree = toRuntimeWorktreeSelector(worktreeId)
      // Why: an inventory that started before resolvePane answered can predate this handle.
      const { snapshot: listed } = await listRemoteRuntimeSessionTabsAfterCurrentInFlight({
        environmentId: currentRuntimeEnvironmentId,
        worktreeId,
        load: async () => ({
          snapshot: await callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.list', {
            worktree
          })
        })
      })
      const exactLegacyOwner = getHostSessionTerminalSurfaces(listed, tabId, {
        matchRequestedLeaf: true
      }).some((surface) => surface.status === 'ready' && surface.terminal === terminal.handle)
      if (!exactLegacyOwner) {
        // Why: legacy resolvePane responses lack worktree identity; only the scoped session snapshot can authorize adoption.
        throw new Error('terminal_owner_mismatch')
      }
    }
    return { kind: 'resolved', terminal }
  }

  async function adoptResolvedHostPane(
    terminal: RuntimeTerminalResolvePane,
    options: { cols?: number; rows?: number; existingPtyId?: string },
    notifySpawn = true,
    expectedAttachGeneration?: number,
    expectedRecoveryEpoch?: number
  ): Promise<PtyConnectResult | undefined> {
    if (
      destroyed ||
      (expectedAttachGeneration !== undefined && expectedAttachGeneration !== attachGeneration)
    ) {
      return undefined
    }
    if (!notifySpawn) {
      rebindRemoteTerminalHandle(
        terminal.handle,
        terminal.incarnationId ?? null,
        remotePtyId ?? options.existingPtyId ?? null
      )
    } else {
      const previousPtyId = remotePtyId
      handle = terminal.handle
      remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
      unregisterShutdownHandlers(previousPtyId)
      registerShutdownHandlers(remotePtyId)
    }
    adoptExecutionMetadata(terminal)
    if (!remotePtyId) {
      return undefined
    }
    connected = true
    desiredViewport = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24
    }
    if (notifySpawn) {
      onPtySpawn?.(remotePtyId)
    }
    emitRecoveryState()
    try {
      await subscribeToHandle(expectedRecoveryEpoch)
    } catch (error) {
      if (recovery.hasOwnerRefresh) {
        throw error
      }
      if (!recoverAfterSubscribeFailure(error, terminal.handle, remotePtyId)) {
        throw error
      }
    }
    if (
      destroyed ||
      !connected ||
      !remotePtyId ||
      (expectedAttachGeneration !== undefined && expectedAttachGeneration !== attachGeneration)
    ) {
      return undefined
    }
    return {
      id: remotePtyId,
      replay: '',
      isReattach: true,
      ...(authoritativePtyIncarnationId ? { incarnationId: authoritativePtyIncarnationId } : {})
    }
  }

  function reconcilePaneOwner(
    options: { cols?: number; rows?: number; existingPtyId?: string },
    expectedLifecycle = lifecycleEpoch
  ): Promise<PtyConnectResult | undefined> {
    if (
      destroyed ||
      expectedLifecycle !== lifecycleEpoch ||
      recovery.currentPhase === 'disconnected'
    ) {
      return Promise.resolve(undefined)
    }
    const generation = attachGeneration
    const epoch = recovery.begin()
    const current = () =>
      !destroyed &&
      expectedLifecycle === lifecycleEpoch &&
      generation === attachGeneration &&
      recovery.isCurrent(epoch)
    const claim = recovery.claimOwnerRefresh(epoch, (nextEpoch) => {
      if (destroyed || expectedLifecycle !== lifecycleEpoch || generation !== attachGeneration) {
        return
      }
      if (nextEpoch === epoch) {
        void resolveOwner()
      } else {
        void reconcilePaneOwner(options, expectedLifecycle)
      }
    })
    if (!claim) {
      return Promise.resolve(undefined)
    }
    function exhaust(): void {
      if (!current()) {
        return
      }
      subscriptionGeneration += 1
      closeMultiplexedStream()
      connecting = false
      connected = false
      recovery.markDisconnected()
      surfaceErrorMessage(ownerChanged)
      emitRecoveryState(true)
    }
    async function resolveOwner(): Promise<void> {
      if (!current()) {
        return
      }
      holdUnsentPendingInput()
      closeMultiplexedStream()
      connected = false
      connecting = true
      try {
        const resolution = await resolvePersistedHostPane()
        if (!current()) {
          return
        }
        if (resolution.kind !== 'resolved') {
          exhaust()
          return
        }
        await adoptResolvedHostPane(resolution.terminal, options, false, generation, epoch)
      } catch (error) {
        if (!current()) {
          return
        }
        if (runtimeTerminalErrorMessage(error).includes(ownerChanged)) {
          exhaust()
        } else if (isRecoverablePaneBindingError(error)) {
          recovery.parkOwnerRefresh(epoch)
          connecting = false
          emitRecoveryState(true)
        } else {
          handleRemoteTerminalError(error)
        }
      }
    }
    if (claim.started) {
      void resolveOwner()
      emitRecoveryState(true)
    } else {
      exhaust()
    }
    return claim.promise
  }

  function recoverExpiredHostPane(): void {
    const expiredHandle = handle
    if (!expiredHandle || !tabId || !leafId || !worktreeId || recoveringPaneHandle) {
      return
    }
    recoveringPaneHandle = expiredHandle
    connected = false
    clearPendingViewportClaim()
    closeMultiplexedStream()
    const hostTabId = isWebTerminalSurfaceTabId(tabId) ? toHostSessionTabId(tabId) : tabId
    void callRuntime<{ terminal: RuntimeTerminalResolvePane }>('terminal.recoverPane', {
      paneKey: `${hostTabId}:${leafId}`,
      worktreeId,
      expectedTerminal: expiredHandle
    })
      .then(async ({ terminal }) => {
        if (destroyed || handle !== expiredHandle) {
          return
        }
        const previousIncarnationId = authoritativePtyIncarnationId
        adoptExecutionMetadata(terminal)
        const replacedPtyId = remotePtyId
        handle = terminal.handle
        remotePtyId = toRemoteRuntimePtyId(terminal.handle, currentRuntimeEnvironmentId)
        unregisterShutdownHandlers(replacedPtyId)
        registerShutdownHandlers(remotePtyId)
        connected = true
        if (
          replacedPtyId &&
          (replacedPtyId !== remotePtyId || previousIncarnationId !== authoritativePtyIncarnationId)
        ) {
          if (replacedPtyId !== remotePtyId) {
            replaceFitOverridePtyId(replacedPtyId, remotePtyId)
            replaceDriverPtyId(replacedPtyId, remotePtyId)
          }
          if (authoritativePtyIncarnationId) {
            onPtyRebind?.(remotePtyId, replacedPtyId, authoritativePtyIncarnationId)
          } else {
            onPtyRebind?.(remotePtyId, replacedPtyId)
          }
        }
        await subscribeToHandle()
      })
      .catch((error) => {
        if (!destroyed && handle === expiredHandle) {
          surfaceErrorMessage(runtimeTerminalErrorMessage(error))
        }
      })
      .finally(() => {
        if (recoveringPaneHandle === expiredHandle) {
          recoveringPaneHandle = null
        }
      })
  }

  async function closeRemoteTerminal(
    handleOverride?: string,
    environmentId = currentRuntimeEnvironmentId
  ): Promise<void> {
    const targetHandle = handleOverride ?? handle
    if (!targetHandle) {
      return
    }
    try {
      await callRuntimeForEnvironment(environmentId, 'terminal.close', { terminal: targetHandle })
    } catch {
      // Best-effort parity with local disconnect/kill.
    }
  }

  function recoveryBlocksIo(): boolean {
    return recovery.isActive || recovery.currentPhase === 'disconnected'
  }

  // Host subscribed ACK proves stream installation/input capability; snapshot transfer only paints, so typing need not wait.
  function subscriptionAcceptsInput(): boolean {
    return (
      inputReadySubscription === subscriptionGeneration &&
      handle !== null &&
      getCurrentMultiplexedStream(handle) !== null
    )
  }

  function inputBlocked(): boolean {
    return recoveryBlocksIo() && !subscriptionAcceptsInput()
  }

  // Hold typing for the known terminal during binding/recovery and through bounded disconnected grace (#25784).
  function shouldHoldInput(): boolean {
    if (destroyed || terminalEnded) {
      return false
    }
    if (handle === null) {
      return recoveryInputHold.isHoldingBeforeBind()
    }
    if (recovery.currentPhase === 'disconnected') {
      return !discardExpiredDisconnectedInput()
    }
    return (
      heldInputRelease?.waitingForValidation === true ||
      (recovery.isActive && !subscriptionAcceptsInput()) ||
      (connecting && !connected) ||
      recoveryInputHold.isHolding()
    )
  }

  function discardExpiredDisconnectedInput(): boolean {
    if (!disconnectedInputGrace.isExpired()) {
      return false
    }
    discardPendingInput()
    return true
  }

  function discardPendingInput(): void {
    heldInputRelease = null
    recoveryInputHold.discard()
    inputJournal.discard()
  }

  // Why: these bytes never reached a stream, so holding them for the reattach cannot duplicate them.
  function holdUnsentInput(text: string): void {
    if (shouldHoldInput()) {
      recoveryInputHold.enqueue(holdEndpoint(), text, 'driving')
    }
  }

  function holdUnsentPendingInput(): void {
    for (const segment of pendingClaimInput) {
      if (!segment.queryReply) {
        holdUnsentInput(segment.text)
      }
    }
    pendingClaimInput = []
    pendingClaimQueryReplyCount = 0
    inputBatcher.flush()
  }

  // Why: reserves this key's slot behind input still in size validation, which reaches the hold first.
  function holdAcceptedAfterValidation(
    data: string,
    inputKind: TerminalInputKind,
    options: AcceptedInputOptions | undefined
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let ran = false
      inputBatcher.enqueueAfterValidation(() => {
        ran = true
        inputBatcher.flush()
        resolve(
          shouldHoldInput()
            ? recoveryInputHold.enqueueAccepted(holdEndpoint(), data, inputKind, options)
            : sendInputAcceptedToRuntime(data, inputKind, options)
        )
      })
      // Why: a cleared batcher skips the reserved slot; settle instead of hanging the caller.
      void inputBatcher.drain().then(() => {
        if (!ran) {
          resolve(false)
        }
      })
    })
  }

  // Why: a host that acks input dedupes by sequence, so resending what it may already have is safe.
  function resumeSequencedInput(
    stream: RemoteRuntimeMultiplexedTerminal,
    boundHandle: string
  ): void {
    if (stream.acknowledgesInput()) {
      inputJournal.resume(stream, heldInputEndpoint(boundHandle))
    } else {
      // Why: without acks, delivery of earlier bytes is unknown; replaying could run them twice.
      inputJournal.discard()
    }
  }

  function sequencedInputTarget() {
    const boundHandle = handle
    if (destroyed || terminalEnded || !connected || !boundHandle || inputBlocked()) {
      return null
    }
    const stream = getCurrentMultiplexedStream(boundHandle)
    return stream?.acknowledgesInput() ? { stream, endpoint: heldInputEndpoint(boundHandle) } : null
  }

  function heldInputEndpoint(targetHandle: string) {
    return {
      handle: targetHandle,
      incarnationId: authoritativePtyIncarnationId
    }
  }

  // Unbound restored-screen typing stays scoped to its expected terminal until connect settles, never a replacement (#10065).
  function holdEndpoint(): RemoteRuntimeInputEndpoint | null {
    return handle && !recoveryInputHold.isHoldingBeforeBind() ? heldInputEndpoint(handle) : null
  }

  // Why: releases a stale hold first, so the hold check reads the handle that release left bound.
  function releaseThenShouldHold(inputKind: TerminalInputKind): boolean {
    if (recoveryInputHold.isHolding() && !recoveryInputHold.isHoldingBeforeBind()) {
      releaseHeldInput()
    }
    return inputKind !== 'query-reply' && shouldHoldInput()
  }

  // Why: only a connect naming this transport's own remote id restores a terminal typing may reach.
  function restoredInputEndpoint(sessionId: string | undefined): RemoteRuntimeInputEndpoint | null {
    const restoredHandle = sessionId ? getRemoteRuntimeTerminalHandle(sessionId) : null
    return restoredHandle &&
      toRemoteRuntimePtyId(restoredHandle, currentRuntimeEnvironmentId) === sessionId
      ? { handle: restoredHandle, incarnationId: null }
      : null
  }

  function releaseHeldInput(): void {
    const boundHandle = handle
    if (destroyed || terminalEnded || !boundHandle) {
      discardPendingInput()
      return
    }
    const stream = getCurrentMultiplexedStream(boundHandle)
    if (
      !connected ||
      inputBlocked() ||
      !(attachmentReady || subscriptionAcceptsInput()) ||
      !stream
    ) {
      return
    }
    if (heldInputRelease?.stream === stream) {
      return
    }
    if (!recoveryInputHold.isHolding()) {
      resumeSequencedInput(stream, boundHandle)
      return
    }
    const release = { stream, waitingForValidation: inputBatcher.hasPendingValidation() }
    heldInputRelease = release
    if (release.waitingForValidation) {
      const targetLifecycleEpoch = lifecycleEpoch
      void (async () => {
        do {
          await inputBatcher.drain()
        } while (heldInputRelease === release && inputBatcher.hasPendingValidation())
        if (heldInputRelease !== release) {
          return
        }
        release.waitingForValidation = false
        if (
          lifecycleEpoch === targetLifecycleEpoch &&
          handle === boundHandle &&
          getCurrentMultiplexedStream(boundHandle) === stream
        ) {
          releaseValidatedHeldInput(stream, boundHandle)
        } else {
          heldInputRelease = null
        }
      })()
      return
    }
    releaseValidatedHeldInput(stream, boundHandle)
  }

  function releaseValidatedHeldInput(
    stream: RemoteRuntimeMultiplexedTerminal,
    boundHandle: string
  ): void {
    const release = heldInputRelease
    if (
      destroyed ||
      terminalEnded ||
      !connected ||
      handle !== boundHandle ||
      inputBlocked() ||
      !(attachmentReady || subscriptionAcceptsInput())
    ) {
      heldInputRelease = null
      return
    }
    // Why: the debounce suffix belongs after the held prefix, never ahead of its replay.
    const pending = inputBatcher.takePending()
    if (pending) {
      recoveryInputHold.enqueue(holdEndpoint(), pending, 'driving')
    }
    // Why first: journaled bytes were typed before anything in the hold.
    resumeSequencedInput(stream, boundHandle)
    const active = recoveryInputHold.release(heldInputEndpoint(boundHandle), {
      isCurrent: () => connected && handle === boundHandle && !inputBlocked(),
      // Why: the 1 Mi-code-unit hold fits the 16 MiB ceiling; one journal batch survives a mid-send outage.
      sendInput: (data) => {
        const current = getCurrentMultiplexedStream(boundHandle)
        if (!current?.acknowledgesInput()) {
          return sendInputNow(data)
        }
        inputJournal.send(current, heldInputEndpoint(boundHandle), inputSegments(data))
        return true
      },
      sendInputImmediate: (data) => sendInputImmediateNow(data),
      sendInputAccepted: sendInputAcceptedToRuntime,
      continuesAfterFailedWrite: () =>
        getCurrentMultiplexedStream(boundHandle)?.acknowledgesInput() === true
    })
    const settle = (): void => {
      if (heldInputRelease === release) {
        heldInputRelease = null
      }
    }
    if (active) {
      void active.done.then(settle, settle)
    } else {
      settle()
    }
  }

  async function sendInputAcceptedToRuntime(
    data: string,
    _inputKind?: TerminalInputKind,
    options?: AcceptedInputOptions
  ): Promise<boolean> {
    const signal = options?.signal
    const targetHandle = handle
    if (!connected || !targetHandle || inputBlocked() || signal?.aborted) {
      return false
    }
    if (!data) {
      return true
    }
    await inputBatcher.drain()
    if (!connected || handle !== targetHandle || inputBlocked()) {
      return false
    }
    if (pendingViewportClaim && !getCurrentMultiplexedStream(targetHandle)) {
      const ready = await new Promise<boolean>((resolve) => {
        viewportClaimReadyWaiters.add(resolve)
      })
      if (!ready || !connected || handle !== targetHandle) {
        return false
      }
    }
    // Why: normal sendInput may be awaiting size validation; drain it before acknowledged writes so terminal bytes stay ordered.
    const pendingTyping = inputBatcher.takePending()
    const text = `${pendingTyping}${data}`
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(text)
      if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
        return false
      }
    } catch {
      return false
    }
    if (signal?.aborted) {
      return false
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (stream?.acknowledgesInput()) {
      return sendSequencedInputAccepted(stream, targetHandle, pendingTyping, data, signal)
    }
    try {
      for (const chunk of iterateTerminalInputChunks(text)) {
        if (!connected || handle !== targetHandle || inputBlocked() || signal?.aborted) {
          return false
        }
        // Why: acknowledged sends order behind pending debounce text but must not collapse large paste back into one remote RPC.
        const result = await trackTerminalSend(
          targetHandle,
          callRuntime<{ send: RuntimeTerminalSend }>('terminal.send', {
            terminal: targetHandle,
            text: chunk,
            client: { id: clientId, type: 'desktop' },
            ...(desiredViewport ? { viewport: desiredViewport, claimViewport: true as const } : {})
          })
        )
        if (result.send.accepted !== true) {
          return false
        }
      }
      return true
    } catch (error) {
      // Why: stale-handle errors must retire the mirror (recoverable via next snapshot), not dead-end in a red xterm banner (#7718).
      if (handle === targetHandle) {
        handleRemoteTerminalError(error)
      }
      return false
    }
  }

  // Why: accepted keys (Ctrl+C, Escape, paste) share the typing sequence, so an outage replays them in place.
  function sendSequencedInputAccepted(
    stream: RemoteRuntimeMultiplexedTerminal,
    targetHandle: string,
    pendingTyping: string,
    text: string,
    signal: AbortSignal | undefined
  ): Promise<boolean> {
    const endpoint = heldInputEndpoint(targetHandle)
    // Why its own sequences: aborting the caller's bytes must not cancel typing batched ahead of them.
    inputJournal.send(stream, endpoint, inputSegments(pendingTyping))
    const seqs = inputJournal.send(stream, endpoint, inputSegments(text))
    const acknowledged = seqs.map((seq) => inputJournal.whenAcknowledged(seq))
    signal?.addEventListener('abort', () => seqs.forEach((seq) => inputJournal.cancel(seq)), {
      once: true
    })
    return Promise.all(acknowledged).then((results) => results.every(Boolean))
  }

  function notifyWriteUnavailable(): void {
    if (!destroyed) {
      storedCallbacks.onWriteUnavailable?.()
    }
  }

  // One-shot sends bypass the ACK journal; report their pending/refused input so remount can disclose possible loss.
  let fallbackSendsInFlight = 0
  let fallbackInputRefused = false
  const sendUnacknowledgedInput = (text: string, queryReply = false): boolean => {
    const targetHandle = handle
    const targetLifecycleEpoch = lifecycleEpoch
    if (!connected || !targetHandle || inputBlocked()) {
      return false
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (
      !queryReply &&
      (heldInputRelease?.waitingForValidation || (!stream && recoveryInputHold.isHolding()))
    ) {
      return recoveryInputHold.enqueue(holdEndpoint(), text, 'driving')
    }
    if (stream?.acknowledgesInput()) {
      // Why true even if unsent: a failed write closes this stream, and the reattach replays the journal.
      inputJournal.send(stream, heldInputEndpoint(targetHandle), [{ text, queryReply }])
      return true
    }
    if (stream?.sendInput(text)) {
      return true
    }
    if (pendingViewportClaim) {
      // Why: a claim during subscribe/reconnect has no stream record yet; hold its input so the stream emits claim+input in one order.
      queuePendingClaimInput(text, queryReply)
      return true
    }
    fallbackSendsInFlight += 1
    void trackTerminalSend(
      targetHandle,
      callRuntime<{ send: RuntimeTerminalSend }>('terminal.send', {
        terminal: targetHandle,
        text,
        client: { id: clientId, type: 'desktop' },
        ...(desiredViewport ? { viewport: desiredViewport, claimViewport: true as const } : {})
      })
    )
      .then((result) => {
        fallbackInputRefused = result.send.accepted !== true
        if (
          connected &&
          lifecycleEpoch === targetLifecycleEpoch &&
          handle === targetHandle &&
          result.send.accepted !== true
        ) {
          notifyWriteUnavailable()
        }
      })
      .catch((error) => {
        if (lifecycleEpoch !== targetLifecycleEpoch || handle !== targetHandle) {
          return
        }
        if (runtimeTerminalErrorMessage(error).includes('terminal_not_writable')) {
          fallbackInputRefused = true
          notifyWriteUnavailable()
        } else {
          handleRemoteTerminalError(error)
        }
      })
      .finally(() => {
        fallbackSendsInFlight -= 1
      })
    return true
  }

  const inputBatcher = createRemoteRuntimePtyTextBatcher(REMOTE_TERMINAL_INPUT_FLUSH_MS, (text) => {
    if (!sendUnacknowledgedInput(text)) {
      holdUnsentInput(text)
    }
  })

  function deferViewportForRecovery(claim: boolean): void {
    // Why: the replay sends the latest viewport; an older queued batch flushing after it would win.
    viewportBatcher.clear()
    recoveryDeferredViewport = claim ? 'claim' : (recoveryDeferredViewport ?? 'resize')
  }

  // Why before input: typing released at the ack must land at this viewer's grid, not a peer's.
  function replayRecoveryDeferredViewport(stream: RemoteRuntimeMultiplexedTerminal): void {
    const deferred = recoveryDeferredViewport
    recoveryDeferredViewport = null
    if (!deferred || !desiredViewport) {
      return
    }
    const { cols, rows } = desiredViewport
    if (deferred === 'claim' && isUnconfirmedClaim(stream, cols, rows)) {
      return
    }
    const sent =
      deferred === 'resize' ? stream.resize(cols, rows) : stream.claimViewport(cols, rows)
    if (!sent) {
      // Why: a failed write starts another recovery, whose stream must still carry this intent.
      deferViewportForRecovery(deferred === 'claim')
    } else if (deferred === 'claim') {
      unconfirmedClaim = { stream, cols, rows, sentAt: Date.now() }
    }
  }

  function sendViewportUpdate(cols: number, rows: number, claim = false): void {
    const targetHandle = handle
    if (!connected || !targetHandle) {
      return
    }
    if (inputBlocked()) {
      deferViewportForRecovery(claim)
      return
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (claim && stream && isUnconfirmedClaim(stream, cols, rows)) {
      // Why: a reveal's resume and its layout observer each claim the same grid one frame apart.
      flushPendingClaimInput(stream)
      return
    }
    if (claim ? stream?.claimViewport(cols, rows) : stream?.resize(cols, rows)) {
      if (claim && stream) {
        unconfirmedClaim = { stream, cols, rows, sentAt: Date.now() }
        flushPendingClaimInput(stream)
      } else if (unconfirmedClaim && !isUnconfirmedClaim(unconfirmedClaim.stream, cols, rows)) {
        // Why: the host now holds a different grid, so a later claim of the old one is new again.
        unconfirmedClaim = null
      }
      return
    }
    if (claim) {
      pendingViewportClaim = true
    }
    void callRuntime('terminal.updateViewport', {
      terminal: targetHandle,
      client: { id: clientId, type: 'desktop' },
      viewport: { cols, rows },
      ...(claim ? { claim: true } : {})
    }).catch(() => {})
  }

  // The host answers a claim with a fit-override event; until then a repeat of the same grid is a no-op.
  let unconfirmedClaim: {
    stream: RemoteRuntimeMultiplexedTerminal
    cols: number
    rows: number
    sentAt: number
  } | null = null
  function isUnconfirmedClaim(
    stream: RemoteRuntimeMultiplexedTerminal,
    cols: number,
    rows: number
  ): boolean {
    return (
      unconfirmedClaim !== null &&
      unconfirmedClaim.stream === stream &&
      unconfirmedClaim.cols === cols &&
      unconfirmedClaim.rows === rows &&
      // Why bounded: a claim the host dropped must stay retryable by the next activity.
      Date.now() - unconfirmedClaim.sentAt < REMOTE_VIEWPORT_CLAIM_CONFIRM_WINDOW_MS
    )
  }

  const viewportBatcher = createRemoteRuntimeViewportBatcher(
    REMOTE_TERMINAL_VIEWPORT_FLUSH_MS,
    sendViewportUpdate
  )

  function rememberViewport(cols: number, rows: number): void {
    desiredViewport = { cols, rows }
  }

  function getCurrentMultiplexedStream(
    targetHandle: string
  ): RemoteRuntimeMultiplexedTerminal | null {
    return multiplexedStreamHandle === targetHandle ? multiplexedStream : null
  }

  function closeMultiplexedStream(): void {
    multiplexedStream?.close()
    multiplexedStream = null
    multiplexedStreamHandle = null
    setAttachmentReady(false)
  }

  function clearPublishedHandleWait(): void {
    stopWaitingForPublishedHandle?.()
    stopWaitingForPublishedHandle = null
    publishedHandleWaitEpoch = null
    stopWatchingHostRebind?.()
    stopWatchingHostRebind = null
  }

  function isCurrentRemoteTerminal(targetHandle: string, targetPtyId: string | null): boolean {
    return (
      !destroyed &&
      connected &&
      handle === targetHandle &&
      remotePtyId === targetPtyId &&
      targetPtyId !== null
    )
  }

  function retireRemoteTerminalId(exitCode?: number): void {
    discardPendingInput()
    recovery.cancel()
    resetRecoveryReplacementPolicy()
    resetSameHandleEndReuse()
    connected = false
    connecting = false
    terminalEnded = true
    clearPublishedHandleWait()
    clearPendingViewportClaim()
    const stalePtyId = remotePtyId
    unregisterShutdownHandlers(stalePtyId)
    handle = null
    remotePtyId = null
    closeMultiplexedStream()
    setAttachmentUnavailable()
    emitRecoveryState()
    if (stalePtyId) {
      if (exitCode === undefined) {
        onPtyExit?.(stalePtyId)
      } else {
        onPtyExit?.(stalePtyId, exitCode)
      }
    }
  }

  // Only host-recorded exit settles restored panes; stale or PTY-less refusal proves no death and must preserve recovery (#31539).
  function retireIfHostRecordsExit(targetHandle: string, exitedPtyId: string | null): void {
    if (hostExitProbeHandle === targetHandle) {
      return
    }
    hostExitProbeHandle = targetHandle
    const probeLifecycle = lifecycleEpoch
    // Why: an exit ends the pane only while it is still the pane's process, even under one handle.
    const stillHolds = (exited: RuntimeTerminalShow): boolean =>
      !destroyed &&
      !terminalEnded &&
      probeLifecycle === lifecycleEpoch &&
      handle === targetHandle &&
      sameWhenBothKnown(authoritativePtyIncarnationId, exited.incarnationId)
    let rebindWatch = startHostRebindWatch()
    void (async () => {
      const { terminal } = await callRuntime<{ terminal?: RuntimeTerminalShow }>('terminal.show', {
        terminal: targetHandle
      })
      if (!terminal || !hostRecordsTerminalExit(terminal) || !stillHolds(terminal)) {
        return
      }
      if (
        !(await hostPaneStillHoldsExitedTerminal(targetHandle, terminal)) ||
        !stillHolds(terminal)
      ) {
        return
      }
      remotePtyId ??= exitedPtyId
      const exitedIncarnationId = terminal.incarnationId ?? authoritativePtyIncarnationId
      const cause = terminal.exitCause
      retireRemoteTerminalId(cause?.kind === 'exited' ? cause.exitCode : undefined)
      if (rebindWatch && !destroyed) {
        stopWatchingHostRebind = rebindWatch.dispose
        const armed = rebindWatch
        rebindWatch = null
        armed.arm(targetHandle, exitedIncarnationId)
      }
    })()
      .catch(() => {})
      .finally(() => {
        rebindWatch?.dispose()
        if (hostExitProbeHandle === targetHandle) {
          hostExitProbeHandle = null
        }
      })
  }

  // Why: a restart's new process can land just after the probe read the old one's exit (#31968).
  function startHostRebindWatch(): HostRebindAfterExitWatch | null {
    if (destroyed || !onHostReboundExitedPty || !worktreeId || !tabId || !leafId) {
      return null
    }
    if (!isWebTerminalSurfaceTabId(tabId)) {
      return null
    }
    const watchLifecycle = lifecycleEpoch
    const environmentId = currentRuntimeEnvironmentId
    return watchHostRebindAfterExit(
      { environmentId, worktreeId, hostTabId: toHostSessionTabId(tabId), leafId },
      (nextHandle) => {
        stopWatchingHostRebind = null
        if (!destroyed && terminalEnded && watchLifecycle === lifecycleEpoch) {
          onHostReboundExitedPty(toRemoteRuntimePtyId(nextHandle, environmentId))
        }
      }
    )
  }

  async function hostPaneStillHoldsExitedTerminal(
    targetHandle: string,
    exited: Pick<RuntimeTerminalShow, 'ptyId' | 'incarnationId'>
  ): Promise<boolean> {
    if (!tabId || !leafId || !worktreeId) {
      return true
    }
    const paneTabId = isWebTerminalSurfaceTabId(tabId) ? toHostSessionTabId(tabId) : tabId
    try {
      if (isWebTerminalSurfaceTabId(tabId)) {
        const { snapshot } = await listRemoteRuntimeSessionTabsAfterCurrentInFlight({
          environmentId: currentRuntimeEnvironmentId,
          worktreeId,
          load: async () => ({
            snapshot: await callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.list', {
              worktree: toRuntimeWorktreeSelector(worktreeId)
            })
          })
        })
        // Why: a stopped surface the host still publishes is re-created on activation, not ended.
        const surfaces = getHostSessionTerminalSurfaces(snapshot, paneTabId, {
          matchRequestedLeaf: true
        })
        if (surfaces.some((surface) => surface.terminal !== targetHandle)) {
          return false
        }
      }
      const resolved = await callRuntime<{ terminal?: RuntimeTerminalResolvePane }>(
        'terminal.resolvePane',
        { paneKey: `${paneTabId}:${leafId}`, worktreeId }
      )
      const pane = resolved.terminal
      return (
        pane?.handle === targetHandle &&
        sameWhenBothKnown(pane.ptyId, exited.ptyId) &&
        sameWhenBothKnown(pane.incarnationId, exited.incarnationId)
      )
    } catch (error) {
      // Why: the host's own pane registry answering "no such pane" means nothing replaced it.
      return runtimeTerminalErrorMessage(error).includes('terminal_not_found')
    }
  }

  function rebindRemoteTerminalHandle(
    nextHandle: string,
    nextIncarnationId: string | null = null,
    replacedPtyId: string | null = remotePtyId
  ): void {
    clearPublishedHandleWait()
    const nextPtyId = toRemoteRuntimePtyId(nextHandle, currentRuntimeEnvironmentId)
    const changed =
      replacedPtyId !== nextPtyId ||
      (authoritativePtyIncarnationId !== null &&
        nextIncarnationId !== null &&
        authoritativePtyIncarnationId !== nextIncarnationId)
    // A newly learned stamp is not evidence that held typing belongs to another process.
    if (changed) {
      discardPendingInput()
    }
    unregisterShutdownHandlers(replacedPtyId)
    handle = nextHandle
    remotePtyId = toRemoteRuntimePtyId(nextHandle, currentRuntimeEnvironmentId)
    authoritativePtyIncarnationId = nextIncarnationId
    resetRecoveryReplacementPolicy()
    resetSameHandleEndReuse()
    registerShutdownHandlers(remotePtyId)
    setAttachmentReady(false)
    // Why: host handle rotation preserves the pane generation; only the store identity changes, not spawn/exit semantics.
    if (replacedPtyId && (changed || nextIncarnationId !== null)) {
      if (replacedPtyId !== remotePtyId) {
        replaceFitOverridePtyId(replacedPtyId, remotePtyId)
        replaceDriverPtyId(replacedPtyId, remotePtyId)
      }
      if (nextIncarnationId) {
        onPtyRebind?.(remotePtyId, replacedPtyId, nextIncarnationId)
      } else {
        onPtyRebind?.(remotePtyId, replacedPtyId)
      }
    }
  }

  function waitForPublishedHostSessionHandle(hostTabId: string, previousHandle: string): void {
    if (!worktreeId) {
      return
    }
    clearPublishedHandleWait()
    stopWaitingForPublishedHandle = subscribeAcceptedWebSessionTerminalHandle(
      {
        environmentId: currentRuntimeEnvironmentId,
        worktreeId,
        hostTabId,
        leafId
      },
      (update) => {
        if (destroyed || !connected || handle !== previousHandle) {
          clearPublishedHandleWait()
          return
        }
        if (!update.surfacePresent) {
          // Unpublished surfaces may reflect runtime restart; inventory absence alone cannot prove process exit.
          retireRemoteTerminalId(-1)
          return
        }
        if (!update.terminalHandle) {
          return
        }
        if (update.terminalHandle === previousHandle) {
          if (getCurrentMultiplexedStream(previousHandle)) {
            return
          }
          if (!autoRecoveryWindowSpent) {
            // Why: a published surface is the evidence a parked wait (not a scheduled backoff) is waiting for, unless it needs a replacement handle.
            if (
              recovery.currentPhase === 'recovering' &&
              getRecoveryReplacementPolicy(previousHandle) !== 'require-replacement'
            ) {
              recovery.retryNow()
            }
            return
          }
          // After deadline, renewed surface publication permits one fenced-handle reattach per spent window, not one per snapshot.
          autoRecoveryWindowSpent = false
          const reattachEpoch = recovery.begin()
          clearPublishedHandleWait()
          const reusedPtyId = remotePtyId
          void subscribeToHandle(reattachEpoch, true).catch((error) => {
            if (!recoverAfterSubscribeFailure(error, previousHandle, reusedPtyId)) {
              handleRemoteTerminalError(error)
            }
          })
          return
        }
        if (recovery.currentPhase === 'disconnected') {
          // Why: without a live epoch a failed resubscribe is swallowed as already-latched, leaving a pane with no handle and no way back.
          recovery.begin()
        }
        rebindRemoteTerminalHandle(update.terminalHandle)
        const reboundHandle = handle
        const reboundPtyId = remotePtyId
        void subscribeToHandle().catch((error) => {
          if (reboundHandle && !recoverAfterSubscribeFailure(error, reboundHandle, reboundPtyId)) {
            handleRemoteTerminalError(error)
          }
        })
      }
    )
  }

  function handleRemoteTerminalError(error: unknown): void {
    const message = runtimeTerminalErrorMessage(error)
    if (message.includes(ownerChanged)) {
      void reconcilePaneOwner(desiredViewport ?? {})
      return
    }
    if (message === REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE) {
      // Why: an oversized initial snapshot is skipped but live output keeps flowing — informational, not fatal.
      return
    }
    if (isRemoteTerminalStaleMessage(message)) {
      if (tabId && leafId && worktreeId) {
        // Why: reconnect can re-mint a pane handle while its host coordinates live; keep xterm state mounted while re-resolving.
        const refusedHandle = handle
        closeMultiplexedStream()
        recoveryCause = 'stream-ended'
        scheduleResubscribeAfterTransportClose('require-replacement')
        if (refusedHandle) {
          retireIfHostRecordsExit(refusedHandle, remotePtyId)
        }
      } else {
        // Unreplaced stale handles prove attachment loss, not process death.
        retireRemoteTerminalId(-1)
      }
      return
    }
    if (isRemoteTerminalGoneMessage(message)) {
      // Why: an explicit terminal-gone response is lifecycle evidence, unlike a replaceable stale handle seen during reconnect.
      retireRemoteTerminalId()
      return
    }
    if (message.includes('no_connected_pty')) {
      // Host window mount timeouts prove no exit; back off and resubscribe so the host can mount the pane.
      const refusedHandle = handle
      closeMultiplexedStream()
      scheduleResubscribeAfterBackoff()
      if (refusedHandle) {
        retireIfHostRecordsExit(refusedHandle, remotePtyId)
      }
      return
    }
    if (isSshSessionGoneError(message)) {
      // Only the HUB can recover expired SSH panes. Exclude live-owner mismatch: client-local fallback or bare expiry matching could resume a second agent on one transcript.
      recoverExpiredHostPane()
      return
    }
    const clientError = toRemoteRuntimeClientErrorLike(error)
    if (isRuntimeRpcQueueOverloadError(clientError)) {
      scheduleResubscribeAfterBackoff()
      return
    }
    if (isRecoverablePaneBindingError(error)) {
      // Why: a partition is attachment state, not a terminal failure; keep the red error surface for actionable fatal errors.
      scheduleResubscribeAfterTransportClose()
      return
    }
    connecting = false
    if (recovery.hasOwnerRefresh) {
      recovery.markDisconnected()
    }
    discardPendingInput()
    emitRecoveryState()
    surfaceErrorMessage(message)
  }

  function recoverAfterSubscribeFailure(
    error: unknown,
    targetHandle: string,
    targetPtyId: string | null
  ): boolean {
    if (!isCurrentRemoteTerminal(targetHandle, targetPtyId)) {
      return true
    }
    if (multiplexedStreamHandle !== targetHandle) {
      closeMultiplexedStream()
    }
    clearPendingViewportClaim()
    if (!isRecoverablePaneBindingError(error)) {
      return false
    }
    if (recovery.currentPhase === 'disconnected') {
      parkResubscribeAfterDeadline(targetHandle)
      return true
    }
    scheduleResubscribeAfterTransportClose()
    return true
  }

  // Late recoverable failure after deadline must leave a parked retry for online/resume, matching connect recovery (#9092).
  function parkResubscribeAfterDeadline(targetHandle: string): void {
    recovery.parkRetryAfterDeadline((nextEpoch) =>
      scheduleResubscribeAfterTransportClose(getRecoveryReplacementPolicy(targetHandle), nextEpoch)
    )
  }

  // Re-resolve after loss because reminted handles can point stale closures at a different PTY (#7718).
  async function resubscribeAfterTransportClose(
    previousHandle: string,
    replacementPolicy: HostHandleReplacementPolicy,
    recoveryEpoch: number
  ): Promise<void> {
    if (tabId && isWebTerminalSurfaceTabId(tabId)) {
      const hostTabId = toHostSessionTabId(tabId)
      const nextHandle = await waitForResubscribeHostSessionHandle(
        hostTabId,
        previousHandle,
        replacementPolicy,
        recoveryEpoch
      )
      if (destroyed || !connected || handle !== previousHandle) {
        return
      }
      const retryResubscribe = (nextEpoch: number): void => {
        // Why: a retry is a fresh attempt, not a repeated stale send, so it takes over this epoch's snapshot wait.
        clearPublishedHandleWait()
        scheduleResubscribeAfterTransportClose(
          handle ? getRecoveryReplacementPolicy(handle) : 'reuse',
          nextEpoch
        )
      }
      if (!recovery.isCurrent(recoveryEpoch)) {
        if (nextHandle === undefined && recovery.ownsEpoch(recoveryEpoch)) {
          // Why: an attempt still in flight when the deadline latched must stay revivable by online/resume.
          recovery.parkRetryAfterDeadline(retryResubscribe)
        }
        return
      }
      if (nextHandle === undefined) {
        const effectivePolicy = stricterReplacementPolicy(
          replacementPolicy,
          getRecoveryReplacementPolicy(previousHandle)
        )
        if (effectivePolicy === 'require-replacement') {
          // Why: re-polling cannot mint a replacement for a stale handle; park for the host's published one or online/resume/reconnect.
          recovery.parkRetryForExternalTrigger(recoveryEpoch, retryResubscribe)
          return
        }
        // Unknown liveness needs scheduled backoff; healthy links may never emit online/resume to revive event-only parking (#27178).
        recovery.schedule(recoveryEpoch, retryResubscribe)
        return
      }
      if (!nextHandle) {
        // Retire attachment quietly on unpublished surface, preserving process-unknown tab state until authoritative snapshots settle it.
        retireRemoteTerminalId(-1)
        return
      }
      const effectivePolicy = stricterReplacementPolicy(
        replacementPolicy,
        getRecoveryReplacementPolicy(previousHandle)
      )
      // Why: a stale error can strengthen policy after inventory returns but before this continuation runs.
      if (effectivePolicy === 'require-replacement' && nextHandle === previousHandle) {
        return
      }
      if (nextHandle !== previousHandle) {
        rebindRemoteTerminalHandle(nextHandle)
      }
      clearPublishedHandleWait()
      await subscribeToHandle(
        recoveryEpoch,
        nextHandle === previousHandle && effectivePolicy === 'prefer-replacement'
      )
      return
    } else if (tabId && leafId && worktreeId) {
      const resolution = await resolvePersistedHostPane()
      const resolved = resolution.kind === 'resolved' ? resolution.terminal : null
      if (
        destroyed ||
        !connected ||
        handle !== previousHandle ||
        !recovery.isCurrent(recoveryEpoch)
      ) {
        return
      }
      const effectivePolicy = stricterReplacementPolicy(
        replacementPolicy,
        getRecoveryReplacementPolicy(previousHandle)
      )
      if (
        !resolved ||
        (effectivePolicy === 'require-replacement' && resolved.handle === previousHandle)
      ) {
        // A failed pane resolution leaves process liveness unknown.
        retireRemoteTerminalId(-1)
        return
      }
      if (resolved.handle !== previousHandle) {
        adoptExecutionMetadata(resolved)
        rebindRemoteTerminalHandle(resolved.handle, resolved.incarnationId ?? null)
      }
      clearPublishedHandleWait()
      await subscribeToHandle(
        recoveryEpoch,
        resolved.handle === previousHandle && effectivePolicy === 'prefer-replacement'
      )
      return
    }
    clearPublishedHandleWait()
    await subscribeToHandle(recoveryEpoch)
  }

  function scheduleResubscribeAfterTransportClose(
    replacementPolicy: HostHandleReplacementPolicy = 'reuse',
    requestedRecoveryEpoch?: number
  ): void {
    if (destroyed || !connected || !handle) {
      return
    }
    const recoveryWasActive = recovery.isActive
    const recoveryEpoch = requestedRecoveryEpoch ?? recovery.begin()
    if (!recovery.isCurrent(recoveryEpoch)) {
      return
    }
    if (!recoveryWasActive) {
      // Why: queued bytes never reached the dead stream, so they are known undelivered; hold them, never drop them.
      holdUnsentPendingInput()
      viewportBatcher.clear()
      clearPendingViewportClaim()
    }
    strengthenRecoveryReplacementPolicy(handle, replacementPolicy)
    if (
      replacementPolicy === 'require-replacement' &&
      stopWaitingForPublishedHandle &&
      // Why: only the epoch that handed recovery to accepted snapshots is blocked; a newer epoch is a fresh attempt, not a repeated stale send.
      publishedHandleWaitEpoch === recoveryEpoch
    ) {
      return
    }
    if (resubscribeEpoch === recoveryEpoch) {
      // Why: concurrent stale errors belong to their own handle; don't carry an old handle's replacement requirement onto its successor.
      if (resubscribeRequestedHandle !== handle) {
        resubscribeRequestedHandle = handle
        resubscribeRequestedReplacementPolicy = replacementPolicy
      } else {
        resubscribeRequestedReplacementPolicy = stricterReplacementPolicy(
          resubscribeRequestedReplacementPolicy,
          replacementPolicy
        )
      }
      return
    }
    const resubscribeHandle = handle
    clearPublishedHandleWait()
    if (tabId && isWebTerminalSurfaceTabId(tabId)) {
      // Why: subscribe before polling so a fresh host snapshot can't land in the gap between the inventory loop and its event-driven fallback.
      waitForPublishedHostSessionHandle(toHostSessionTabId(tabId), resubscribeHandle)
      publishedHandleWaitEpoch = recoveryEpoch
    }
    resubscribeEpoch = recoveryEpoch
    resubscribeRequestedHandle = null
    resubscribeRequestedReplacementPolicy = 'reuse'
    let retryScheduled = false
    void resubscribeAfterTransportClose(resubscribeHandle, replacementPolicy, recoveryEpoch)
      .catch((error) => {
        if (
          !destroyed &&
          connected &&
          handle &&
          recovery.currentPhase === 'disconnected' &&
          recovery.ownsEpoch(recoveryEpoch) &&
          isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
        ) {
          parkResubscribeAfterDeadline(handle)
          return
        }
        if (!destroyed && connected && handle && recovery.isCurrent(recoveryEpoch)) {
          clearPendingViewportClaim()
          if (isRecoverablePaneBindingError(error)) {
            retryScheduled = recovery.schedule(recoveryEpoch, (nextEpoch) => {
              const currentReplacementPolicy = handle
                ? getRecoveryReplacementPolicy(handle)
                : 'reuse'
              scheduleResubscribeAfterTransportClose(currentReplacementPolicy, nextEpoch)
            })
          } else {
            if (!runtimeTerminalErrorMessage(error).includes(ownerChanged)) {
              recovery.markDisconnected()
            }
            // Central error routing preserves stale/gone/SSH-expired lifecycle handling; direct surfacing would bypass recovery.
            handleRemoteTerminalError(error)
          }
        }
      })
      .finally(() => {
        if (resubscribeEpoch !== recoveryEpoch) {
          return
        }
        resubscribeEpoch = null
        const pendingHandle = resubscribeRequestedHandle
        const pendingReplacementPolicy = resubscribeRequestedReplacementPolicy
        resubscribeRequestedHandle = null
        resubscribeRequestedReplacementPolicy = 'reuse'
        if (
          !retryScheduled &&
          recovery.isCurrent(recoveryEpoch) &&
          !stopWaitingForPublishedHandle &&
          pendingHandle &&
          pendingHandle === handle &&
          !getCurrentMultiplexedStream(pendingHandle)
        ) {
          scheduleResubscribeAfterTransportClose(pendingReplacementPolicy)
        }
      })
  }

  function scheduleResubscribeAfterBackoff(
    replacementPolicy: HostHandleReplacementPolicy = 'reuse',
    delayMs?: number
  ): void {
    if (destroyed || !connected || !handle) {
      return
    }
    const recoveryWasActive = recovery.isActive
    const recoveryEpoch = recovery.begin()
    if (!recoveryWasActive) {
      holdUnsentPendingInput()
      viewportBatcher.clear()
      clearPendingViewportClaim()
    }
    recovery.schedule(
      recoveryEpoch,
      (nextEpoch) => {
        scheduleResubscribeAfterTransportClose(replacementPolicy, nextEpoch)
      },
      delayMs
    )
  }

  async function subscribeToHandle(
    expectedRecoveryEpoch?: number,
    sameHandleEndRecovery = false
  ): Promise<void> {
    if (!handle) {
      return
    }
    const subscribedHandle = handle
    const subscribedPtyId = remotePtyId
    const generation = ++subscriptionGeneration
    const recoveryEpoch =
      expectedRecoveryEpoch ?? (recovery.isActive ? recovery.currentEpoch : undefined)
    setAttachmentReady(false)
    let transportClosed = false
    let subscriptionAttached = false
    let subscriptionSnapshotHadContent = false
    // Why: the ack can arrive before subscribeTerminal resolves; install replays in that order.
    let installedStream: RemoteRuntimeMultiplexedTerminal | null = null
    // Why: viewport handed to subscribe; a resize during the round-trip falls back to the refresh-only one-shot RPC, replayed through the stream below once current.
    const subscribedViewport = desiredViewport
    const isCurrentSubscription = (): boolean =>
      !transportClosed &&
      generation === subscriptionGeneration &&
      (recoveryEpoch === undefined ||
        recovery.isCurrent(recoveryEpoch) ||
        (subscriptionAttached && recovery.ownsEpoch(recoveryEpoch))) &&
      isCurrentRemoteTerminal(subscribedHandle, subscribedPtyId)
    if (currentPaneRevision() !== getRuntimeEnvironmentRevision(currentRuntimeEnvironmentId)) {
      // Why local: the shared stream would subscribe on a pairing not proven to be this pane's machine.
      throw runtimeEnvironmentPairingChangedError()
    }
    const nextStream = await getRemoteRuntimeTerminalMultiplexer(
      currentRuntimeEnvironmentId
    ).subscribeTerminal({
      terminal: subscribedHandle,
      client: { id: clientId, type: 'desktop' },
      viewport: subscribedViewport ?? undefined,
      inputSessionId: inputJournal.sessionId,
      callbacks: {
        onData: (data, meta) => {
          if (isCurrentSubscription()) {
            if (subscribedPtyId && bufferPtyShutdownData(subscribedPtyId, data, meta)) {
              return
            }
            shutdownDataHandler(data, meta)
          }
        },
        onSnapshot: (data, meta) => {
          // Why: an empty snapshot can still carry a pending mid-escape tail that must replay so the next live chunk completes it.
          if ((data || meta?.pendingEscapeTailAnsi) && isCurrentSubscription()) {
            // Why printable: a host model holding only mode/cursor bytes paints a cursor-only pane.
            subscriptionSnapshotHadContent ||= restoredSnapshotPaintsPrintableContent({ data })
            if (subscribedPtyId && bufferPtyShutdownReplayData(subscribedPtyId, data)) {
              return
            }
            outputProcessor.processData(data, storedCallbacks, {
              replayingBufferedData: true,
              suppressAttentionEvents: true,
              ...(meta?.pendingEscapeTailAnsi
                ? { pendingEscapeTailAnsi: meta.pendingEscapeTailAnsi }
                : {}),
              // Owner-proven flags require their snapshot sequence boundary; unsequenced images supply no protocol evidence.
              ...(meta?.kittyKeyboardFlags !== undefined && meta.seq !== undefined
                ? {
                    kittyKeyboardFlags: meta.kittyKeyboardFlags,
                    snapshotSeq: meta.seq
                  }
                : {}),
              ...(meta?.terminalOwner && meta.seq !== undefined
                ? { terminalOwner: meta.terminalOwner }
                : {}),
              ...(meta?.alternateScreen !== undefined && meta.seq !== undefined
                ? { alternateScreen: meta.alternateScreen }
                : {}),
              // Dimensions belong to the image independently of seq; absent/zero values fall back to the pane grid.
              ...(meta?.cols !== undefined && meta.rows !== undefined
                ? { snapshotCols: meta.cols, snapshotRows: meta.rows }
                : {}),
              ...(meta?.carriesHistory ? { carriesHistory: true } : {}),
              carriesNormalBuffer: true
            })
          }
        },
        onOutputPauseCapability: () => {
          if (isCurrentSubscription()) {
            storedCallbacks.onOutputPauseChanged?.(
              desiredOutputPaused,
              nextStream.setOutputPaused(desiredOutputPaused),
              nextStream.reportsPausedOutputDrops?.() === true
            )
          }
        },
        onPausedOutputDropped: () => {
          if (isCurrentSubscription()) {
            storedCallbacks.onPausedOutputDropped?.()
          }
        },
        onSubscribeAcknowledged: () => {
          if (isCurrentSubscription()) {
            inputReadySubscription = generation
            if (
              installedStream &&
              getCurrentMultiplexedStream(subscribedHandle) === installedStream
            ) {
              replayRecoveryDeferredViewport(installedStream)
              if (!isCurrentSubscription()) {
                return
              }
            }
            releaseHeldInput()
          }
        },
        onSubscribed: () => {
          if (!isCurrentSubscription()) {
            return
          }
          if (installedStream) {
            // Why: hosts without a subscribed ack never reach the ack replay.
            replayRecoveryDeferredViewport(installedStream)
            // Why: a failed replay write closes the stream and begins recovery; marking healthy would cancel it.
            if (!isCurrentSubscription()) {
              return
            }
          }
          storedCallbacks.onOutputPauseChanged?.(
            desiredOutputPaused,
            nextStream.setOutputPaused(desiredOutputPaused),
            nextStream.reportsPausedOutputDrops?.() === true
          )
          if (!subscriptionAttached && sameHandleEndRecovery) {
            recordSameHandleEndReuse(subscribedHandle)
          }
          subscriptionAttached = true
          setAttachmentReady(true)
          connecting = false
          markRecoveryHealthy({
            id: subscribedPtyId!,
            replay: '',
            isReattach: true,
            ...(authoritativePtyIncarnationId
              ? { incarnationId: authoritativePtyIncarnationId }
              : {})
          })
          resetRecoveryReplacementPolicy()
          emitRecoveryState()
          storedCallbacks.onConnect?.()
          // Imageless subscribe, including escape-only/oversized images, must pull retained history because idle/exited panes may emit no more bytes (#18464/#21208).
          if (
            !subscriptionSnapshotHadContent &&
            (expectedRecoveryEpoch !== undefined || subscribedHandle !== spawnedHandle)
          ) {
            storedCallbacks.onStreamRecovered?.()
          }
          storedCallbacks.onStatus?.('shell')
          releaseHeldInput()
        },
        onEnd: (verdict) => {
          if (!isCurrentSubscription()) {
            return
          }
          outputProcessor.clearAccumulatedState()
          if (verdict === 'unverifiable' || (tabId && isWebTerminalSurfaceTabId(tabId))) {
            subscriptionGeneration += 1
            closeMultiplexedStream()
            setAttachmentReady(false)
            multiplexedStream = null
            multiplexedStreamHandle = null
            clearPendingViewportClaim()
            recoveryCause = 'stream-ended'
            // Why: a legacy bare end or waiter failure proves only attachment loss; reuse the same handle, pacing flaps.
            const flapDelayMs = sameHandleEndFlapDelayMs(subscribedHandle)
            if (flapDelayMs === null) {
              scheduleResubscribeAfterTransportClose('require-replacement')
            } else if (flapDelayMs > 0) {
              scheduleResubscribeAfterBackoff('prefer-replacement', flapDelayMs)
            } else {
              scheduleResubscribeAfterTransportClose('prefer-replacement')
            }
            return
          }
          recovery.cancel()
          unregisterShutdownHandlers(subscribedPtyId)
          discardPendingInput()
          connected = false
          connecting = false
          handle = null
          remotePtyId = null
          multiplexedStream = null
          multiplexedStreamHandle = null
          setAttachmentUnavailable()
          terminalEnded = true
          clearPendingViewportClaim()
          emitRecoveryState()
          storedCallbacks.onExit?.(0)
          storedCallbacks.onDisconnect?.()
          if (subscribedPtyId) {
            onPtyExit?.(subscribedPtyId)
          }
        },
        onError: (message) => {
          if (isCurrentSubscription()) {
            handleRemoteTerminalError(message)
          }
        },
        onFitOverrideChanged: (event) => {
          // Why: desktop-fit answers our claim (its grid is the host's target, not ours); a hold means a peer owns it.
          if (event.mode !== 'desktop-fit') {
            unconfirmedClaim = null
          }
          if (isCurrentSubscription() && subscribedPtyId) {
            setFitOverride(subscribedPtyId, event.mode, event.cols, event.rows)
          }
        },
        onDriverChanged: (driver) => {
          if (driver.kind === 'mobile') {
            unconfirmedClaim = null
          }
          if (isCurrentSubscription() && subscribedPtyId) {
            setDriverForPty(subscribedPtyId, driver)
          }
        },
        onWriteUnavailable: () => {
          if (isCurrentSubscription()) {
            // Without input acks the frame answers refused input, which the journal never held.
            if (handle && getCurrentMultiplexedStream(handle)?.acknowledgesInput() !== true) {
              fallbackInputRefused = true
            }
            notifyWriteUnavailable()
          }
        },
        onInputAck: (appliedSeq, kind) => {
          if (isCurrentSubscription()) {
            inputJournal.acknowledge(appliedSeq, kind)
          }
        },
        onTransportClose: ({ recoverable, retryWithBackoff, stalled }) => {
          const current = isCurrentSubscription()
          transportClosed = true
          if (!current) {
            return
          }
          // Why no cause for a backoff: a capacity refusal arrives over a healthy connection.
          recoveryCause = stalled ? 'stream-stalled' : retryWithBackoff ? null : 'connection'
          multiplexedStream = null
          multiplexedStreamHandle = null
          setAttachmentReady(false)
          resetSameHandleEndReuse()
          if (recoverable) {
            if (retryWithBackoff) {
              scheduleResubscribeAfterBackoff()
            } else {
              scheduleResubscribeAfterTransportClose()
            }
          } else {
            connecting = false
            discardPendingInput()
            recovery.cancel()
            setAttachmentUnavailable()
            emitRecoveryState()
          }
        }
      }
    })
    if (
      transportClosed ||
      generation !== subscriptionGeneration ||
      (recoveryEpoch !== undefined &&
        !(subscriptionAttached
          ? recovery.ownsEpoch(recoveryEpoch)
          : recovery.isCurrent(recoveryEpoch))) ||
      destroyed ||
      !connected ||
      handle !== subscribedHandle ||
      remotePtyId !== subscribedPtyId
    ) {
      nextStream.close()
      // Late subscribe success is discarded after deadline like failure; retain a parked retry for online/resume (#9092).
      if (
        !destroyed &&
        connected &&
        handle === subscribedHandle &&
        recovery.currentPhase === 'disconnected' &&
        (recoveryEpoch === undefined || recovery.ownsEpoch(recoveryEpoch))
      ) {
        parkResubscribeAfterDeadline(subscribedHandle)
      }
      return
    }
    closeMultiplexedStream()
    multiplexedStream = nextStream
    multiplexedStreamHandle = subscribedHandle
    installedStream = nextStream
    setAttachmentReady(subscriptionAttached)
    if (subscriptionAttached) {
      resetRecoveryReplacementPolicy()
      markRecoveryHealthy()
    }
    // Why: a viewport change during the subscribe round-trip hit the no-op one-shot fallback; replay the latest viewport so the PTY isn't stuck at subscribe-time size.
    if (recoveryDeferredViewport) {
      // Why ack-gated: a host still resolving the PTY ignores viewport frames sent after Subscribe.
      if (inputReadySubscription === generation || subscriptionAttached) {
        replayRecoveryDeferredViewport(nextStream)
      }
    } else if (pendingViewportClaim && desiredViewport) {
      if (!isUnconfirmedClaim(nextStream, desiredViewport.cols, desiredViewport.rows)) {
        nextStream.claimViewport(desiredViewport.cols, desiredViewport.rows)
        unconfirmedClaim = { stream: nextStream, ...desiredViewport, sentAt: Date.now() }
      }
    } else if (
      desiredViewport &&
      (desiredViewport.cols !== subscribedViewport?.cols ||
        desiredViewport.rows !== subscribedViewport?.rows)
    ) {
      nextStream.resize(desiredViewport.cols, desiredViewport.rows)
    }
    // Why: a live claim may already have cleared the flag, so drain on every install.
    flushPendingClaimInput(nextStream)
    releaseHeldInput()
  }

  // Replayed attach stays in its retry epoch; cancelling would restart the ladder and prevent deadline expiry (#18495).
  function attachPane(options: Parameters<PtyTransport['attach']>[0], replay: boolean): void {
    const attachLifecycleEpoch = ++lifecycleEpoch
    const generation = ++attachGeneration
    cancelTerminalCreateRetryWait()
    if (!replay) {
      recovery.cancel()
    }
    resetRecoveryReplacementPolicy()
    resetSameHandleEndReuse()
    clearPublishedHandleWait()
    lastAttachOptions = options
    storedCallbacks = options.callbacks
    terminalEnded = false
    connecting = true
    emitRecoveryState(true)
    const previousHandle = handle
    const previousPtyId = remotePtyId
    const nextHandle = getRemoteRuntimeTerminalHandle(options.existingPtyId)
    if (previousHandle && previousHandle !== nextHandle) {
      // Why: debounced input is scoped by the current terminal handle at flush time.
      inputBatcher.clear()
      discardPendingInput()
    }
    const persistedEnvironmentId = getRemoteRuntimePtyEnvironmentId(options.existingPtyId)
    handle = nextHandle
    unregisterShutdownHandlers(previousPtyId)
    connected = false
    remotePtyId = null
    clearPendingViewportClaim()
    closeMultiplexedStream()
    if (!nextHandle) {
      // Why: an empty parsed handle ('remote:') is falsy but not null; shouldHoldInput keys on null.
      handle = null
      connecting = false
      emitRecoveryState()
      surfaceErrorMessage('Remote runtime terminal id is invalid.')
      return
    }
    const persistedHandle = nextHandle
    void (async () => {
      const adoptPersistedHandle = () =>
        adoptResolvedHostPane(
          {
            handle: persistedHandle,
            tabId: tabId ?? '',
            leafId: leafId ?? '',
            ptyId: null,
            worktreeId
          },
          options,
          false,
          generation
        )
      if (isWebTerminalSurfaceTabId(tabId ?? '')) {
        await attachHostSessionMirror(options, false, generation, attachLifecycleEpoch)
        return
      }
      if (!tabId || !leafId || !worktreeId) {
        await adoptPersistedHandle()
        return
      }
      const resolution = await resolvePersistedHostPane()
      if (generation !== attachGeneration || destroyed) {
        return
      }
      if (resolution.kind === 'resolved') {
        await adoptResolvedHostPane(resolution.terminal, options, false, generation)
        return
      }
      if (resolvePaneUnavailable && persistedEnvironmentId === currentRuntimeEnvironmentId) {
        await adoptPersistedHandle()
        return
      }
      surfaceErrorMessage('Remote terminal was closed.')
      if (resolution.kind === 'absent') {
        // Host registry can be rebuilding after restart; report host loss without declaring terminal closure (#21344).
        remotePtyId = options.existingPtyId
        retireRemoteTerminalId(-1)
        return
      }
      // Why: a host that cannot resolve this pane gives no later answer to wait for; settle offline.
      connecting = false
      emitRecoveryState()
    })().catch(async (error) => {
      if (generation !== attachGeneration || attachLifecycleEpoch !== lifecycleEpoch || destroyed) {
        return
      }
      if (runtimeTerminalErrorMessage(error).includes(ownerChanged)) {
        await reconcilePaneOwner(options, attachLifecycleEpoch)
        return
      }
      clearPendingViewportClaim()
      if (!connected && isRetryableUnboundAttachError(error)) {
        // No handle means resubscribe cannot own retry; replay attach instead of latching connecting with nothing armed (#18495).
        connecting = false
        setAwaitingSshSignIn(isSshSignInPendingTerminalError(runtimeTerminalErrorMessage(error)))
        scheduleConnectRetryAfterRecoverableFailure()
        if (handle && isRemoteTerminalStaleMessage(runtimeTerminalErrorMessage(error))) {
          retireIfHostRecordsExit(handle, remotePtyId ?? options.existingPtyId ?? null)
        }
        return
      }
      recovery.cancel()
      handleRemoteTerminalError(error)
    })
  }

  function sendInputNow(data: string): boolean {
    if (!connected || !handle || inputBlocked()) {
      return false
    }
    if (!data) {
      return true
    }
    // Why: literal LF bytes from paste/programmatic input must survive; callers use \r or the enter flag for semantic Enter.
    return inputBatcher.push(data)
  }

  function sendInputImmediateNow(data: string): boolean {
    const targetHandle = handle
    const targetLifecycleEpoch = lifecycleEpoch
    if (!connected || !targetHandle || inputBlocked()) {
      return false
    }
    if (!data) {
      return true
    }
    // Why: wait behind async validation, but keep the reply as its own host-classifiable write.
    if (inputBatcher.hasPendingValidation()) {
      inputBatcher.enqueueAfterValidation(() => {
        if (
          !connected ||
          lifecycleEpoch !== targetLifecycleEpoch ||
          handle !== targetHandle ||
          inputBlocked()
        ) {
          return
        }
        const pending = inputBatcher.takePending()
        if (pending) {
          sendUnacknowledgedInput(pending)
        }
        sendUnacknowledgedInput(data, true)
      })
      return true
    }
    const pending = inputBatcher.takePending()
    if (pending && !sendUnacknowledgedInput(pending)) {
      return false
    }
    return sendUnacknowledgedInput(data, true)
  }

  // Why: typing on a restored screen reaches its original terminal only, never a fresh create.
  async function connectHoldingRestoredInput(
    options: Parameters<PtyTransport['connect']>[0],
    replay = false
  ): Promise<PtyConnectResult | undefined> {
    if (!replay) {
      settleSignInConnectWait()
    }
    const expected = recoveryInputHold.expect(restoredInputEndpoint(options.sessionId))
    let result: PtyConnectResult | undefined
    try {
      result = await connectPane(options)
    } finally {
      recoveryInputHold.settleExpectation(expected, handle !== null && !destroyed)
      if (handle && recoveryInputHold.isHolding()) {
        releaseHeldInput()
      }
    }
    const retryOwned = !destroyed && (recovery.isActive || recovery.currentPhase === 'disconnected')
    if (
      !replay &&
      result === undefined &&
      retryOwned &&
      awaitingSshSignIn &&
      lastConnectOptions === options
    ) {
      signInConnectWait ??= Promise.withResolvers()
      return signInConnectWait.promise
    }
    return result
  }

  async function connectPane(
    options: Parameters<PtyTransport['connect']>[0]
  ): Promise<PtyConnectResult | undefined> {
    cancelTerminalCreateRetryWait()
    if (recovery.hasOwnerRefresh) {
      recovery.cancel()
    }
    const connectLifecycleEpoch = ++lifecycleEpoch
    const createEnvironmentId = currentRuntimeEnvironmentId
    lastConnectOptions = options
    lastAttachOptions = null
    storedCallbacks = options.callbacks
    resetRecoveryReplacementPolicy()
    resetSameHandleEndReuse()
    terminalEnded = false
    connecting = true
    emitRecoveryState(true)
    if (destroyed || !worktreeId) {
      return
    }

    let releasePrewarmedStream: (() => void) | null = null
    try {
      if (isWebTerminalSurfaceTabId(tabId ?? '')) {
        // Commit tab/layout reattach ownership before publishing replacement as a fresh spawn.
        return await attachHostSessionMirror(
          options,
          !options.sessionId,
          undefined,
          connectLifecycleEpoch
        )
      }

      // Why: every path below subscribes after its host RPCs; opening the stream alongside saves a round trip.
      releasePrewarmedStream =
        currentPaneRevision() === getRuntimeEnvironmentRevision(createEnvironmentId)
          ? getRemoteRuntimeTerminalMultiplexer(createEnvironmentId).prewarm()
          : null

      if (options.sessionId && !getRemoteRuntimeTerminalHandle(options.sessionId)) {
        // Why: a HUB session persists host-native PTY ids; resolve its pane handle without exposing that SSH identity as a client transport id.
        const resolution = await resolvePersistedHostPane()
        if (resolution.kind === 'resolved') {
          return await adoptResolvedHostPane(resolution.terminal, options)
        }
      }

      const commandToSend = options.command ?? command
      const startupCommandDeliveryToSend = options.startupCommandDelivery ?? startupCommandDelivery
      const envToSend = options.env ?? env
      const envToDeleteToSend = options.envToDelete ?? envToDelete
      const launchConfigToSend = options.launchConfig ?? launchConfig
      const resumeProviderSessionToSend = options.resumeProviderSession ?? resumeProviderSession
      const launchTokenToSend = options.launchToken ?? launchToken
      const launchAgentToSend = options.launchAgent ?? launchAgent
      const restoreSpawnIntent = resumeProviderSessionToSend ? options.resumeSpawnIntent : undefined
      // Why only for a restore: an extra await would reorder every plain create against destroy.
      const spawnIntentParams = restoreSpawnIntent
        ? await remoteRestoreSpawnIntentParams(createEnvironmentId, restoreSpawnIntent)
        : {}
      if (restoreSpawnIntent && (destroyed || lifecycleEpoch !== connectLifecycleEpoch)) {
        return
      }
      const legacyCreateParams = {
        worktree: toRuntimeTerminalWorktreeSelector(worktreeId),
        clientMutationId: terminalCreateMutationId,
        ...(commandToSend !== undefined ? { command: commandToSend } : {}),
        ...(startupCommandDeliveryToSend !== undefined
          ? { startupCommandDelivery: startupCommandDeliveryToSend }
          : {}),
        ...(envToSend !== undefined ? { env: envToSend } : {}),
        ...(envToDeleteToSend !== undefined ? { envToDelete: envToDeleteToSend } : {}),
        ...(launchConfigToSend !== undefined ? { launchConfig: launchConfigToSend } : {}),
        ...(resumeProviderSessionToSend !== undefined
          ? { resumeProviderSession: resumeProviderSessionToSend }
          : {}),
        ...(launchTokenToSend !== undefined ? { launchToken: launchTokenToSend } : {}),
        ...(launchAgentToSend !== undefined ? { launchAgent: launchAgentToSend } : {}),
        ...spawnIntentParams,
        ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
        ...(terminalKittyKeyboardProtocol === true ? { terminalKittyKeyboardProtocol: true } : {}),
        tabId,
        leafId,
        focus: false,
        // Why: transport backs an already-mounted pane; activation is local state, not permission for remote UI reveal.
        presentation: 'background' as const,
        ...(activate === true ? { activate: true } : {})
      }
      const legacyCreate = () =>
        createWithUnknownOutcomeRecovery(
          'terminal',
          (timeoutMs, reconcileExisting) =>
            callRuntimeForEnvironment<{ terminal: RuntimeTerminalCreate }>(
              createEnvironmentId,
              'terminal.create',
              {
                ...legacyCreateParams,
                ...(reconcileExisting ? { reconcileExisting: true } : {})
              },
              timeoutMs
            ),
          createEnvironmentId,
          connectLifecycleEpoch
        )
      const hostAuthorityCreate = async () => {
        const keyboardOptions = await agentKeyboardOptions(createEnvironmentId)
        return createWithUnknownOutcomeRecovery(
          'agent-session',
          (timeoutMs) =>
            resumeProviderSessionToSend
              ? callRuntimeForEnvironment<RuntimeEnsureAgentSessionResult>(
                  createEnvironmentId,
                  'terminal.ensureAgentSession',
                  {
                    kind: 'explicit',
                    ...keyboardOptions,
                    worktree: toRuntimeTerminalWorktreeSelector(worktreeId),
                    agent: launchAgentToSend!,
                    providerSession: agentProviderSessionForEnsure(resumeProviderSessionToSend),
                    ...(launchConfigToSend?.ompResumeFilePath
                      ? { ompResumeFilePath: launchConfigToSend.ompResumeFilePath }
                      : {}),
                    ...(agentArgsOverride !== undefined ? { agentArgs: agentArgsOverride } : {}),
                    ...(agentLaunchPreferences
                      ? { launchPreferences: agentLaunchPreferences }
                      : {}),
                    placement: { tabId, leafId },
                    presentation: 'background',
                    ...spawnIntentParams
                  },
                  timeoutMs
                )
              : callRuntimeForEnvironment<RuntimeCreateAgentSessionResult>(
                  createEnvironmentId,
                  'terminal.createAgentSession',
                  withAgentSessionCreateOperationId(
                    {
                      ...keyboardOptions,
                      worktree: toRuntimeTerminalWorktreeSelector(worktreeId),
                      agent: launchAgentToSend!,
                      ...(agentPrompt ? { prompt: agentPrompt } : {}),
                      ...(agentPromptDelivery ? { promptDelivery: agentPromptDelivery } : {}),
                      ...(agentArgsOverride !== undefined ? { agentArgs: agentArgsOverride } : {}),
                      ...(agentLaunchPreferences
                        ? { launchPreferences: agentLaunchPreferences }
                        : {}),
                      placement: { tabId, leafId },
                      presentation: 'background'
                    },
                    agentCreateOperation.clientOperationId
                  ),
                  timeoutMs
                ),
          createEnvironmentId,
          connectLifecycleEpoch
        )
      }
      const resumeHostAuthorityCapability = resumeProviderSessionToSend
        ? agentResumeHostAuthorityCapability(launchAgentToSend)
        : undefined
      const created = launchAgentToSend
        ? agentSessionRequiresHostAuthorityReplay
          ? await hostAuthorityCreate()
          : await runRemoteAgentSessionLaunch<RemoteAgentSessionLaunchResult | null>({
              environmentId: createEnvironmentId,
              hostAuthority: hostAuthorityCreate,
              ...(resumeHostAuthorityCapability
                ? { hostAuthorityCapability: resumeHostAuthorityCapability }
                : {}),
              legacy: legacyCreate
            })
        : await legacyCreate()
      if (!created) {
        if (!destroyed && lifecycleEpoch === connectLifecycleEpoch) {
          connecting = false
          recovery.markDisconnected()
        }
        return
      }
      const createdTerminal = created.terminal
      adoptExecutionMetadata(createdTerminal)
      if (created.disposition !== undefined && tabId && createdTerminal.tabId) {
        recordWebAgentSessionHandoff({
          environmentId: createEnvironmentId,
          worktreeId,
          provisionalTabId: tabId,
          hostTabId: createdTerminal.tabId,
          hostTerminalHandle: createdTerminal.handle
        })
        // Snapshot parity must not delay attachment to a terminal the host already created.
        void refreshWebRuntimeSessionTabsSnapshot(createEnvironmentId, worktreeId, {
          expectedEnvironmentPairingRevision: currentPaneRevision(),
          acceptCurrentSnapshot: true,
          confirmAgentSessionHandoff: {
            provisionalTabId: tabId,
            hostTabId: createdTerminal.tabId,
            hostTerminalHandle: createdTerminal.handle
          }
        })
      }
      if (destroyed || lifecycleEpoch !== connectLifecycleEpoch) {
        if (
          !hostSnapshotOwnsLaunch(created, createEnvironmentId) &&
          (createdTerminal.handle !== handle || createEnvironmentId !== currentRuntimeEnvironmentId)
        ) {
          await closeRemoteTerminal(createdTerminal.handle, createEnvironmentId)
        }
        return
      }
      handle = createdTerminal.handle

      if (createdTerminal.isReattach === true) {
        storedCallbacks.onReattachDetermined?.()
      }
      remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
      registerShutdownHandlers(remotePtyId)
      connected = true
      desiredViewport = {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24
      }
      if (createdTerminal.isReattach !== true) {
        spawnedHandle = handle
        onPtySpawn?.(remotePtyId)
      }
      emitRecoveryState()

      try {
        await subscribeToHandle()
      } catch (error) {
        if (!recoverAfterSubscribeFailure(error, handle, remotePtyId)) {
          throw error
        }
      }
      if (destroyed || !connected || !remotePtyId) {
        return
      }

      return {
        id: remotePtyId,
        replay: '',
        ...(authoritativePtyIncarnationId ? { incarnationId: authoritativePtyIncarnationId } : {}),
        ...(createdTerminal.isReattach === true ? { isReattach: true } : {})
      } satisfies PtyConnectResult
    } catch (error) {
      if (!destroyed && lifecycleEpoch === connectLifecycleEpoch) {
        connecting = false
        const message = runtimeTerminalErrorMessage(error)
        if (message.includes(ownerChanged)) {
          return await reconcilePaneOwner(options, connectLifecycleEpoch)
        }
        const deferral = readTerminalSpawnDeferral(error)
        if (deferral) {
          recovery.cancel()
          emitRecoveryState()
          storedCallbacks.onSpawnDeferred?.(deferral)
        } else if (isRemoteTerminalGoneMessage(message)) {
          recovery.cancel()
          handleRemoteTerminalError(error)
        } else if (isSshSignInPendingTerminalError(message)) {
          // Pre-dispatch sign-in refusal created nothing; control-ready revival may safely replay create (#31942).
          setAwaitingSshSignIn(true)
          scheduleConnectRetryAfterRecoverableFailure()
        } else if (isRecoverablePaneBindingError(error)) {
          setAwaitingSshSignIn(false)
          scheduleConnectRetryAfterRecoverableFailure()
        } else {
          recovery.cancel()
          emitRecoveryState()
          surfaceErrorMessage(message)
        }
      }
      return undefined
    } finally {
      // A subscribed stream keeps the connection; only an abandoned warm-up closes it.
      releasePrewarmedStream?.()
    }
  }

  const transport: PtyTransport = {
    connect: connectHoldingRestoredInput,

    attach(options) {
      settleSignInConnectWait()
      recoveryInputHold.expect(null)
      attachPane(options, false)
    },

    disconnect() {
      settleSignInConnectWait()
      lifecycleEpoch += 1
      attachGeneration += 1
      discardPendingInput()
      cancelTerminalCreateRetryWait()
      recovery.cancel()
      resetRecoveryReplacementPolicy()
      resetSameHandleEndReuse()
      clearPublishedHandleWait()
      inputBatcher.flush()
      inputBatcher.clear()
      viewportBatcher.flush()
      outputProcessor.clearAccumulatedState()
      if (!connected && !handle) {
        return
      }
      connected = false
      connecting = false
      terminalEnded = true
      clearPendingViewportClaim()
      const id = remotePtyId
      unregisterShutdownHandlers(id)
      closeMultiplexedStream()
      setAttachmentUnavailable()
      handle = null
      remotePtyId = null
      emitRecoveryState()
      storedCallbacks.onDisconnect?.()
      if (id) {
        // Disconnect closes only this viewer stream; the host PTY may live, so its exit is unverifiable.
        onPtyExit?.(id, -1)
      }
    },

    detach() {
      // Drop the processor gauge before detach callbacks/batcher flush can throw; the successor already owns the PTY.
      outputProcessor.disposePendingSideEffectGauge()
      settleSignInConnectWait()
      lifecycleEpoch += 1
      attachGeneration += 1
      discardPendingInput()
      cancelTerminalCreateRetryWait()
      recovery.cancel()
      resetRecoveryReplacementPolicy()
      resetSameHandleEndReuse()
      clearPublishedHandleWait()
      inputBatcher.flush()
      inputBatcher.clear()
      viewportBatcher.flush()
      outputProcessor.clearAccumulatedState()
      unregisterShutdownHandlers(remotePtyId)
      connected = false
      connecting = false
      clearPendingViewportClaim()
      closeMultiplexedStream()
      setAttachmentUnavailable()
      emitRecoveryState()
      storedCallbacks = {}
    },

    // Why: the kind only gates the local hold; terminal.send gets no kind, so the host classifies desktop bytes itself.
    sendInput(data, inputKind): boolean {
      if (releaseThenShouldHold(inputKind)) {
        if (!data) {
          return true
        }
        // Why: earlier input still in size validation reaches the hold later; queue behind it.
        if (inputBatcher.hasPendingValidation()) {
          return inputBatcher.push(data)
        }
        inputBatcher.flush()
        return recoveryInputHold.enqueue(holdEndpoint(), data, inputKind)
      }
      return sendInputNow(data)
    },

    // Why: query replies (CPR/DSR/DA/OSC) are read in raw mode with a short timeout; the 8ms debounce would miss it and echo the reply onto the prompt (#7329).
    sendInputImmediate: (data: string): boolean => sendInputImmediateNow(data),

    sendInputAccepted(data, inputKind, options) {
      if (releaseThenShouldHold(inputKind) && data) {
        if (inputBatcher.hasPendingValidation()) {
          return holdAcceptedAfterValidation(data, inputKind, options)
        }
        inputBatcher.flush()
        return recoveryInputHold.enqueueAccepted(holdEndpoint(), data, inputKind, options)
      }
      return sendInputAcceptedToRuntime(data, inputKind, options)
    },

    // Why: a transport with an armed retry or a parked one owns this pane's recovery; a remount would race it (#21195).
    ownsRecovery() {
      return !destroyed && !terminalEnded && recoveryBlocksIo()
    },

    hasUndeliveredInput() {
      return (
        inputJournal.hasUnacknowledgedInput() ||
        inputBatcher.hasPendingInput() ||
        recoveryInputHold.hasPendingInput() ||
        fallbackSendsInFlight > 0 ||
        fallbackInputRefused
      )
    },

    claimViewport(cols: number, rows: number): boolean {
      if (!connected || !handle) {
        return false
      }
      rememberViewport(cols, rows)
      if (inputBlocked()) {
        deferViewportForRecovery(true)
        return true
      }
      viewportBatcher.clear()
      sendViewportUpdate(cols, rows, true)
      return true
    },

    setOutputPaused(paused: boolean): boolean {
      desiredOutputPaused = paused
      if (!connected || !handle) {
        return false
      }
      const stream = getCurrentMultiplexedStream(handle)
      const supported = stream?.setOutputPaused(paused) === true
      storedCallbacks.onOutputPauseChanged?.(
        paused,
        supported,
        stream?.reportsPausedOutputDrops?.() === true
      )
      return supported
    },

    resize(cols: number, rows: number, meta): boolean {
      if (!connected || !handle) {
        return false
      }
      rememberViewport(cols, rows)
      if (inputBlocked()) {
        deferViewportForRecovery(meta?.claim === true)
        return true
      }
      if (meta?.claim) {
        viewportBatcher.clear()
        sendViewportUpdate(cols, rows, true)
        return true
      }
      // Why: xterm fit emits resize bursts on drag/layout-restore; remote runtimes only need the last viewport per frame.
      viewportBatcher.queue(cols, rows)
      return true
    },

    isConnected() {
      return (
        connected &&
        !recoveryBlocksIo() &&
        attachmentReady &&
        multiplexedStream !== null &&
        multiplexedStreamHandle === handle
      )
    },

    getRecoveryState,

    // Why: dedup exists to stop one outage spamming the surface; once the user dismisses it, the next occurrence is new information again.
    notifyErrorSurfaceDismissed() {
      surfacedErrorMessages.clear()
    },

    retryRecovery() {
      if (recovery.hasOwnerRefresh || surfacedErrorMessages.has(ownerChanged)) {
        return recovery.retryNow()
      }
      if (
        !destroyed &&
        !terminalEnded &&
        !connected &&
        isWebTerminalSurfaceTabId(tabId ?? '') &&
        recovery.currentPhase === 'disconnected'
      ) {
        // Give replayed attach a fresh deadline; idle cancellation would reset grace and let old held input release arbitrarily late.
        autoRecoveryWindowSpent = false
        recovery.begin()
        if (replayLastTransportEntryPoint()) {
          return true
        }
        recovery.markDisconnected()
      }
      if (
        !destroyed &&
        !terminalEnded &&
        !connected &&
        !handle &&
        (terminalCreateNeedsReconciliation || agentSessionRequiresHostAuthorityReplay) &&
        lastConnectOptions &&
        recovery.currentPhase === 'disconnected'
      ) {
        recovery.begin()
        void connectHoldingRestoredInput(lastConnectOptions, true)
        return true
      }
      // Why: online/resume fires a parked retry; the button must not be weaker than an event (#12684).
      if (!destroyed && !terminalEnded && recovery.currentPhase === 'disconnected') {
        if (recovery.retryNow()) {
          return true
        }
      }
      if (
        destroyed ||
        terminalEnded ||
        !connected ||
        !handle ||
        recovery.currentPhase !== 'disconnected'
      ) {
        return false
      }
      const recoveryEpoch = recovery.begin()
      scheduleResubscribeAfterTransportClose(getRecoveryReplacementPolicy(handle), recoveryEpoch)
      return true
    },

    getPtyId() {
      return remotePtyId
    },

    getConnectionId() {
      return null
    },

    getRuntimeEnvironmentId() {
      return currentRuntimeEnvironmentId
    },

    getExecutionHostId() {
      return authoritativeExecutionHostId
    },

    getRemotePlatform() {
      return authoritativeHostPlatform
    },

    async serializeBuffer(opts) {
      if (!connected || !handle) {
        return null
      }
      if (!(await waitForAttachmentReady()) || !handle) {
        return null
      }
      return getCurrentMultiplexedStream(handle)?.serializeBuffer(opts) ?? null
    },

    async serializeBufferOutcome(opts): Promise<RemoteRuntimeSnapshotOutcome> {
      if (!connected || !handle) {
        return {
          availability: { kind: 'retry-worthy', cause: 'connection-not-ready' },
          snapshot: null
        }
      }
      const stream = getCurrentMultiplexedStream(handle)
      if (!stream) {
        return {
          availability: { kind: 'retry-worthy', cause: 'stream-detached' },
          snapshot: null
        }
      }
      return stream.serializeBufferOutcome(opts)
    },

    destroy() {
      destroyed = true
      setAttachmentUnavailable()
      // Always release the gauge even when disconnect consumers throw during failed teardown.
      try {
        this.disconnect()
      } finally {
        outputProcessor.disposePendingSideEffectGauge()
      }
      recovery.dispose()
      inputBatcher.clear()
      viewportBatcher.clear()
    }
  }
  return transport
}
