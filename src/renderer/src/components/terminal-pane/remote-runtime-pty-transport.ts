/* eslint-disable max-lines -- Why: remote PTY transport keeps lifecycle, JSON fallback, and binary stream wiring together so reconnect/destroy ordering stays testable as one behavior surface. */
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTerminalClientTab,
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalCreate,
  RuntimeTerminalSend
} from '../../../../shared/runtime-types'
import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import type { IpcPtyTransportOptions, PtyConnectResult, PtyTransport } from './pty-transport-types'
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
import { createBrowserUuid } from '@/lib/browser-uuid'
import { replaceFitOverridePtyId, setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import { replaceDriverPtyId, setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from '@/runtime/web-terminal-surface-id'
import { listRemoteRuntimeSessionTabsDeduped } from '@/runtime/remote-runtime-session-tabs-inflight'
import { subscribeAcceptedWebSessionTerminalHandle } from '@/runtime/web-session-terminal-handle-events'

const REMOTE_TERMINAL_INPUT_FLUSH_MS = 8
const REMOTE_TERMINAL_VIEWPORT_FLUSH_MS = 33
const HOST_SESSION_ATTACH_POLL_MS = 150
const HOST_SESSION_REPLACEMENT_POLL_MAX_MS = 1_000
const HOST_SESSION_ATTACH_TIMEOUT_MS = 15_000

function isRemoteTerminalStaleMessage(message: string): boolean {
  return message.includes('terminal_handle_stale')
}

function isRemoteTerminalGoneMessage(message: string): boolean {
  return (
    message.includes('terminal_exited') ||
    message.includes('terminal_gone') ||
    message.includes('no_connected_pty')
  )
}

/**
 * PTY transport backing a renderer terminal pane with a terminal on a remote Orca
 * runtime, over runtime RPC plus the multiplexed stream (create, subscribe, input,
 * resize, close, reattach).
 */
export function createRemoteRuntimePtyTransport(
  runtimeEnvironmentId: string,
  opts: IpcPtyTransportOptions = {}
): PtyTransport {
  const {
    command,
    startupCommandDelivery,
    env,
    launchConfig,
    launchToken,
    launchAgent,
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
  let destroyed = false
  let handle: string | null = null
  let remotePtyId: string | null = null
  let currentRuntimeEnvironmentId = runtimeEnvironmentId
  let multiplexedStream: RemoteRuntimeMultiplexedTerminal | null = null
  let multiplexedStreamHandle: string | null = null
  let desiredViewport: { cols: number; rows: number } | null = null
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}
  let resubscribing = false
  let resubscribeRequestedHandle: string | null = null
  let resubscribeRequestedRequiresReplacement = false
  let stopWaitingForPublishedHandle: (() => void) | null = null
  let subscriptionGeneration = 0
  let pendingViewportClaim = false
  let pendingClaimInput = ''
  const viewportClaimReadyWaiters = new Set<(ready: boolean) => void>()
  const clearPendingViewportClaim = (): void => {
    pendingViewportClaim = false
    pendingClaimInput = ''
    for (const resolve of viewportClaimReadyWaiters) {
      resolve(false)
    }
    viewportClaimReadyWaiters.clear()
  }
  // Why: tab/leaf ids identify the mirrored host pane, so every paired viewer
  // shares them. The instance suffix keeps one viewer's refresh off peer records.
  const clientId = `desktop:${tabId ?? 'tab'}:${leafId ?? 'leaf'}:${createBrowserUuid()}`
  const outputProcessor = createPtyOutputProcessor({
    onTitleChange,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited,
    onAgentStatus
  })

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
      ...(leafId ? { leafId } : {})
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
      // Why: host mirrors can be published before their PTY handle is ready,
      // but a stuck pending surface must not poll the runtime forever.
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
      // Why: a bounded wait without removal evidence is unknown liveness;
      // keep the mounted pane for an external snapshot to reattach later.
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
        // Why: the session inventory can race the same runtime reconnect that
        // invalidated the handle. Unknown liveness must not retire the pane.
        lastListError = error
      }
      const remainingMs = HOST_SESSION_ATTACH_TIMEOUT_MS - (Date.now() - startedAt)
      if (remainingMs <= 0) {
        return finishWithUnknownLiveness()
      }
      // Why: a stale response can precede publication of its replacement.
      // Bounded backoff avoids retrying the known-stale handle in a hot loop.
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

    await subscribeToHandle()
    if (destroyed || !connected || !remotePtyId) {
      return undefined
    }

    return {
      id: remotePtyId,
      replay: ''
    } satisfies PtyConnectResult
  }

  async function callRuntime<TResult>(
    method: string,
    params?: unknown,
    timeoutMs = 15_000
  ): Promise<TResult> {
    const response = await window.api.runtimeEnvironments.call({
      selector: currentRuntimeEnvironmentId,
      method,
      params,
      timeoutMs
    })
    return unwrapRuntimeRpcResult(response as RuntimeRpcResponse<TResult>)
  }

  async function closeRemoteTerminal(handleOverride?: string): Promise<void> {
    const targetHandle = handleOverride ?? handle
    if (!targetHandle) {
      return
    }
    try {
      await callRuntime('terminal.close', { terminal: targetHandle })
    } catch {
      // Best-effort parity with local disconnect/kill.
    }
  }

  async function sendInputAcceptedToRuntime(data: string): Promise<boolean> {
    const targetHandle = handle
    if (!connected || !targetHandle) {
      return false
    }
    if (!data) {
      return true
    }
    await inputBatcher.drain()
    if (!connected || handle !== targetHandle) {
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
    // Why: normal remote sendInput may be waiting on yielded size validation;
    // drain it before acknowledged writes so terminal bytes stay ordered.
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
        if (!connected || handle !== targetHandle) {
          return false
        }
        // Why: acknowledged sends are ordered behind any pending debounce text,
        // but they must not collapse large paste input back into one remote RPC.
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
      // Why: stale-handle errors must retire the mirror (recoverable via the
      // next snapshot) rather than dead-end in a red xterm banner (#7718).
      handleRemoteTerminalError(error)
      return false
    }
  }

  const inputBatcher = createRemoteRuntimePtyTextBatcher(REMOTE_TERMINAL_INPUT_FLUSH_MS, (text) => {
    const targetHandle = handle
    if (!connected || !targetHandle) {
      return
    }
    const stream = getCurrentMultiplexedStream(targetHandle)
    if (stream?.sendInput(text)) {
      return
    }
    if (pendingViewportClaim) {
      // Why: a claim during subscribe/reconnect has no stream record to own
      // yet. Hold its input until the stream can emit claim+input in one order.
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
    if (!connected || !targetHandle) {
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
    connected = false
    clearPublishedHandleWait()
    clearPendingViewportClaim()
    const stalePtyId = remotePtyId
    handle = null
    remotePtyId = null
    closeMultiplexedStream()
    if (stalePtyId) {
      onPtyExit?.(stalePtyId)
    }
  }

  function rebindRemoteTerminalHandle(nextHandle: string): void {
    clearPublishedHandleWait()
    const replacedPtyId = remotePtyId
    handle = nextHandle
    remotePtyId = toRemoteRuntimePtyId(nextHandle, currentRuntimeEnvironmentId)
    // Why: host handle rotation preserves the pane generation; only the store
    // identity changes, without fresh-spawn or terminal-exit semantics.
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
          if (reboundHandle && isCurrentRemoteTerminal(reboundHandle, reboundPtyId)) {
            handleRemoteTerminalError(error)
          }
        })
      }
    )
  }

  function handleRemoteTerminalError(error: unknown): void {
    const message = runtimeTerminalErrorMessage(error)
    if (message === REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE) {
      // Why: an oversized initial snapshot is skipped but live output keeps
      // flowing — informational, not fatal, so never surface a red xterm banner.
      return
    }
    if (isRemoteTerminalStaleMessage(message)) {
      if (tabId && isWebTerminalSurfaceTabId(tabId)) {
        // Why: reconnect can re-mint a mirrored pane's handle while its host tab
        // remains alive. Keep xterm/composer state mounted while we re-resolve it.
        closeMultiplexedStream()
        scheduleResubscribeAfterTransportClose(true)
      } else {
        retireRemoteTerminalId()
      }
      return
    }
    if (isRemoteTerminalGoneMessage(message)) {
      // Why: an explicit terminal-gone response is terminal lifecycle evidence,
      // unlike a replaceable stale handle observed during reconnect.
      retireRemoteTerminalId()
      return
    }
    storedCallbacks.onError?.(message)
  }

  // Why: after a transport drop the host may have re-minted this pane's
  // handle (reconnect, epoch or PTY change). Re-derive it from the current
  // session snapshot instead of resubscribing the stale closure value, which
  // would mirror (and type into) whatever PTY now sits behind it (#7718).
  async function resubscribeAfterTransportClose(
    previousHandle: string,
    requireReplacement: boolean
  ): Promise<void> {
    if (tabId && isWebTerminalSurfaceTabId(tabId)) {
      const hostTabId = toHostSessionTabId(tabId)
      const nextHandle = await waitForResubscribeHostSessionHandle(
        hostTabId,
        previousHandle,
        requireReplacement
      )
      if (destroyed || !connected || handle !== previousHandle) {
        return
      }
      if (nextHandle === undefined) {
        return
      }
      if (!nextHandle) {
        // Why: the host no longer publishes this surface; retire quietly and
        // let the next session-tabs snapshot drive respawn/removal.
        retireRemoteTerminalId()
        return
      }
      if (nextHandle !== previousHandle) {
        rebindRemoteTerminalHandle(nextHandle)
      }
    }
    clearPublishedHandleWait()
    await subscribeToHandle()
  }

  function scheduleResubscribeAfterTransportClose(requireReplacement = false): void {
    if (destroyed || !connected || !handle) {
      return
    }
    if (requireReplacement && stopWaitingForPublishedHandle) {
      // Why: once bounded polling has handed recovery to accepted snapshots,
      // repeated sends to the known-stale handle must not re-arm inventory RPCs.
      return
    }
    if (resubscribing) {
      // Why: concurrent stale errors belong to the handle that produced them.
      // Do not carry an old handle's replacement requirement onto its successor.
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
      // Why: subscribe before polling so a fresh host snapshot cannot land in
      // the gap between the bounded inventory loop and its event-driven fallback.
      waitForPublishedHostSessionHandle(toHostSessionTabId(tabId), resubscribeHandle)
    }
    resubscribing = true
    void resubscribeAfterTransportClose(resubscribeHandle, requireReplacement)
      .catch((error) => {
        if (!destroyed && connected && handle) {
          clearPendingViewportClaim()
          handleRemoteTerminalError(error)
        }
      })
      .finally(() => {
        resubscribing = false
        const pendingHandle = resubscribeRequestedHandle
        const pendingRequiresReplacement = resubscribeRequestedRequiresReplacement
        resubscribeRequestedHandle = null
        resubscribeRequestedRequiresReplacement = false
        if (!stopWaitingForPublishedHandle && pendingHandle && pendingHandle === handle) {
          scheduleResubscribeAfterTransportClose(pendingRequiresReplacement)
        }
      })
  }

  async function subscribeToHandle(): Promise<void> {
    if (!handle) {
      return
    }
    const subscribedHandle = handle
    const subscribedPtyId = remotePtyId
    const generation = ++subscriptionGeneration
    let transportClosed = false
    // Why: the viewport we hand the subscribe request. A resize landing during
    // the round-trip falls back to the one-shot RPC, which is refresh-only (no
    // leak) and no-ops before the stream record exists — so replay the latest
    // remembered viewport through the stream once it's current (below).
    const subscribedViewport = desiredViewport
    const isCurrentSubscription = (): boolean =>
      !transportClosed &&
      generation === subscriptionGeneration &&
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
          // Why: a snapshot with no body can still carry a pending mid-escape
          // tail that must be replayed so the next live chunk completes it.
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
          storedCallbacks.onConnect?.()
          storedCallbacks.onStatus?.('shell')
        },
        onEnd: () => {
          if (!isCurrentSubscription()) {
            return
          }
          outputProcessor.clearAccumulatedState()
          connected = false
          handle = null
          remotePtyId = null
          multiplexedStream = null
          multiplexedStreamHandle = null
          clearPendingViewportClaim()
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
        onTransportClose: () => {
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
          scheduleResubscribeAfterTransportClose()
        }
      }
    })
    if (
      transportClosed ||
      generation !== subscriptionGeneration ||
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
    // Why: a viewport change that landed during the subscribe round-trip took
    // the now-no-op one-shot fallback, so the stream record is still at the
    // subscribe-time size. Replay the latest remembered viewport so the PTY
    // tracks the current width instead of stalling until the next resize.
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

  return {
    async connect(options) {
      storedCallbacks = options.callbacks
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
        const launchConfigToSend = options.launchConfig ?? launchConfig
        const launchTokenToSend = options.launchToken ?? launchToken
        const launchAgentToSend = options.launchAgent ?? launchAgent
        const created = await callRuntime<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
          worktree: toRuntimeTerminalWorktreeSelector(worktreeId),
          ...(commandToSend !== undefined ? { command: commandToSend } : {}),
          ...(startupCommandDeliveryToSend !== undefined
            ? { startupCommandDelivery: startupCommandDeliveryToSend }
            : {}),
          ...(envToSend !== undefined ? { env: envToSend } : {}),
          ...(launchConfigToSend !== undefined ? { launchConfig: launchConfigToSend } : {}),
          ...(launchTokenToSend !== undefined ? { launchToken: launchTokenToSend } : {}),
          ...(launchAgentToSend !== undefined ? { launchAgent: launchAgentToSend } : {}),
          tabId,
          leafId,
          focus: false,
          // Why: this transport is backing an already-mounted renderer pane;
          // activation here is local state, not permission for remote UI reveal.
          presentation: 'background',
          ...(activate === true ? { activate: true } : {})
        })
        handle = created.terminal.handle
        if (destroyed) {
          // Why: this is a cancelled launch, not a connected shared session.
          // Close the server PTY so rapid tab-open/tab-close does not leak.
          await closeRemoteTerminal(created.terminal.handle)
          return
        }

        remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
        connected = true
        desiredViewport = {
          cols: options.cols ?? 80,
          rows: options.rows ?? 24
        }
        onPtySpawn?.(remotePtyId)

        await subscribeToHandle()
        if (destroyed || !connected || !remotePtyId) {
          return
        }

        return {
          id: remotePtyId,
          replay: ''
        } satisfies PtyConnectResult
      } catch (error) {
        storedCallbacks.onError?.(runtimeTerminalErrorMessage(error))
        return undefined
      }
    },

    attach(options) {
      clearPublishedHandleWait()
      storedCallbacks = options.callbacks
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
        remotePtyId = null
        closeMultiplexedStream()
        storedCallbacks.onError?.('Remote runtime terminal id is invalid.')
        return
      }
      // Why: legacy restored ids omitted their runtime owner. Canonicalize at
      // attach so renderer stores and lifecycle guards never share raw aliases.
      remotePtyId = toRemoteRuntimePtyId(handle, currentRuntimeEnvironmentId)
      connected = true
      desiredViewport = {
        cols: options.cols ?? 80,
        rows: options.rows ?? 24
      }
      const targetHandle = handle
      const targetPtyId = remotePtyId
      void subscribeToHandle().catch((error) => {
        if (!isCurrentRemoteTerminal(targetHandle, targetPtyId)) {
          return
        }
        if (handle === targetHandle && multiplexedStreamHandle !== targetHandle) {
          closeMultiplexedStream()
        }
        clearPendingViewportClaim()
        handleRemoteTerminalError(error)
      })
    },

    disconnect() {
      clearPublishedHandleWait()
      inputBatcher.flush()
      inputBatcher.clear()
      viewportBatcher.flush()
      outputProcessor.clearAccumulatedState()
      if (!connected && !handle) {
        return
      }
      connected = false
      clearPendingViewportClaim()
      const id = remotePtyId
      closeMultiplexedStream()
      handle = null
      remotePtyId = null
      storedCallbacks.onDisconnect?.()
      if (id) {
        onPtyExit?.(id)
      }
    },

    detach() {
      clearPublishedHandleWait()
      inputBatcher.flush()
      inputBatcher.clear()
      viewportBatcher.flush()
      outputProcessor.clearAccumulatedState()
      connected = false
      clearPendingViewportClaim()
      closeMultiplexedStream()
      storedCallbacks = {}
    },

    sendInput(data: string): boolean {
      if (!connected || !handle) {
        return false
      }
      if (!data) {
        return true
      }
      // Why: callers use \r or terminal.send's enter flag for semantic Enter;
      // literal LF bytes from paste/programmatic input must survive the stream.
      return inputBatcher.push(data)
    },

    // Why: terminal query replies (CPR/DSR/DA/OSC color/pixel size) are read by
    // the querying program in raw mode with a short timeout. The 8ms input
    // debounce makes the reply miss that window, so it lands on the shell prompt
    // and is echoed literally / spliced into typed input (#7329). Flush any
    // pending batched input first so byte order is preserved, then send the
    // reply immediately without arming the debounce timer.
    sendInputImmediate(data: string): boolean {
      const targetHandle = handle
      if (!connected || !targetHandle) {
        return false
      }
      if (!data) {
        return true
      }
      // Why: earlier input (e.g. a large paste) may still be in async byte-length
      // validation, so it is captured in the batcher's validationTail and NOT in
      // takePending(). Bypassing the queue here would send the reply ahead of it
      // and reorder bytes on the wire. In that rare window, route the reply
      // through the batcher's ordered queue and flush what is already validated;
      // the reply lands right after the pending input once its validation
      // resolves. Order correctness beats the immediacy that the debounce
      // normally trades away.
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
      viewportBatcher.clear()
      sendViewportUpdate(cols, rows, true)
      return true
    },

    resize(cols: number, rows: number, meta): boolean {
      if (!connected || !handle) {
        return false
      }
      rememberViewport(cols, rows)
      if (meta?.claim) {
        viewportBatcher.clear()
        sendViewportUpdate(cols, rows, true)
        return true
      }
      // Why: xterm fit can emit resize bursts while the user drags panes or
      // restores layouts. Remote runtimes only need the last viewport in a frame.
      viewportBatcher.queue(cols, rows)
      return true
    },

    isConnected() {
      return connected
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
      inputBatcher.clear()
      viewportBatcher.clear()
    }
  }
}
