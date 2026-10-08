import { warnRemoteTerminalInputDelivery } from './remote-terminal-input-delivery-warning'
import { createAgentSessionKeyboardOptions } from '@/runtime/agent-session-keyboard-capability'
import { withRemoteReattachInputBuffer } from './remote-reattach-input-buffer'
import {
  createRemoteRuntimeRecoveryInputHold,
  type RemoteRuntimeInputEndpoint
} from './remote-runtime-recovery-input-hold'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
/* eslint-disable max-lines -- Why: remote PTY transport keeps lifecycle, JSON fallback, and binary stream wiring together so reconnect/destroy ordering stays testable as one behavior surface. */
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  isRecoverableRemoteRuntimeConnectionError,
  isRuntimeRpcQueueOverloadError,
  toRemoteRuntimeClientErrorLike
} from '../../../../shared/remote-runtime-client-error-classification'
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
  RuntimeTerminalSend
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
  PtyTransport,
  PtyTransportRecoveryState
} from './pty-transport-types'
import { createPtyOutputProcessor } from './pty-transport'
import { isSshSessionGoneError } from './pty-connection/pty-connect-limits'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from '../../runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle,
  runtimeTerminalErrorMessage,
  toRemoteRuntimePtyId
} from '../../runtime/runtime-terminal-stream'
import {
  getRemoteRuntimeTerminalMultiplexer,
  REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE,
  type RemoteRuntimeMultiplexedTerminal,
  type RemoteRuntimeSnapshotOutcome
} from '../../runtime/remote-runtime-terminal-multiplexer'
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
  RemoteRuntimePtyRecoveryState
} from './remote-runtime-pty-recovery-state'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  createAgentSessionCreateOperation,
  withAgentSessionCreateOperationId
} from '@/runtime/agent-session-create-operation'
import { replaceFitOverridePtyId, setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import { replaceDriverPtyId, setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '@/runtime/web-terminal-surface-id'
import { listRemoteRuntimeSessionTabsAfterCurrentInFlight } from '@/runtime/remote-runtime-session-tabs-inflight'
import { subscribeAcceptedWebSessionTerminalHandle } from '@/runtime/web-session-terminal-handle-events'
import { hostSnapshotAffirmsWorktreeContents } from '@/runtime/host-session-snapshot-authority'
import { runRemoteAgentSessionLaunch } from '@/runtime/remote-agent-session-launch'
import { useAppStore } from '@/store'
import { recordWebAgentSessionHandoff } from '@/runtime/web-agent-session-handoff'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-runtime-session'
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
const REMOTE_RUNTIME_MAX_PENDING_QUERY_REPLIES = 64
const HOST_SESSION_ATTACH_POLL_MS = 150
const HOST_SESSION_POLL_MAX_MS = 1_000
const HOST_SESSION_ATTACH_TIMEOUT_MS = 15_000
const HOST_SESSION_INVENTORY_MAX_WINDOWS_PER_RECOVERY = 2
const HOST_SESSION_SAME_HANDLE_END_REUSE_LIMIT = 2
// Why its own constant: this fences how long an end-then-reattach on the same handle still counts as
// one recovery, which is unrelated to how long auto-recovery keeps retrying. It read the recovery
// budget before that budget became a derived value, and must not drift with it.
const HOST_SESSION_SAME_HANDLE_END_REUSE_WINDOW_MS = 60_000
const MAX_SURFACED_TERMINAL_ERRORS = 8
const TERMINAL_CREATE_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const

type HostHandleReplacementPolicy = 'reuse' | 'prefer-replacement' | 'require-replacement'

type PersistedHostPaneResolution =
  | { kind: 'resolved'; terminal: RuntimeTerminalResolvePane }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

type HostSessionHandleWaitResult = {
  handle: string | null | undefined
  inventoryFailed: boolean
}

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

function isRemoteTerminalStaleMessage(message: string): boolean {
  return message.includes('terminal_handle_stale')
}

// Why: lost contact, host back-pressure, or a re-minted handle all leave the pane resolvable later.
function isRetryableUnboundAttachError(error: unknown): boolean {
  const clientError = toRemoteRuntimeClientErrorLike(error)
  return (
    isRecoverableRemoteRuntimeConnectionError(clientError) ||
    isRuntimeRpcQueueOverloadError(clientError) ||
    isRemoteTerminalStaleMessage(runtimeTerminalErrorMessage(error))
  )
}

// Why: main refuses a stale pairing before dispatch (a managed server update re-pairs it), so the
// terminal is untouched and only the binding must retry on the re-read pairing.
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
    message.includes('no_connected_pty') ||
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
  // Why: the pane belongs to the machine it was opened on; it may follow that machine's own
  // re-pair (a server update) but never a same-id re-pair to another or unverified machine.
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
  let resubscribeEpoch: number | null = null
  let resubscribeRequestedHandle: string | null = null
  let resubscribeRequestedReplacementPolicy: HostHandleReplacementPolicy = 'reuse'
  let recoveryReplacementPolicy: HostHandleReplacementPolicy = 'reuse'
  let recoveryReplacementPolicyHandle: string | null = null
  let stopWaitingForPublishedHandle: (() => void) | null = null
  let publishedHandleWaitEpoch: number | null = null
  // Why: a spent auto-recovery window is the evidence that licenses reattaching the fenced handle; explicit retries must not erase it.
  let autoRecoveryWindowSpent = false
  let settleHostSessionAttachRetry: ((retry: boolean) => void) | null = null
  let resubscribeInventoryEpoch: number | null = null
  let resubscribeInventoryWindows = 0
  let sameHandleEndReuseHandle: string | null = null
  let sameHandleEndReuseCount = 0
  let sameHandleEndReuseAttachedAt: number | null = null
  let attachGeneration = 0
  let subscriptionGeneration = 0

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

  const recoveryInputHold = createRemoteRuntimeRecoveryInputHold()
  const recovery = new RemoteRuntimePtyRecoveryState(() => {
    if (recovery.currentPhase === 'disposed') {
      clearPublishedHandleWait()
    }
    if (recovery.currentPhase === 'disconnected' || recovery.currentPhase === 'disposed') {
      // Why: once auto-recovery gives up, held keys would land at an arbitrary later reconnect.
      recoveryInputHold.discard()
    }
    if (recovery.currentPhase === 'disconnected') {
      // Why: only the wall-clock deadline is evidence the window was spent; a UI latch from a fatal
      // resubscribe must not license reattaching a fenced same handle (#12683).
      autoRecoveryWindowSpent ||= recovery.autoRecoveryDeadlineExpired
      // Why: cached pixels may remain, but no stream from the exhausted epoch may keep delivering or accepting terminal traffic.
      subscriptionGeneration += 1
      closeMultiplexedStream()
    }
    if (recovery.currentPhase === 'idle') {
      autoRecoveryWindowSpent = false
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
  let pendingViewportClaim = false
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
  const beginResubscribeInventoryWindow = (recoveryEpoch: number): number => {
    if (resubscribeInventoryEpoch !== recoveryEpoch) {
      resubscribeInventoryEpoch = recoveryEpoch
      resubscribeInventoryWindows = 0
    }
    resubscribeInventoryWindows += 1
    return resubscribeInventoryWindows
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
  const replacementPolicyAfterStreamEnd = (targetHandle: string): HostHandleReplacementPolicy => {
    if (
      sameHandleEndReuseHandle !== targetHandle ||
      sameHandleEndReuseAttachedAt === null ||
      Date.now() - sameHandleEndReuseAttachedAt >= HOST_SESSION_SAME_HANDLE_END_REUSE_WINDOW_MS
    ) {
      resetSameHandleEndReuse()
      return 'prefer-replacement'
    }
    return sameHandleEndReuseCount >= HOST_SESSION_SAME_HANDLE_END_REUSE_LIMIT
      ? 'require-replacement'
      : 'prefer-replacement'
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
    for (const segment of queued) {
      if (!stream.sendInput(segment.text, { requireReceipt: !segment.queryReply })) {
        sendUnacknowledgedInput(segment.text, segment.queryReply)
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
  // Why: reconnect retries must replay one host operation instead of creating
  // another fresh agent when the first response was lost.
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
    return {
      phase,
      epoch: recovery.currentEpoch,
      attempt: recovery.attemptCount
    }
  }

  function emitRecoveryState(force = false): void {
    const state = getRecoveryState()
    const key = `${state.phase}:${state.epoch}:${state.attempt}`
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

  function markRecoveryHealthy(): void {
    const recoveredErrors = [...surfacedErrorMessages]
    surfacedErrorMessages.clear()
    recovery.markHealthy()
    for (const message of recoveredErrors) {
      storedCallbacks.onErrorCleared?.(message)
    }
  }

  function hostSnapshotOwnsLaunch(
    result: RemoteAgentSessionLaunchResult,
    environmentId: string
  ): boolean {
    if (result.disposition !== undefined || result.terminal.isReattach === true) {
      // Why: every structured launch is host-owned; provisional teardown must
      // never close its canonical terminal while snapshot reconciliation catches up.
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
      // Why: activation answers absence from the host's own in-flight bookkeeping — a worktree snapshot
      // it has not hydrated yet answers the same way as one it really dropped (#21852). Only the
      // inventory below carries removal evidence, so fall through and let it adjudicate.
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
        // Why: no re-activation failure is absence proof, whether the surface is missing or the host predates the method — but
        // activation materializes host-side, so an outcome the client never saw must not be replayed into a duplicate PTY.
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
        // Why: a populated surface list missing only this leaf is positive absence, but a list carrying no
        // surface at all for the tab is a client-side snapshot of a host that may still be republishing.
        // Keep polling inside the bounded window and let it expire as unknown liveness, never as removal.
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
    isCurrent: () => boolean
  ): Promise<string | undefined | false> {
    let recoveryEpoch = recovery.isActive ? recovery.currentEpoch : undefined
    while (isCurrent()) {
      try {
        const hostHandle = await waitForHostSessionHandle(hostTabId, isCurrent)
        if (!isCurrent()) {
          return undefined
        }
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
  ): Promise<HostSessionHandleWaitResult> {
    if (!worktreeId) {
      return { handle: null, inventoryFailed: false }
    }
    const worktree = toRuntimeWorktreeSelector(worktreeId)
    const startedAt = Date.now()
    let pollMs = HOST_SESSION_ATTACH_POLL_MS
    // Why: list-only polling cannot recreate a host PTY lost across desktop generations.
    let nextRequest: 'activate' | 'list' = 'activate'
    let lastRequestError: unknown = null
    let lastReadyHandle: string | null = null
    const finishBoundedWait = (): HostSessionHandleWaitResult => {
      const effectivePolicy = stricterReplacementPolicy(
        replacementPolicy,
        getRecoveryReplacementPolicy(previousHandle)
      )
      if (effectivePolicy === 'prefer-replacement' && lastReadyHandle) {
        return { handle: lastReadyHandle, inventoryFailed: false }
      }
      if (lastRequestError) {
        console.warn(
          '[remote-runtime-pty] host session recovery request failed during reconnect:',
          runtimeTerminalErrorMessage(lastRequestError)
        )
      }
      // Why: a bounded wait without removal evidence is unknown liveness; keep the pane for a later snapshot to reattach.
      return { handle: undefined, inventoryFailed: lastRequestError !== null }
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
            : // Why: reconnect recovery, not a user gesture — a pane the user slept
              // must stay slept even though it publishes the same pending status.
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
          return { handle: nextHandle, inventoryFailed: false }
        }
        if (request === 'list') {
          if (hasHostSessionTerminalSurface(listed, hostTabId)) {
            if (!nextHandle) {
              // Why: the surface is published but unmaterialized, and only activation can mint its PTY.
              nextRequest = 'activate'
            }
          } else if (hostSnapshotAffirmsWorktreeContents(listed)) {
            return { handle: null, inventoryFailed: false }
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
    return { handle: undefined, inventoryFailed: false }
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
      void connectForRecovery(lastConnectOptions)
      return true
    }
    return false
  }

  // Why: a recoverable connect failure is unverifiable contact loss, not a dead terminal, so retry
  // whichever path can still reach the pane instead of latching with nothing armed (#12684).
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

  // Why: schedule() both auto-retries inside the window and leaves the retry parked when the deadline
  // latches, so online/resume and the Reconnect button always find something to fire.
  function scheduleConnectRetryAfterRecoverableFailure(): void {
    if (destroyed) {
      return
    }
    // Why: an ambiguous create already owns a reconciliation-gated retry that only Reconnect may
    // re-enter; auto-replaying here would just re-probe a runtime that cannot reconcile.
    if (terminalCreateNeedsReconciliation || agentSessionRequiresHostAuthorityReplay) {
      recovery.markDisconnected()
      return
    }
    // Why: the last attempt's RPC budget expires at the same instant as the deadline, so a silent drop
    // rejects after the latch. Beginning a new epoch there re-arms the whole window, so park instead.
    if (recovery.currentPhase === 'disconnected') {
      recovery.parkRetryAfterDeadline(retryAfterRecoverableConnectFailure)
      return
    }
    const recoveryEpoch = recovery.isActive ? recovery.currentEpoch : recovery.begin()
    if (!recovery.schedule(recoveryEpoch, retryAfterRecoverableConnectFailure)) {
      recovery.markDisconnected()
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
    const hostHandle = await waitForHostSessionHandleWithRecovery(hostTabId, isCurrent)
    if (!isCurrent()) {
      return undefined
    }
    if (hostHandle === undefined) {
      connecting = false
      // Why: no handle and no removal evidence is unknown liveness, so own an epoch and keep an unarmed retry parked for the
      // banner and online/resume to fire — a silent 'connecting' renders no banner and retryRecovery() refuses to run.
      if (recovery.currentPhase !== 'disconnected') {
        const recoveryEpoch = recovery.isActive ? recovery.currentEpoch : recovery.begin()
        recovery.parkRetryForExternalTrigger(recoveryEpoch, () => {
          replayLastTransportEntryPoint()
        })
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

    if (leafId && worktreeId && !resolvePaneUnavailable) {
      try {
        const resolved = await callRuntime<{ terminal: RuntimeTerminalResolvePane }>(
          'terminal.resolvePane',
          { paneKey: `${hostTabId}:${leafId}`, worktreeId }
        )
        const terminal = resolved.terminal
        if (
          terminal.handle === hostHandle &&
          terminal.tabId === hostTabId &&
          terminal.leafId === leafId &&
          (!terminal.worktreeId || terminal.worktreeId === worktreeId)
        ) {
          adoptExecutionMetadata(terminal)
        }
      } catch (error) {
        if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
          resolvePaneUnavailable = true
        }
      }
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
    // Structured operations already carry their replay proof; ordinary terminal.create
    // must prove v2 support before retrying an outcome the client cannot observe.
    let idempotencySupported = kind === 'agent-session'
    let reconcileExisting =
      kind === 'agent-session'
        ? agentSessionRequiresHostAuthorityReplay
        : terminalCreateNeedsReconciliation
    // Why the same budget: this loop calls recovery.begin(), so a shorter local deadline would abandon
    // the create while the recovery state still reports 'recovering' with nothing in flight.
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
    options: { cols?: number; rows?: number },
    notifySpawn = true,
    expectedAttachGeneration?: number
  ): Promise<PtyConnectResult | undefined> {
    if (
      destroyed ||
      (expectedAttachGeneration !== undefined && expectedAttachGeneration !== attachGeneration)
    ) {
      return undefined
    }
    adoptExecutionMetadata(terminal)
    const previousPtyId = remotePtyId
    handle = terminal.handle
    remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
    unregisterShutdownHandlers(previousPtyId)
    registerShutdownHandlers(remotePtyId)
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
      await subscribeToHandle()
    } catch (error) {
      if (!recoverAfterSubscribeFailure(error, handle, remotePtyId)) {
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

  // Why: a pane binding or auto-recovering a known handle holds typing for it instead of dropping it (#25784).
  function shouldHoldInput(): boolean {
    return (
      !destroyed &&
      !terminalEnded &&
      handle !== null &&
      recovery.currentPhase !== 'disconnected' &&
      (recovery.isActive || (connecting && !connected) || recoveryInputHold.isHolding())
    )
  }

  function heldInputEndpoint(targetHandle: string) {
    return {
      handle: targetHandle,
      incarnationId: authoritativePtyIncarnationId
    }
  }

  // Why: releases a stale hold first, so the hold check reads the handle that release left bound.
  function releaseThenHoldEndpoint(
    inputKind: TerminalInputKind
  ): RemoteRuntimeInputEndpoint | null {
    if (recoveryInputHold.isHolding()) {
      releaseHeldInput()
    }
    return handle && inputKind !== 'query-reply' && shouldHoldInput()
      ? heldInputEndpoint(handle)
      : null
  }

  function releaseHeldInput(): void {
    const boundHandle = handle
    if (destroyed || terminalEnded || !boundHandle) {
      recoveryInputHold.discard()
      return
    }
    if (
      !connected ||
      recoveryBlocksIo() ||
      !attachmentReady ||
      !getCurrentMultiplexedStream(boundHandle)
    ) {
      return
    }
    recoveryInputHold.release(heldInputEndpoint(boundHandle), {
      isCurrent: () => connected && handle === boundHandle && !recoveryBlocksIo(),
      sendInput: (data) => sendInputNow(data),
      sendInputImmediate: (data) => sendInputImmediateNow(data),
      sendInputAccepted: sendInputAcceptedToRuntime
    })
  }

  async function sendInputAcceptedToRuntime(data: string): Promise<boolean> {
    const targetHandle = handle
    if (!connected || !targetHandle || recoveryBlocksIo()) {
      return false
    }
    if (!data) {
      return true
    }
    await inputBatcher.drain()
    if (!connected || handle !== targetHandle || recoveryBlocksIo()) {
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
    const text = `${inputBatcher.takePending()}${data}`
    try {
      const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(text)
      if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
        return false
      }
    } catch {
      return false
    }
    try {
      for (const chunk of iterateTerminalInputChunks(text)) {
        if (!connected || handle !== targetHandle || recoveryBlocksIo()) {
          return false
        }
        // Why: acknowledged sends order behind pending debounce text but must not collapse large paste back into one remote RPC.
        const result = await callRuntime<{ send: RuntimeTerminalSend }>('terminal.send', {
          terminal: targetHandle,
          text: chunk,
          client: { id: clientId, type: 'desktop' },
          ...(desiredViewport ? { viewport: desiredViewport, claimViewport: true as const } : {})
        })
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

  function notifyWriteUnavailable(): void {
    if (!destroyed) {
      storedCallbacks.onWriteUnavailable?.()
    }
  }

  const sendUnacknowledgedInput = (text: string, queryReply = false): boolean => {
    const targetHandle = handle
    const targetLifecycleEpoch = lifecycleEpoch
    if (!connected || !targetHandle || recoveryBlocksIo()) {
      return false
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (stream?.sendInput(text, { requireReceipt: !queryReply })) {
      return true
    }
    if (pendingViewportClaim) {
      // Why: a claim during subscribe/reconnect has no stream record yet; hold its input so the stream emits claim+input in one order.
      queuePendingClaimInput(text, queryReply)
      return true
    }
    void callRuntime<{ send: RuntimeTerminalSend }>('terminal.send', {
      terminal: targetHandle,
      text,
      ...(queryReply ? { inputKind: 'query-reply' } : { requireWriteSettlement: true as const }),
      client: { id: clientId, type: 'desktop' },
      ...(desiredViewport ? { viewport: desiredViewport, claimViewport: true as const } : {})
    })
      .then((result) => {
        if (
          connected &&
          lifecycleEpoch === targetLifecycleEpoch &&
          handle === targetHandle &&
          !queryReply &&
          result.send.writeSettlement?.outcome === 'unverifiable'
        ) {
          warnRemoteTerminalInputDelivery(currentRuntimeEnvironmentId, targetHandle)
        }
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
          notifyWriteUnavailable()
        } else {
          if (!queryReply) {
            warnRemoteTerminalInputDelivery(currentRuntimeEnvironmentId, targetHandle)
          }
          handleRemoteTerminalError(error)
        }
      })
    return true
  }

  const inputBatcher = createRemoteRuntimePtyTextBatcher(
    REMOTE_TERMINAL_INPUT_FLUSH_MS,
    sendUnacknowledgedInput
  )

  function sendViewportUpdate(cols: number, rows: number, claim = false): void {
    const targetHandle = handle
    if (!connected || !targetHandle || recoveryBlocksIo()) {
      return
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (claim ? stream?.claimViewport(cols, rows) : stream?.resize(cols, rows)) {
      if (claim && stream) {
        flushPendingClaimInput(stream)
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
    recoveryInputHold.discard()
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

  function rebindRemoteTerminalHandle(
    nextHandle: string,
    nextIncarnationId: string | null = null
  ): void {
    clearPublishedHandleWait()
    // Why: keys typed at the replaced shell must not run in its successor (#10065).
    recoveryInputHold.discard()
    const replacedPtyId = remotePtyId
    unregisterShutdownHandlers(replacedPtyId)
    handle = nextHandle
    remotePtyId = toRemoteRuntimePtyId(nextHandle, currentRuntimeEnvironmentId)
    authoritativePtyIncarnationId = nextIncarnationId
    resetRecoveryReplacementPolicy()
    resetSameHandleEndReuse()
    registerShutdownHandlers(remotePtyId)
    setAttachmentReady(false)
    // Why: host handle rotation preserves the pane generation; only the store identity changes, not spawn/exit semantics.
    if (replacedPtyId) {
      replaceFitOverridePtyId(replacedPtyId, remotePtyId)
      replaceDriverPtyId(replacedPtyId, remotePtyId)
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
          // The host stopped publishing this surface, but that absence does
          // not prove the remote process exited (the runtime may be restarting).
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
          // Why: once the auto-recovery window is spent, a host still publishing this surface is evidence the fenced handle outlived the stale error.
          // Why: one reattach per spent window, so a handle that really is dead is not retried on every host snapshot.
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
    if (message === REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE) {
      // Why: an oversized initial snapshot is skipped but live output keeps flowing — informational, not fatal.
      return
    }
    if (isRemoteTerminalStaleMessage(message)) {
      if (tabId && leafId && worktreeId) {
        // Why: reconnect can re-mint a pane handle while its host coordinates live; keep xterm state mounted while re-resolving.
        closeMultiplexedStream()
        scheduleResubscribeAfterTransportClose('require-replacement')
      } else {
        // A stale handle without a replacement is an attachment loss, not
        // evidence that the process behind it died.
        retireRemoteTerminalId(-1)
      }
      return
    }
    if (isRemoteTerminalGoneMessage(message)) {
      // Why: an explicit terminal-gone response is lifecycle evidence, unlike a replaceable stale handle seen during reconnect.
      retireRemoteTerminalId()
      return
    }
    if (isSshSessionGoneError(message)) {
      // Why: only the HUB may replace its expired SSH pane; a paired viewer must never fall back to
      // client-local SSH. The identity-mismatch suffix is excluded because it means the opposite —
      // the relay found a LIVE PTY under that id owned by another pane — and this is the one
      // transport that actually calls terminal.recoverPane, so a bare substring test here spawned
      // a second agent onto one transcript.
      recoverExpiredHostPane()
      return
    }
    const clientError = toRemoteRuntimeClientErrorLike(error)
    if (isRuntimeRpcQueueOverloadError(clientError)) {
      scheduleCapacityPressureRetry()
      return
    }
    if (isRecoverablePaneBindingError(error)) {
      // Why: a partition is attachment state, not a terminal failure; keep the red error surface for actionable fatal errors.
      scheduleResubscribeAfterTransportClose()
      return
    }
    connecting = false
    recoveryInputHold.discard()
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
      return true
    }
    scheduleResubscribeAfterTransportClose()
    return true
  }

  // Why: after a transport drop the host may have re-minted this handle; re-derive from the snapshot so we don't mirror/type into whatever PTY now sits behind the stale one (#7718).
  async function resubscribeAfterTransportClose(
    previousHandle: string,
    replacementPolicy: HostHandleReplacementPolicy,
    recoveryEpoch: number
  ): Promise<void> {
    if (tabId && isWebTerminalSurfaceTabId(tabId)) {
      const hostTabId = toHostSessionTabId(tabId)
      const inventoryWindow = beginResubscribeInventoryWindow(recoveryEpoch)
      const waitResult = await waitForResubscribeHostSessionHandle(
        hostTabId,
        previousHandle,
        replacementPolicy,
        recoveryEpoch
      )
      const nextHandle = waitResult.handle
      if (
        destroyed ||
        !connected ||
        handle !== previousHandle ||
        !recovery.isCurrent(recoveryEpoch)
      ) {
        return
      }
      if (nextHandle === undefined) {
        const effectivePolicy = stricterReplacementPolicy(
          replacementPolicy,
          getRecoveryReplacementPolicy(previousHandle)
        )
        if (
          effectivePolicy !== 'require-replacement' &&
          waitResult.inventoryFailed &&
          inventoryWindow < HOST_SESSION_INVENTORY_MAX_WINDOWS_PER_RECOVERY
        ) {
          throw Object.assign(new Error('Remote runtime session inventory polling failed.'), {
            code: 'remote_runtime_unavailable'
          })
        }
        // Why: liveness is unknown, so auto-retry stops here; keep an unarmed retry parked for online/resume/reconnect to fire.
        recovery.parkRetryForExternalTrigger(recoveryEpoch, (nextEpoch) => {
          // Why: an external trigger is a fresh attempt, not a repeated stale send, so it takes over this epoch's snapshot wait.
          clearPublishedHandleWait()
          scheduleResubscribeAfterTransportClose(
            handle ? getRecoveryReplacementPolicy(handle) : 'reuse',
            nextEpoch
          )
        })
        return
      }
      if (!nextHandle) {
        // Why: host no longer publishes this surface; retire quietly and let the next session-tabs snapshot drive respawn/removal.
        // Inventory absence is not process-liveness evidence; keep the tab
        // recoverable until a later authoritative snapshot settles it.
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
      if (destroyed || !connected || handle !== previousHandle) {
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
      // Why: bytes queued before a partition have unknown delivery; never replay them on a replacement stream.
      inputBatcher.clear()
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
            recovery.markDisconnected()
            // Why: stale/gone/SSH-expired handling lives in handleRemoteTerminalError; its
            // fallthrough surfaces the message, so routing here keeps those recoveries alive.
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

  function scheduleCapacityPressureRetry(): void {
    if (destroyed || !connected || !handle) {
      return
    }
    const recoveryWasActive = recovery.isActive
    const recoveryEpoch = recovery.begin()
    if (!recoveryWasActive) {
      inputBatcher.clear()
      viewportBatcher.clear()
      clearPendingViewportClaim()
    }
    recovery.schedule(recoveryEpoch, (nextEpoch) => {
      scheduleResubscribeAfterTransportClose('reuse', nextEpoch)
    })
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
    setAttachmentReady(false)
    let transportClosed = false
    let subscriptionAttached = false
    let subscriptionSnapshotHadContent = false
    // Why: viewport handed to subscribe; a resize during the round-trip falls back to the refresh-only one-shot RPC, replayed through the stream below once current.
    const subscribedViewport = desiredViewport
    const isCurrentSubscription = (): boolean =>
      !transportClosed &&
      generation === subscriptionGeneration &&
      (expectedRecoveryEpoch === undefined || recovery.ownsEpoch(expectedRecoveryEpoch)) &&
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
            subscriptionSnapshotHadContent = true
            if (subscribedPtyId && bufferPtyShutdownReplayData(subscribedPtyId, data)) {
              return
            }
            outputProcessor.processData(data, storedCallbacks, {
              replayingBufferedData: true,
              suppressAttentionEvents: true,
              ...(meta?.pendingEscapeTailAnsi
                ? { pendingEscapeTailAnsi: meta.pendingEscapeTailAnsi }
                : {}),
              // Why both or neither: the host's flags describe this image's own
              // boundary, so an unsequenced snapshot proves nothing.
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
              // Why unconditional on seq: the grid describes the image itself,
              // not a stream boundary, so it is valid for every snapshot the
              // host dimensions. Absent/zero degrades to the pane's own grid.
              ...(meta?.cols !== undefined && meta.rows !== undefined
                ? { snapshotCols: meta.cols, snapshotRows: meta.rows }
                : {}),
              ...(meta?.keepsLocalScrollback ? { keepsLocalScrollback: true } : {}),
              carriesNormalBuffer: true
            })
          }
        },
        onOutputPauseCapability: () => {
          if (isCurrentSubscription()) {
            storedCallbacks.onOutputPauseChanged?.(
              desiredOutputPaused,
              nextStream.setOutputPaused(desiredOutputPaused)
            )
          }
        },
        onSubscribed: () => {
          if (!isCurrentSubscription()) {
            return
          }
          storedCallbacks.onOutputPauseChanged?.(
            desiredOutputPaused,
            nextStream.setOutputPaused(desiredOutputPaused)
          )
          if (!subscriptionAttached && sameHandleEndRecovery) {
            recordSameHandleEndReuse(subscribedHandle)
          }
          subscriptionAttached = true
          setAttachmentReady(true)
          connecting = false
          resetRecoveryReplacementPolicy()
          markRecoveryHealthy()
          emitRecoveryState()
          storedCallbacks.onConnect?.()
          // Why: a recovery subscribe replays nothing when the host's push snapshot is
          // empty (idle or exited pane), so ask for the retained buffer instead of
          // waiting for bytes that an exited process will never send.
          if (expectedRecoveryEpoch !== undefined && !subscriptionSnapshotHadContent) {
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
            setAttachmentReady(false)
            multiplexedStream = null
            multiplexedStreamHandle = null
            clearPendingViewportClaim()
            // Why: a legacy bare end or waiter failure proves only attachment loss; bounded same-handle reuse preserves the tab without looping forever.
            scheduleResubscribeAfterTransportClose(
              replacementPolicyAfterStreamEnd(subscribedHandle)
            )
            return
          }
          unregisterShutdownHandlers(subscribedPtyId)
          recoveryInputHold.discard()
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
          if (isCurrentSubscription() && subscribedPtyId) {
            setFitOverride(subscribedPtyId, event.mode, event.cols, event.rows)
          }
        },
        onDriverChanged: (driver) => {
          if (isCurrentSubscription() && subscribedPtyId) {
            setDriverForPty(subscribedPtyId, driver)
          }
        },
        onInputUnverifiable: () => {
          if (isCurrentSubscription()) {
            warnRemoteTerminalInputDelivery(currentRuntimeEnvironmentId, subscribedHandle)
          }
        },
        onWriteUnavailable: () => {
          if (isCurrentSubscription()) {
            notifyWriteUnavailable()
          }
        },
        onTransportClose: ({ recoverable, retryWithBackoff }) => {
          transportClosed = true
          if (generation !== subscriptionGeneration) {
            return
          }
          if (!isCurrentSubscription()) {
            // isCurrentSubscription excludes the just-closed stream by design.
            if (!isCurrentRemoteTerminal(subscribedHandle, subscribedPtyId)) {
              return
            }
          }
          multiplexedStream = null
          multiplexedStreamHandle = null
          setAttachmentReady(false)
          resetSameHandleEndReuse()
          if (recoverable) {
            if (retryWithBackoff) {
              scheduleCapacityPressureRetry()
            } else {
              scheduleResubscribeAfterTransportClose()
            }
          } else {
            connecting = false
            recoveryInputHold.discard()
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
      (expectedRecoveryEpoch !== undefined && !recovery.ownsEpoch(expectedRecoveryEpoch)) ||
      destroyed ||
      !connected ||
      handle !== subscribedHandle ||
      remotePtyId !== subscribedPtyId
    ) {
      nextStream.close()
      return
    }
    closeMultiplexedStream()
    multiplexedStream = nextStream
    multiplexedStreamHandle = subscribedHandle
    setAttachmentReady(subscriptionAttached)
    if (subscriptionAttached) {
      resetRecoveryReplacementPolicy()
      markRecoveryHealthy()
    }
    // Why: a viewport change during the subscribe round-trip hit the no-op one-shot fallback; replay the latest viewport so the PTY isn't stuck at subscribe-time size.
    if (pendingViewportClaim && desiredViewport) {
      nextStream.claimViewport(desiredViewport.cols, desiredViewport.rows)
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

  // Why replay: a recovery retry re-enters attach inside its own epoch; cancelling it would restart
  // the backoff ladder forever and the auto-recovery deadline could never latch (#18495).
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
      recoveryInputHold.discard()
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
        // Why: the host answered, but its pane registry may still be rebuilding after a restart,
        // so retire with the host-loss sentinel instead of closing the tab outright (#21344).
        remotePtyId = options.existingPtyId
        retireRemoteTerminalId(-1)
        return
      }
      // Why: a host that cannot resolve this pane gives no later answer to wait for; settle offline.
      connecting = false
      emitRecoveryState()
    })().catch((error) => {
      if (generation !== attachGeneration || attachLifecycleEpoch !== lifecycleEpoch || destroyed) {
        return
      }
      clearPendingViewportClaim()
      if (!connected && isRetryableUnboundAttachError(error)) {
        // Why: no handle is bound yet, so the resubscribe path cannot own this retry; replay attach
        // instead of latching in 'connecting' with nothing armed (#18495).
        connecting = false
        scheduleConnectRetryAfterRecoverableFailure()
        return
      }
      recovery.cancel()
      handleRemoteTerminalError(error)
    })
  }

  function sendInputNow(data: string): boolean {
    if (!connected || !handle || recoveryBlocksIo()) {
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
    if (!connected || !targetHandle || recoveryBlocksIo()) {
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
          recoveryBlocksIo()
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

  let connectForRecovery: PtyTransport['connect'] = (options) => transport.connect(options)
  const transport: PtyTransport = {
    async connect(options) {
      cancelTerminalCreateRetryWait()
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

      try {
        if (isWebTerminalSurfaceTabId(tabId ?? '')) {
          // Reattach callbacks must not publish the replacement as a fresh
          // spawn before the reattach result commits tab/layout ownership.
          return await attachHostSessionMirror(
            options,
            !options.sessionId,
            undefined,
            connectLifecycleEpoch
          )
        }

        if (options.sessionId && !getRemoteRuntimeTerminalHandle(options.sessionId)) {
          // Why: a HUB session persists host-native PTY ids; resolve its pane handle without exposing that SSH identity as a client transport id.
          const resolution = await resolvePersistedHostPane()
          if (resolution.kind === 'resolved') {
            return await adoptResolvedHostPane(resolution.terminal, options)
          }
        }

        const commandToSend = options.command ?? command
        const startupCommandDeliveryToSend =
          options.startupCommandDelivery ?? startupCommandDelivery
        const envToSend = options.env ?? env
        const envToDeleteToSend = options.envToDelete ?? envToDelete
        const launchConfigToSend = options.launchConfig ?? launchConfig
        const resumeProviderSessionToSend = options.resumeProviderSession ?? resumeProviderSession
        const launchTokenToSend = options.launchToken ?? launchToken
        const launchAgentToSend = options.launchAgent ?? launchAgent
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
          ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
          ...(terminalKittyKeyboardProtocol === true
            ? { terminalKittyKeyboardProtocol: true }
            : {}),
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
                      providerSession: resumeProviderSessionToSend,
                      ...(launchConfigToSend?.ompResumeFilePath
                        ? { ompResumeFilePath: launchConfigToSend.ompResumeFilePath }
                        : {}),
                      ...(agentArgsOverride !== undefined ? { agentArgs: agentArgsOverride } : {}),
                      ...(agentLaunchPreferences
                        ? { launchPreferences: agentLaunchPreferences }
                        : {}),
                      placement: { tabId, leafId },
                      presentation: 'background'
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
                        ...(agentArgsOverride !== undefined
                          ? { agentArgs: agentArgsOverride }
                          : {}),
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
            (createdTerminal.handle !== handle ||
              createEnvironmentId !== currentRuntimeEnvironmentId)
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
          ...(authoritativePtyIncarnationId
            ? { incarnationId: authoritativePtyIncarnationId }
            : {}),
          ...(createdTerminal.isReattach === true ? { isReattach: true } : {})
        } satisfies PtyConnectResult
      } catch (error) {
        if (!destroyed && lifecycleEpoch === connectLifecycleEpoch) {
          connecting = false
          const message = runtimeTerminalErrorMessage(error)
          if (isRemoteTerminalGoneMessage(message)) {
            recovery.cancel()
            handleRemoteTerminalError(error)
          } else if (isRecoverablePaneBindingError(error)) {
            scheduleConnectRetryAfterRecoverableFailure()
          } else {
            recovery.cancel()
            emitRecoveryState()
            surfaceErrorMessage(message)
          }
        }
        return undefined
      }
    },

    attach(options) {
      attachPane(options, false)
    },

    disconnect() {
      lifecycleEpoch += 1
      attachGeneration += 1
      recoveryInputHold.discard()
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
        // disconnect() tears down only this viewer's stream; it never asks the
        // remote host to stop the PTY, so an exit here is unverifiable.
        onPtyExit?.(id, -1)
      }
    },

    detach() {
      // Why first: the successor transport owns the PTY after detach, and the batcher flushes
      // below can throw past the census drop — a stranded gauge outlives the transport.
      outputProcessor.disposePendingSideEffectGauge()
      lifecycleEpoch += 1
      attachGeneration += 1
      recoveryInputHold.discard()
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
      const held = releaseThenHoldEndpoint(inputKind)
      if (held) {
        return !data || recoveryInputHold.enqueue(held, data, inputKind)
      }
      return sendInputNow(data)
    },

    // Why: query replies (CPR/DSR/DA/OSC) are read in raw mode with a short timeout; the 8ms debounce would miss it and echo the reply onto the prompt (#7329).
    sendInputImmediate: (data: string): boolean => sendInputImmediateNow(data),

    sendInputAccepted(data, inputKind) {
      const held = releaseThenHoldEndpoint(inputKind)
      if (held && data) {
        return recoveryInputHold.enqueueAccepted(held, data, inputKind)
      }
      return sendInputAcceptedToRuntime(data)
    },

    // Why: a transport with an armed retry or a parked one owns this pane's recovery; a remount would race it (#21195).
    ownsRecovery() {
      return !destroyed && !terminalEnded && recoveryBlocksIo()
    },

    claimViewport(cols: number, rows: number): boolean {
      if (!connected || !handle) {
        return false
      }
      rememberViewport(cols, rows)
      if (recoveryBlocksIo()) {
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
      const supported = getCurrentMultiplexedStream(handle)?.setOutputPaused(paused) === true
      storedCallbacks.onOutputPauseChanged?.(paused, supported)
      return supported
    },

    resize(cols: number, rows: number, meta): boolean {
      if (!connected || !handle) {
        return false
      }
      rememberViewport(cols, rows)
      if (recoveryBlocksIo()) {
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
      if (
        !destroyed &&
        !terminalEnded &&
        !connected &&
        isWebTerminalSurfaceTabId(tabId ?? '') &&
        recovery.currentPhase === 'disconnected'
      ) {
        recovery.cancel()
        if (replayLastTransportEntryPoint()) {
          return true
        }
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
        void connectForRecovery(lastConnectOptions)
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

    setConnectForRecovery(connect) {
      connectForRecovery = connect
    },
    destroy() {
      destroyed = true
      setAttachmentUnavailable()
      // Why finally: disconnect runs consumer onDisconnect/onPtyExit callbacks; a throw there
      // must not strand the gauge in the very path where teardown already went wrong.
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
  return withRemoteReattachInputBuffer(transport)
}
