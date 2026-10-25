import type { PairedE2EEClientHandshake } from '../../paired-e2ee-client-handshake'
import type WebSocket from 'ws'
import type { PairedRuntimeConnection } from '../../paired-runtime-connection'
import { remoteRuntimeClientCapabilities } from '../../remote-runtime-client-capabilities'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import { openSharedControlSocket } from './remote-runtime-shared-control-open'
import { closeSharedControlAfterError } from './remote-runtime-shared-control-refusal'
import * as sharedControlReady from './remote-runtime-shared-control-ready'
import * as sharedControlProtocol from './remote-runtime-shared-control-protocol'
import { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'
import { requestSharedControl } from '../requests/remote-runtime-shared-control-requests'
import { SharedControlRetiredRequestIds } from '../requests/remote-runtime-shared-control-retired-request-ids'
import { SharedControlReadyStableResetTimer } from './remote-runtime-shared-control-stability'
import * as sharedControlState from './remote-runtime-shared-control-state'
import { closeSharedControlSocket, LOCAL_CLOSE } from './remote-runtime-shared-control-socket-close'
import { startSharedControlSubscription } from '../requests/remote-runtime-shared-control-subscription-start'
import { SharedControlSocketGeneration } from './remote-runtime-shared-control-socket-generation'
import { refreshRemoteRuntimeSharedControl } from './remote-runtime-shared-control-refresh'
import { SharedControlDiagnosticsTracker } from './remote-runtime-shared-control-diagnostics'
import { ensureSharedControlReady } from './remote-runtime-shared-control-ready-wait'
import { handleRuntimeControlTextFrame } from './remote-runtime-shared-control-connection-frame'
import * as sharedControlActions from './remote-runtime-shared-control-connection-actions'
import type * as SharedControlTypes from './remote-runtime-shared-control-types'
import type { SharedControlSocketClosed } from './remote-runtime-shared-control-types'
import { sendSharedControlSubscription } from './remote-runtime-shared-control-send'
import { closeSharedControlConnectionSubscription } from '../requests/remote-runtime-shared-control-subscription-close'
type PendingRequest = SharedControlTypes.SharedControlPendingRequest<unknown>
type LogicalSubscription = SharedControlTypes.SharedControlLogicalSubscription<unknown>

export class RemoteRuntimeSharedControlConnection {
  private state: SharedControlTypes.SharedControlConnectionState = 'closed'
  private ws: WebSocket | null = null
  private handshake: PairedE2EEClientHandshake | null = null
  private socketCleanup: (() => void) | null = null
  private readonly reconnect = new SharedControlReconnectScheduler()
  private readonly readyStableReset: SharedControlReadyStableResetTimer
  private intentionallyClosed = false
  private readonly diagnostics: SharedControlDiagnosticsTracker
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly subscriptions = new Map<string, LogicalSubscription>()
  private readonly retiredRequestIds = new SharedControlRetiredRequestIds()
  private readonly readyWaiters: SharedControlTypes.SharedControlReadyWaiter[] = []
  private everReady = false
  /** Changes whenever the socket does, so two calls can prove they shared one socket. */
  readonly socketGeneration = new SharedControlSocketGeneration()

  constructor(
    private readonly connection: PairedRuntimeConnection,
    private readonly options: SharedControlTypes.RemoteRuntimeSharedControlConnectionOptions = {}
  ) {
    this.diagnostics = new SharedControlDiagnosticsTracker(options, () => this.diagnosticsCounts())
    this.readyStableReset = new SharedControlReadyStableResetTimer(
      options.reconnectStableResetMs ?? 30_000
    )
  }
  request<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    envelope?: Parameters<typeof requestSharedControl>[0]['envelope'],
    signal?: AbortSignal,
    beforeSend?: () => void
  ): ReturnType<typeof requestSharedControl<TResult>> {
    return requestSharedControl<TResult>({
      beforeSend,
      pendingRequests: this.pendingRequests,
      deviceToken: this.connection.credential.deviceToken,
      method,
      params,
      timeoutMs,
      envelope,
      ensureReady: () => this.ensureReadyWithTimeout(timeoutMs, signal),
      send: (requestId) =>
        sharedControlActions.sendSharedControlRequest({
          pendingRequests: this.pendingRequests,
          requestId,
          state: this.state,
          ws: this.ws,
          handshake: this.handshake
        }),
      retireRequestId: (requestId) => this.retiredRequestIds.retire(requestId),
      signal
    })
  }
  async subscribe<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    callbacks: SharedControlTypes.SharedControlSubscriptionCallbacks<TResult>,
    signal?: AbortSignal
  ): Promise<SharedControlTypes.RemoteRuntimeSharedSubscription> {
    return startSharedControlSubscription({
      subscriptions: this.subscriptions,
      deviceToken: this.connection.credential.deviceToken,
      method,
      params,
      callbacks,
      signal,
      ensureReady: () => this.ensureReadyWithTimeout(timeoutMs, signal),
      sendSubscription: (subscription) =>
        sendSharedControlSubscription({
          subscriptions: this.subscriptions,
          subscription,
          deviceToken: this.connection.credential.deviceToken,
          send: (payload) => this.sendEncrypted(payload)
        }),
      closeSubscription: (requestId) => this.closeSubscription(requestId)
    })
  }
  close(error?: Error): void {
    this.intentionallyClosed = true
    this.socketGeneration.invalidate()
    this.reconnect.clear()
    for (const subscription of Array.from(this.subscriptions.values())) {
      this.closeSubscription(subscription.requestId)
    }
    this.closeSocket(error)
    this.publishDiagnostics()
  }
  readonly retryNow = (): boolean => this.reconnect.retryNow()
  pauseStandingRetry(): void {
    if (this.subscriptions.size === 0) {
      this.reconnect.clear()
      this.publishDiagnostics()
    }
  }

  private publishDiagnostics(): void {
    this.diagnostics.publish()
  }
  isReady(): boolean {
    const { state, ws, handshake } = this
    return sharedControlReady.isSharedControlReady({ state, ws, handshake })
  }
  getDiagnostics(): SharedControlTypes.RemoteRuntimeSharedConnectionDiagnostics {
    return this.diagnostics.get()
  }
  private diagnosticsCounts() {
    return {
      state: this.state,
      reconnecting: this.reconnect.isScheduled,
      pendingRequestCount: this.pendingRequests.size,
      subscriptionCount: this.subscriptions.size,
      reconnectAttempt: this.reconnect.attemptCount
    }
  }
  reconnectNow(): void {
    refreshRemoteRuntimeSharedControl({
      intentionallyClosed: this.intentionallyClosed,
      ready: this.isReady(),
      close: (error) => this.closeSocket(error, { preserveReadyWaitersAndPendingRequests: true }),
      open: () => this.open()
    })
  }
  private ensureReadyWithTimeout(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return ensureSharedControlReady({
      state: this.state,
      ws: this.ws,
      handshake: this.handshake,
      readyWaiters: this.readyWaiters,
      timeoutMs,
      signal,
      open: () => sharedControlReady.openIfSocketClosed(this.ws, () => this.open())
    })
  }

  private open(): void {
    if (this.intentionallyClosed) {
      sharedControlState.rejectSharedControlReadyWaiters(
        this.readyWaiters,
        remoteRuntimeUnavailableError()
      )
      return
    }
    this.reconnect.clear()
    const socketGeneration = this.socketGeneration.begin()
    const opened = openSharedControlSocket(this.connection, {
      getCurrentSocket: () => this.ws,
      onSocketClosed: (error, cause, close) => {
        if (close && this.socketGeneration.isCurrent(socketGeneration)) {
          this.diagnostics.markClose(close)
        }
        this.handleSocketClosed(error, socketGeneration, cause)
      },
      onTextFrame: (frame) => this.handleTextFrame(frame, socketGeneration),
      onActivity: this.options.onAnswered,
      liveness: {
        options: this.options.liveness,
        onRoundTrip: (rttMs) => this.diagnostics.markRoundTrip(rttMs)
      }
    })
    if (!opened.ok) {
      this.handleSocketClosed(opened.error, socketGeneration, 'socket_error')
      return
    }
    this.diagnostics.markSocketOpened()
    this.ws = opened.socket.ws
    this.handshake = opened.socket.handshake
    this.socketCleanup = opened.socket.cleanup
    this.state = 'awaiting_ready'
    this.publishDiagnostics()
  }

  private handleTextFrame(frame: string, socketGeneration: number): void {
    handleRuntimeControlTextFrame({
      frame,
      socketGeneration,
      isCurrent: (generation) => this.socketGeneration.isCurrent(generation),
      getState: () => this.state,
      getHandshake: () => this.handshake,
      environmentId: this.options.environmentId,
      deviceToken: this.connection.credential.deviceToken,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions,
      retiredRequestIds: this.retiredRequestIds,
      readyWaiters: this.readyWaiters,
      setState: (state) => {
        this.state = state
      },
      handleSocketClosed: (e) => this.handleSocketClosed(e, socketGeneration, 'protocol_error'),
      sendEncrypted: (payload) => this.sendEncrypted(payload),
      clientCapabilities: remoteRuntimeClientCapabilities(this.options.clientCapabilities),
      getSocket: () => this.ws,
      markReady: () => {
        this.diagnostics.markReady()
        // Clear predecessor-attempt diagnostics on recovery so Connected cannot retain stale failure details.
        this.publishDiagnostics()
        this.readyStableReset.schedule({
          getState: () => this.state,
          getSocket: () => this.ws,
          reset: () => this.reconnect.resetAttempt()
        })
      },
      replaySubscriptions: () => this.replaySubscriptions(),
      publishDiagnostics: () => this.publishDiagnostics()
    })
  }

  private replaySubscriptions(): void {
    this.everReady = sharedControlActions.replayRuntimeControlSubscriptions({
      subscriptions: this.subscriptions,
      deviceToken: this.connection.credential.deviceToken,
      send: (payload) => this.sendEncrypted(payload),
      tagReplayedResponses: this.everReady
    })
  }

  private closeSubscription(requestId: string): void {
    closeSharedControlConnectionSubscription({
      subscriptions: this.subscriptions,
      retiredRequestIds: this.retiredRequestIds,
      requestId,
      deviceToken: this.connection.credential.deviceToken,
      send: (payload) => this.sendEncrypted(payload)
    })
  }

  private sendEncrypted(payload: unknown): boolean {
    return sharedControlProtocol.sendSharedControlEncrypted({
      state: this.state,
      ws: this.ws,
      handshake: this.handshake,
      payload
    })
  }

  private readonly handleSocketClosed: SharedControlSocketClosed = (refused, generation, cause) => {
    closeSharedControlAfterError({
      refused,
      socketGeneration: generation,
      generation: this.socketGeneration,
      onAuthenticationRejected: this.options.onAuthenticationRejected,
      everReady: this.everReady,
      subscriptions: this.subscriptions,
      closeSocket: (error) =>
        this.closeSocket(error, { close: { cause, errorCode: refused.code } }),
      markError: (message) => this.diagnostics.markError(message),
      isClosed: () => this.state === 'closed',
      retry: () =>
        this.reconnect.scheduleAfterSocketClose({
          intentionallyClosed: this.intentionallyClosed,
          manuallyDisconnected: this.options.isManuallyDisconnected?.() ?? false,
          capabilityPaused: this.options.isCapabilityPaused?.() ?? false,
          subscriptionCount: this.subscriptions.size,
          open: () => this.open()
        }),
      publishDiagnostics: () => this.publishDiagnostics()
    })
  }

  private closeSocket(error?: Error, options: SharedControlTypes.CloseSocketOptions = {}): void {
    closeSharedControlSocket({
      reportClose: () => this.diagnostics.markSocketClosed(options.close ?? LOCAL_CLOSE),
      environmentId: this.options.environmentId,
      state: this.state,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions,
      readyWaiters: this.readyWaiters,
      lastClose: this.getDiagnostics().lastClose,
      socketCleanup: this.socketCleanup,
      ws: this.ws,
      error,
      preserveReadyWaitersAndPendingRequests: options.preserveReadyWaitersAndPendingRequests,
      clearReadyStableTimer: () => this.readyStableReset.clear()
    })
    this.ws = this.handshake = null
    this.socketCleanup = null
    this.state = 'closed'
    this.publishDiagnostics()
  }
}
