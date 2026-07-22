/* eslint-disable max-lines -- Why: remote PTY transport keeps lifecycle, JSON fallback, and binary stream wiring together so reconnect/destroy ordering stays testable as one behavior surface. */
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../../shared/remote-runtime-client-error-classification'
import type {
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionResult
} from '../../../../shared/agent-session-host-authority'
import type {
  RuntimeMobileSessionTerminalClientTab,
  RuntimeMobileSessionTabsResult,
  RuntimeStatus,
  RuntimeTerminalCreate,
  RuntimeTerminalSend
} from '../../../../shared/runtime-types'
import { TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
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
import { unwrapRuntimeRpcResult } from '../../runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle,
  runtimeTerminalErrorMessage,
  toRemoteRuntimePtyId
} from '../../runtime/runtime-terminal-stream'
import {
  getRemoteRuntimeTerminalMultiplexer,
  REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE,
  type RemoteRuntimeMultiplexedTerminal
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
import { listRemoteRuntimeSessionTabsDeduped } from '@/runtime/remote-runtime-session-tabs-inflight'
import { subscribeAcceptedWebSessionTerminalHandle } from '@/runtime/web-session-terminal-handle-events'
import { runRemoteAgentSessionLaunch } from '@/runtime/remote-agent-session-launch'
import { useAppStore } from '@/store'
import { recordWebAgentSessionHandoff } from '@/runtime/web-agent-session-handoff'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-runtime-session'

const REMOTE_TERMINAL_INPUT_FLUSH_MS = 8
const REMOTE_TERMINAL_VIEWPORT_FLUSH_MS = 33
const HOST_SESSION_ATTACH_POLL_MS = 150
const HOST_SESSION_REPLACEMENT_POLL_MAX_MS = 1_000
const HOST_SESSION_ATTACH_TIMEOUT_MS = 15_000
const TERMINAL_CREATE_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const

type RemoteAgentSessionLaunchResult =
  | RuntimeEnsureAgentSessionResult
  | RuntimeCreateAgentSessionResult
  | { terminal: RuntimeTerminalCreate; disposition?: undefined }

function isRemoteTerminalStaleMessage(message: string): boolean {
  return message.includes('terminal_handle_stale')
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
    agentPrompt,
    agentPromptDelivery,
    agentArgsOverride,
    agentLaunchPreferences,
    worktreeId,
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
  // Why: transport methods overlap during remounts; only the latest pane lifecycle may install a returned PTY.
  let lifecycleEpoch = 0
  let handle: string | null = null
  let remotePtyId: string | null = null
  let currentRuntimeEnvironmentId = runtimeEnvironmentId
  let multiplexedStream: RemoteRuntimeMultiplexedTerminal | null = null
  let multiplexedStreamHandle: string | null = null
  let desiredViewport: { cols: number; rows: number } | null = null
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}
  let resubscribeEpoch: number | null = null
  let resubscribeRequestedHandle: string | null = null
  let resubscribeRequestedRequiresReplacement = false
  let recoveryRequiresReplacement = false
  let stopWaitingForPublishedHandle: (() => void) | null = null
  let subscriptionGeneration = 0
  const recovery = new RemoteRuntimePtyRecoveryState(() => {
    if (recovery.currentPhase === 'disconnected') {
      clearPublishedHandleWait()
      // Why: cached pixels may remain, but no stream from the exhausted epoch may keep delivering or accepting terminal traffic.
      subscriptionGeneration += 1
      closeMultiplexedStream()
    }
    emitRecoveryState()
  })
  let lastRecoveryStateKey = ''
  let pendingViewportClaim = false
  let pendingClaimInput = ''
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
  const viewportClaimReadyWaiters = new Set<(ready: boolean) => void>()
  const clearPendingViewportClaim = (): void => {
    pendingViewportClaim = false
    pendingClaimInput = ''
    for (const resolve of viewportClaimReadyWaiters) {
      resolve(false)
    }
    viewportClaimReadyWaiters.clear()
  }
  // Why: tab/leaf ids are shared by paired viewers; the instance suffix keeps one viewer's refresh off peer records.
  const clientId = `desktop:${tabId ?? 'tab'}:${leafId ?? 'leaf'}:${createBrowserUuid()}`
  const terminalCreateMutationId = createBrowserUuid()
  // Why: reconnect retries must replay one host operation instead of creating
  // another fresh agent when the first response was lost.
  const agentCreateOperation = createAgentSessionCreateOperation()
  const outputProcessor = createPtyOutputProcessor({
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  })

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

  function hostSnapshotOwnsLaunch(
    result: RemoteAgentSessionLaunchResult,
    environmentId: string
  ): boolean {
    if (result.disposition !== undefined) {
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
    if (leafId) {
      const requestedLeaf = terminalTabs.find(
        (tab) => tab.status === 'ready' && tab.parentTabId === hostTabId && tab.leafId === leafId
      )
      return requestedLeaf?.terminal ?? null
    }
    const preferred =
      terminalTabs.find(
        (tab) => tab.status === 'ready' && tab.parentTabId === hostTabId && tab.isActive
      ) ?? terminalTabs.find((tab) => tab.status === 'ready' && tab.parentTabId === hostTabId)
    return preferred?.terminal ?? null
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

  async function waitForHostSessionHandle(hostTabId: string): Promise<string | null> {
    if (!worktreeId) {
      return null
    }
    const worktree = toRuntimeWorktreeSelector(worktreeId)
    const activated = await callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.activate', {
      worktree,
      tabId: hostTabId,
      ...(leafId ? { leafId } : {}),
      notifyClients: false,
      navigation: 'caller'
    })
    const immediate = findReadyHostSessionHandle(activated, hostTabId)
    if (immediate) {
      return immediate
    }

    const startedAt = Date.now()
    while (!destroyed) {
      const remainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (remainingMs <= 0) {
        return null
      }
      // Why: host mirrors can publish before their PTY handle is ready, but a stuck pending surface must not poll forever.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(HOST_SESSION_ATTACH_POLL_MS, remainingMs))
      )
      const listed = await listRemoteRuntimeSessionTabsDeduped({
        environmentId: currentRuntimeEnvironmentId,
        worktreeId,
        load: () =>
          callRuntime<RuntimeMobileSessionTabsResult>('session.tabs.list', {
            worktree
          })
      })
      const handle = findReadyHostSessionHandle(listed, hostTabId)
      if (handle) {
        return handle
      }
      if (!hasHostSessionTerminalSurface(listed, hostTabId)) {
        return null
      }
    }
    return null
  }

  async function waitForResubscribeHostSessionHandle(
    hostTabId: string,
    previousHandle: string,
    requireReplacement: boolean
  ): Promise<string | null | undefined> {
    if (!worktreeId) {
      return null
    }
    const worktree = toRuntimeWorktreeSelector(worktreeId)
    const startedAt = Date.now()
    let pollMs = HOST_SESSION_ATTACH_POLL_MS
    let lastListError: unknown = null
    const finishWithUnknownLiveness = (): undefined => {
      if (lastListError) {
        console.warn(
          '[remote-runtime-pty] host session inventory unavailable during reconnect:',
          runtimeTerminalErrorMessage(lastListError)
        )
      }
      // Why: a bounded wait without removal evidence is unknown liveness; keep the pane for a later snapshot to reattach.
      return undefined
    }
    while (!destroyed && connected && handle === previousHandle) {
      const requestRemainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (requestRemainingMs <= 0) {
        return finishWithUnknownLiveness()
      }
      try {
        const listed = await listRemoteRuntimeSessionTabsDeduped({
          environmentId: currentRuntimeEnvironmentId,
          worktreeId,
          load: () =>
            callRuntime<RuntimeMobileSessionTabsResult>(
              'session.tabs.list',
              {
                worktree
              },
              requestRemainingMs
            )
        })
        lastListError = null
        const nextHandle = findReadyHostSessionHandle(listed, hostTabId)
        if (nextHandle && (!requireReplacement || nextHandle !== previousHandle)) {
          return nextHandle
        }
        if (!hasHostSessionTerminalSurface(listed, hostTabId)) {
          return null
        }
      } catch (error) {
        // Why: the inventory can race the reconnect that invalidated the handle; unknown liveness must not retire the pane.
        lastListError = error
      }
      const remainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (remainingMs <= 0) {
        return finishWithUnknownLiveness()
      }
      // Why: a stale response can precede its replacement; bounded backoff avoids retrying the stale handle in a hot loop.
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)))
      pollMs = Math.min(pollMs * 2, HOST_SESSION_REPLACEMENT_POLL_MAX_MS)
    }
    return undefined
  }

  async function attachHostSessionMirror(
    options: Parameters<PtyTransport['connect']>[0]
  ): Promise<PtyConnectResult | undefined> {
    if (!tabId || !isWebTerminalSurfaceTabId(tabId)) {
      return undefined
    }
    const hostTabId = toHostSessionTabId(tabId)
    const hostHandle = await waitForHostSessionHandle(hostTabId)
    if (!hostHandle || destroyed) {
      if (!destroyed) {
        storedCallbacks.onError?.('Remote terminal was closed.')
      }
      return undefined
    }

    handle = hostHandle
    remotePtyId = toRemoteRuntimePtyId(hostHandle, currentRuntimeEnvironmentId)
    connected = true
    desiredViewport = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24
    }
    onPtySpawn?.(remotePtyId)

    try {
      await subscribeToHandle()
    } catch (error) {
      if (!recoverAfterSubscribeFailure(error, hostHandle, remotePtyId)) {
        throw error
      }
    }
    if (destroyed || !connected || !remotePtyId) {
      return undefined
    }

    return {
      id: remotePtyId,
      replay: ''
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
      timeoutMs
    })
    return unwrapRuntimeRpcResult(response as RuntimeRpcResponse<TResult>)
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
      handleRemoteTerminalError(error)
      return false
    }
  }

  const inputBatcher = createRemoteRuntimePtyTextBatcher(REMOTE_TERMINAL_INPUT_FLUSH_MS, (text) => {
    const targetHandle = handle
    if (!connected || !targetHandle || recoveryBlocksIo()) {
      return
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (stream?.sendInput(text)) {
      return
    }
    if (pendingViewportClaim) {
      // Why: a claim during subscribe/reconnect has no stream record yet; hold its input so the stream emits claim+input in one order.
      pendingClaimInput += text
      return
    }
    void callRuntime('terminal.send', {
      terminal: targetHandle,
      text,
      client: { id: clientId, type: 'desktop' },
      ...(desiredViewport ? { viewport: desiredViewport, claimViewport: true as const } : {})
    }).catch((error) => {
      handleRemoteTerminalError(error)
    })
  })

  function sendViewportUpdate(cols: number, rows: number, claim = false): void {
    const targetHandle = handle
    if (!connected || !targetHandle || recoveryBlocksIo()) {
      return
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (claim ? stream?.claimViewport(cols, rows) : stream?.resize(cols, rows)) {
      if (claim) {
        pendingViewportClaim = false
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
    attachmentReady = false
  }

  function clearPublishedHandleWait(): void {
    stopWaitingForPublishedHandle?.()
    stopWaitingForPublishedHandle = null
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

  function retireRemoteTerminalId(): void {
    recovery.cancel()
    recoveryRequiresReplacement = false
    connected = false
    connecting = false
    terminalEnded = true
    clearPublishedHandleWait()
    clearPendingViewportClaim()
    const stalePtyId = remotePtyId
    handle = null
    remotePtyId = null
    closeMultiplexedStream()
    emitRecoveryState()
    if (stalePtyId) {
      onPtyExit?.(stalePtyId)
    }
  }

  function rebindRemoteTerminalHandle(nextHandle: string): void {
    clearPublishedHandleWait()
    const replacedPtyId = remotePtyId
    handle = nextHandle
    remotePtyId = toRemoteRuntimePtyId(nextHandle, currentRuntimeEnvironmentId)
    attachmentReady = false
    // Why: host handle rotation preserves the pane generation; only the store identity changes, not spawn/exit semantics.
    if (replacedPtyId) {
      replaceFitOverridePtyId(replacedPtyId, remotePtyId)
      replaceDriverPtyId(replacedPtyId, remotePtyId)
      onPtyRebind?.(remotePtyId, replacedPtyId)
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
          retireRemoteTerminalId()
          return
        }
        if (!update.terminalHandle || update.terminalHandle === previousHandle) {
          return
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
      if (tabId && isWebTerminalSurfaceTabId(tabId)) {
        // Why: reconnect can re-mint a mirrored pane's handle while its host tab lives; keep xterm/composer state mounted while re-resolving.
        closeMultiplexedStream()
        scheduleResubscribeAfterTransportClose(true)
      } else {
        retireRemoteTerminalId()
      }
      return
    }
    if (isRemoteTerminalGoneMessage(message)) {
      // Why: an explicit terminal-gone response is lifecycle evidence, unlike a replaceable stale handle seen during reconnect.
      retireRemoteTerminalId()
      return
    }
    if (isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))) {
      // Why: a partition is attachment state, not a terminal failure; keep the red error surface for actionable fatal errors.
      scheduleResubscribeAfterTransportClose()
      return
    }
    connecting = false
    emitRecoveryState()
    storedCallbacks.onError?.(message)
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
    if (!isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))) {
      return false
    }
    scheduleResubscribeAfterTransportClose()
    return true
  }

  // Why: after a transport drop the host may have re-minted this handle; re-derive from the snapshot so we don't mirror/type into whatever PTY now sits behind the stale one (#7718).
  async function resubscribeAfterTransportClose(
    previousHandle: string,
    requireReplacement: boolean,
    recoveryEpoch: number
  ): Promise<void> {
    if (tabId && isWebTerminalSurfaceTabId(tabId)) {
      const hostTabId = toHostSessionTabId(tabId)
      const nextHandle = await waitForResubscribeHostSessionHandle(
        hostTabId,
        previousHandle,
        requireReplacement
      )
      if (
        destroyed ||
        !connected ||
        handle !== previousHandle ||
        !recovery.isCurrent(recoveryEpoch)
      ) {
        return
      }
      if (nextHandle === undefined) {
        return
      }
      if (!nextHandle) {
        // Why: host no longer publishes this surface; retire quietly and let the next session-tabs snapshot drive respawn/removal.
        retireRemoteTerminalId()
        return
      }
      if (nextHandle !== previousHandle) {
        rebindRemoteTerminalHandle(nextHandle)
      }
    }
    clearPublishedHandleWait()
    await subscribeToHandle(recoveryEpoch)
  }

  function scheduleResubscribeAfterTransportClose(
    requireReplacement = false,
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
    recoveryRequiresReplacement ||= requireReplacement
    if (requireReplacement && stopWaitingForPublishedHandle) {
      // Why: once recovery is handed to accepted snapshots, repeated sends to the stale handle must not re-arm inventory RPCs.
      return
    }
    if (resubscribeEpoch === recoveryEpoch) {
      // Why: concurrent stale errors belong to their own handle; don't carry an old handle's replacement requirement onto its successor.
      if (resubscribeRequestedHandle !== handle) {
        resubscribeRequestedHandle = handle
        resubscribeRequestedRequiresReplacement = requireReplacement
      } else {
        resubscribeRequestedRequiresReplacement ||= requireReplacement
      }
      return
    }
    const resubscribeHandle = handle
    clearPublishedHandleWait()
    if (tabId && isWebTerminalSurfaceTabId(tabId)) {
      // Why: subscribe before polling so a fresh host snapshot can't land in the gap between the inventory loop and its event-driven fallback.
      waitForPublishedHostSessionHandle(toHostSessionTabId(tabId), resubscribeHandle)
    }
    resubscribeEpoch = recoveryEpoch
    resubscribeRequestedHandle = null
    resubscribeRequestedRequiresReplacement = false
    let retryScheduled = false
    void resubscribeAfterTransportClose(resubscribeHandle, requireReplacement, recoveryEpoch)
      .catch((error) => {
        if (!destroyed && connected && handle && recovery.isCurrent(recoveryEpoch)) {
          clearPendingViewportClaim()
          const clientError = toRemoteRuntimeClientErrorLike(error)
          if (isRecoverableRemoteRuntimeConnectionError(clientError)) {
            retryScheduled = recovery.schedule(recoveryEpoch, (nextEpoch) => {
              scheduleResubscribeAfterTransportClose(requireReplacement, nextEpoch)
            })
          } else {
            recovery.cancel()
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
        const pendingRequiresReplacement = resubscribeRequestedRequiresReplacement
        resubscribeRequestedHandle = null
        resubscribeRequestedRequiresReplacement = false
        if (
          !retryScheduled &&
          recovery.isCurrent(recoveryEpoch) &&
          !stopWaitingForPublishedHandle &&
          pendingHandle &&
          pendingHandle === handle &&
          !getCurrentMultiplexedStream(pendingHandle)
        ) {
          scheduleResubscribeAfterTransportClose(pendingRequiresReplacement)
        }
      })
  }

  async function subscribeToHandle(expectedRecoveryEpoch?: number): Promise<void> {
    if (!handle) {
      return
    }
    const subscribedHandle = handle
    const subscribedPtyId = remotePtyId
    const generation = ++subscriptionGeneration
    attachmentReady = false
    let transportClosed = false
    let subscriptionAttached = false
    // Why: viewport handed to subscribe; a resize during the round-trip falls back to the refresh-only one-shot RPC, replayed through the stream below once current.
    const subscribedViewport = desiredViewport
    const isCurrentSubscription = (): boolean =>
      !transportClosed &&
      generation === subscriptionGeneration &&
      (expectedRecoveryEpoch === undefined || recovery.ownsEpoch(expectedRecoveryEpoch)) &&
      isCurrentRemoteTerminal(subscribedHandle, subscribedPtyId)
    const nextStream = await getRemoteRuntimeTerminalMultiplexer(
      currentRuntimeEnvironmentId
    ).subscribeTerminal({
      terminal: subscribedHandle,
      client: { id: clientId, type: 'desktop' },
      viewport: subscribedViewport ?? undefined,
      callbacks: {
        onData: (data, meta) => {
          if (isCurrentSubscription()) {
            outputProcessor.processData(data, storedCallbacks, undefined, meta)
          }
        },
        onSnapshot: (data, meta) => {
          // Why: an empty snapshot can still carry a pending mid-escape tail that must replay so the next live chunk completes it.
          if ((data || meta?.pendingEscapeTailAnsi) && isCurrentSubscription()) {
            outputProcessor.processData(data, storedCallbacks, {
              replayingBufferedData: true,
              suppressAttentionEvents: true,
              ...(meta?.pendingEscapeTailAnsi
                ? { pendingEscapeTailAnsi: meta.pendingEscapeTailAnsi }
                : {})
            })
          }
        },
        onSubscribed: () => {
          if (!isCurrentSubscription()) {
            return
          }
          subscriptionAttached = true
          attachmentReady = true
          connecting = false
          recoveryRequiresReplacement = false
          recovery.markHealthy()
          emitRecoveryState()
          storedCallbacks.onConnect?.()
          storedCallbacks.onStatus?.('shell')
        },
        onEnd: () => {
          if (!isCurrentSubscription()) {
            return
          }
          outputProcessor.clearAccumulatedState()
          connected = false
          connecting = false
          handle = null
          remotePtyId = null
          multiplexedStream = null
          multiplexedStreamHandle = null
          attachmentReady = false
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
        onTransportClose: ({ recoverable }) => {
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
          attachmentReady = false
          if (recoverable) {
            scheduleResubscribeAfterTransportClose()
          } else {
            connecting = false
            recovery.cancel()
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
    attachmentReady = subscriptionAttached
    if (subscriptionAttached) {
      recoveryRequiresReplacement = false
      recovery.markHealthy()
    }
    // Why: a viewport change during the subscribe round-trip hit the no-op one-shot fallback; replay the latest viewport so the PTY isn't stuck at subscribe-time size.
    if (pendingViewportClaim && desiredViewport) {
      nextStream.claimViewport(desiredViewport.cols, desiredViewport.rows)
      pendingViewportClaim = false
      const queuedInput = pendingClaimInput
      pendingClaimInput = ''
      if (queuedInput) {
        nextStream.sendInput(queuedInput)
      }
      for (const resolve of viewportClaimReadyWaiters) {
        resolve(true)
      }
      viewportClaimReadyWaiters.clear()
    } else if (
      desiredViewport &&
      (desiredViewport.cols !== subscribedViewport?.cols ||
        desiredViewport.rows !== subscribedViewport?.rows)
    ) {
      nextStream.resize(desiredViewport.cols, desiredViewport.rows)
    }
  }

  const transport: PtyTransport = {
    async connect(options) {
      cancelTerminalCreateRetryWait()
      const connectLifecycleEpoch = ++lifecycleEpoch
      const createEnvironmentId = currentRuntimeEnvironmentId
      lastConnectOptions = options
      storedCallbacks = options.callbacks
      recoveryRequiresReplacement = false
      terminalEnded = false
      connecting = true
      emitRecoveryState(true)
      if (destroyed || !worktreeId) {
        return
      }

      try {
        if (isWebTerminalSurfaceTabId(tabId ?? '')) {
          return await attachHostSessionMirror(options)
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
        const hostAuthorityCreate = () =>
          createWithUnknownOutcomeRecovery(
            'agent-session',
            (timeoutMs) =>
              resumeProviderSessionToSend
                ? callRuntimeForEnvironment<RuntimeEnsureAgentSessionResult>(
                    createEnvironmentId,
                    'terminal.ensureAgentSession',
                    {
                      kind: 'explicit',
                      worktree: toRuntimeTerminalWorktreeSelector(worktreeId),
                      agent: launchAgentToSend!,
                      providerSession: resumeProviderSessionToSend,
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
        const created = launchAgentToSend
          ? agentSessionRequiresHostAuthorityReplay
            ? await hostAuthorityCreate()
            : await runRemoteAgentSessionLaunch<RemoteAgentSessionLaunchResult | null>({
                environmentId: createEnvironmentId,
                hostAuthority: hostAuthorityCreate,
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

        remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
        connected = true
        desiredViewport = {
          cols: options.cols ?? 80,
          rows: options.rows ?? 24
        }
        onPtySpawn?.(remotePtyId)
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
          replay: ''
        } satisfies PtyConnectResult
      } catch (error) {
        if (!destroyed && lifecycleEpoch === connectLifecycleEpoch) {
          connecting = false
          recovery.cancel()
          const message = runtimeTerminalErrorMessage(error)
          if (isRemoteTerminalGoneMessage(message)) {
            handleRemoteTerminalError(error)
          } else {
            emitRecoveryState()
            storedCallbacks.onError?.(message)
          }
        }
        return undefined
      }
    },

    attach(options) {
      lifecycleEpoch += 1
      cancelTerminalCreateRetryWait()
      recovery.cancel()
      recoveryRequiresReplacement = false
      clearPublishedHandleWait()
      storedCallbacks = options.callbacks
      terminalEnded = false
      connecting = true
      emitRecoveryState(true)
      currentRuntimeEnvironmentId =
        getRemoteRuntimePtyEnvironmentId(options.existingPtyId) ?? runtimeEnvironmentId
      const previousHandle = handle
      const nextHandle = getRemoteRuntimeTerminalHandle(options.existingPtyId)
      if (previousHandle && previousHandle !== nextHandle) {
        // Why: debounced input is scoped by the current terminal handle at flush time.
        inputBatcher.clear()
      }
      handle = nextHandle
      if (!handle) {
        connected = false
        connecting = false
        remotePtyId = null
        closeMultiplexedStream()
        emitRecoveryState()
        storedCallbacks.onError?.('Remote runtime terminal id is invalid.')
        return
      }
      // Why: legacy restored ids omit their runtime owner; canonicalize at attach so stores and lifecycle guards never share raw aliases.
      remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
      connected = true
      desiredViewport = {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24
      }
      const targetHandle = handle
      const targetPtyId = remotePtyId
      emitRecoveryState()
      void subscribeToHandle().catch((error) => {
        if (!recoverAfterSubscribeFailure(error, targetHandle, targetPtyId)) {
          handleRemoteTerminalError(error)
        }
      })
    },

    disconnect() {
      lifecycleEpoch += 1
      cancelTerminalCreateRetryWait()
      recovery.cancel()
      recoveryRequiresReplacement = false
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
      closeMultiplexedStream()
      handle = null
      remotePtyId = null
      emitRecoveryState()
      storedCallbacks.onDisconnect?.()
      if (id) {
        onPtyExit?.(id)
      }
    },

    detach() {
      lifecycleEpoch += 1
      cancelTerminalCreateRetryWait()
      recovery.cancel()
      recoveryRequiresReplacement = false
      clearPublishedHandleWait()
      inputBatcher.flush()
      inputBatcher.clear()
      viewportBatcher.flush()
      outputProcessor.clearAccumulatedState()
      connected = false
      connecting = false
      clearPendingViewportClaim()
      closeMultiplexedStream()
      emitRecoveryState()
      storedCallbacks = {}
    },

    sendInput(data: string): boolean {
      if (!connected || !handle || recoveryBlocksIo()) {
        return false
      }
      if (!data) {
        return true
      }
      // Why: literal LF bytes from paste/programmatic input must survive; callers use \r or the enter flag for semantic Enter.
      return inputBatcher.push(data)
    },

    // Why: query replies (CPR/DSR/DA/OSC) are read in raw mode with a short timeout; the 8ms debounce would miss it and echo the reply onto the prompt (#7329).
    sendInputImmediate(data: string): boolean {
      const targetHandle = handle
      if (!connected || !targetHandle || recoveryBlocksIo()) {
        return false
      }
      if (!data) {
        return true
      }
      // Why: earlier input may still be in async byte-length validation (in validationTail, not takePending); route the reply through the ordered queue so it can't jump ahead and reorder bytes.
      if (inputBatcher.hasPendingValidation()) {
        const accepted = inputBatcher.push(data)
        inputBatcher.flush()
        return accepted
      }
      const pending = inputBatcher.takePending()
      const text = `${pending}${data}`
      const stream = getCurrentMultiplexedStream(targetHandle)
      if (stream?.sendInput(text)) {
        return true
      }
      if (pendingViewportClaim) {
        pendingClaimInput += text
        return true
      }
      void callRuntime('terminal.send', {
        terminal: targetHandle,
        text,
        client: { id: clientId, type: 'desktop' },
        ...(desiredViewport ? { viewport: desiredViewport, claimViewport: true as const } : {})
      }).catch((error) => {
        handleRemoteTerminalError(error)
      })
      return true
    },

    sendInputAccepted: sendInputAcceptedToRuntime,

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

    retryRecovery() {
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
        void transport.connect(lastConnectOptions)
        return true
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
      scheduleResubscribeAfterTransportClose(recoveryRequiresReplacement, recoveryEpoch)
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

    async serializeBuffer(opts) {
      if (!connected || !handle) {
        return null
      }
      return getCurrentMultiplexedStream(handle)?.serializeBuffer(opts) ?? null
    },

    destroy() {
      destroyed = true
      this.disconnect()
      recovery.dispose()
      inputBatcher.clear()
      viewportBatcher.clear()
    }
  }
  return transport
}
