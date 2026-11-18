import { SharedControlRequests } from './remote-runtime-shared-control-requests'
import type { PairedE2EEClientHandshake } from '../e2ee/paired-e2ee-client-handshake'
import type WebSocket from 'ws'
import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import { remoteRuntimeClientCapabilities } from '../remote-runtime-client-capabilities'
import { schedulePreparedControlRetry } from './remote-runtime-shared-control-hold'
import { openPreparedSharedControlSocket } from './remote-runtime-shared-control-open'
import { closeSharedControlAfterError } from './remote-runtime-shared-control-refusal'
import * as sharedControlReady from './remote-runtime-shared-control-ready'
import * as sharedControlProtocol from './remote-runtime-shared-control-protocol'
import { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'
import { SharedControlRetiredRequestIds } from '../requests/remote-runtime-shared-control-retired-request-ids'
import { SharedControlReadinessTimer } from './remote-runtime-shared-control-stability'
import * as sharedControlState from './remote-runtime-shared-control-state'
import { closeSharedControlSocket, LOCAL_CLOSE } from './remote-runtime-shared-control-socket-close'
import { SharedControlSocketGeneration } from './remote-runtime-shared-control-socket-generation'
import { refreshRemoteRuntimeSharedControl } from './remote-runtime-shared-control-refresh'
import { SharedControlDiagnosticsTracker } from './remote-runtime-shared-control-diagnostics'
import { ensureSharedControlReady } from './remote-runtime-shared-control-ready-wait'
import { handleRuntimeControlFrame } from './remote-runtime-shared-control-connection-frame'
import * as sharedControlActions from './remote-runtime-shared-control-connection-actions'
import type * as SharedControlTypes from './remote-runtime-shared-control-types'
import { closeSharedControlConnectionSubscription } from '../requests/remote-runtime-shared-control-subscription-close'
type PendingRequest = SharedControlTypes.SharedControlPendingRequest<unknown>
type LogicalSubscription = SharedControlTypes.SharedControlLogicalSubscription<unknown>

export class RemoteRuntimeSharedControlConnection {
  private state: SharedControlTypes.SharedControlConnectionState = 'closed'
  private ws: WebSocket | null = null
  private handshake: PairedE2EEClientHandshake | null = null
  private socketCleanup: (() => void) | null = null
  private readonly reconnect = new SharedControlReconnectScheduler()
  private readonly readiness: SharedControlReadinessTimer
  private intentionallyClosed = false
  private readonly diagnostics: SharedControlDiagnosticsTracker
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly subscriptions = new Map<string, LogicalSubscription>()
  private readonly retiredRequestIds = new SharedControlRetiredRequestIds()
  private readonly readyWaiters: SharedControlTypes.SharedControlReadyWaiter[] = []
  private opening: number | null = null
  private retryEpoch = 0
  private everReady = false
  /** Changes whenever the socket does, so two calls can prove they shared one socket. */
  readonly socketGeneration = new SharedControlSocketGeneration()

  private readonly requests = new SharedControlRequests({
    connection: () => this.connection,
    pendingRequests: this.pendingRequests,
    subscriptions: this.subscriptions,
    retiredRequestIds: this.retiredRequestIds,
    ensureReady: (timeoutMs, signal) => this.ensureReadyWithTimeout(timeoutMs, signal),
    sendEncrypted: (payload) => this.sendEncrypted(payload),
    closeSubscription: (id) => this.closeSubscription(id),
    captureSendGuard: () => this.socketGeneration.captureReady(() => this.isReady()),
    wire: () => ({ state: this.state, ws: this.ws, handshake: this.handshake })
  })

  constructor(
    private readonly connection: PairedRuntimeConnection,
    private readonly options: SharedControlTypes.RemoteRuntimeSharedControlConnectionOptions = {}
  ) {
    this.diagnostics = new SharedControlDiagnosticsTracker(options, () => ({
      state: this.state,
      reconnecting: this.reconnect.isScheduled,
      pendingRequestCount: this.pendingRequests.size,
      subscriptionCount: this.subscriptions.size,
      reconnectAttempt: this.reconnect.attemptCount,
      unresponsiveSince: this.readiness.unresponsiveSince
    }))
    this.readiness = new SharedControlReadinessTimer(options, {
      getState: () => this.state,
      getSocket: () => this.ws,
      resetAttempt: () => this.reconnect.resetAttempt(),
      retire: this.handleSocketClosed,
      probe: (timeoutMs) => this.request('status.get', { probe: true }, timeoutMs),
      onHealthChanged: this.publishDiagnostics
    })
  }
  request<TResult>(...args: Parameters<SharedControlRequests['request']>) {
    return this.requests.request<TResult>(...args)
  }
  subscribe<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    callbacks: SharedControlTypes.SharedControlSubscriptionCallbacks<TResult>,
    signal?: AbortSignal
  ) {
    return this.requests.subscribe<TResult>(method, params, timeoutMs, callbacks, signal)
  }
  close(error?: Error): void {
    this.intentionallyClosed = true
    this.opening = null
    this.retryEpoch += 1
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
      this.retryEpoch += 1
      this.reconnect.clear()
      this.publishDiagnostics()
    }
  }

  private readonly publishDiagnostics = (): void => this.diagnostics.publish()
  isReady(): boolean {
    const { state, ws, handshake } = this
    return sharedControlReady.isSharedControlReady({ state, ws, handshake })
  }
  getDiagnostics = (): SharedControlTypes.RemoteRuntimeSharedConnectionDiagnostics =>
    this.diagnostics.get()
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
    if (this.opening !== null || this.intentionallyClosed) {
      return
    }
    this.reconnect.clear()
    const generation = this.socketGeneration.begin()
    this.opening = generation
    const demand = this.readyWaiters.length > 0
    void openPreparedSharedControlSocket(this.connection, this.options, {
      current: () => this.socketGeneration.isCurrent(generation) && !this.intentionallyClosed,
      prepared: () => {
        this.opening = null
      },
      hasDemand: () => !demand || this.readyWaiters.length > 0 || this.subscriptions.size > 0,
      refuse: (error) =>
        sharedControlState.rejectSharedControlReadyWaiters(this.readyWaiters, error),
      callbacks: {
        getCurrentSocket: () => this.ws,
        onSocketClosed: (error, cause, close) => {
          if (close && this.socketGeneration.isCurrent(generation)) {
            this.diagnostics.markClose(close)
          }
          this.handleSocketClosed(error, generation, cause)
        },
        onOpened: () => this.readiness.armReadyDeadline(generation),
        onFrame: (frame) => this.handleFrame(frame, generation),
        onActivity: this.options.onAnswered,
        liveness: {
          options: this.options.liveness,
          onRoundTrip: (rttMs) => this.diagnostics.markRoundTrip(rttMs)
        }
      },
      accept: (opened) => {
        if (!opened.ok) {
          this.handleSocketClosed(opened.error, generation, 'socket_error')
          return
        }
        this.diagnostics.markSocketOpened()
        this.ws = opened.socket.ws
        this.handshake = opened.socket.handshake
        this.socketCleanup = opened.socket.cleanup
        this.state = 'awaiting_ready'
        this.publishDiagnostics()
      }
    }).catch((error: unknown) => {
      if (!this.socketGeneration.isCurrent(generation)) {
        return
      }
      this.opening = null
      sharedControlState.rejectSharedControlReadyWaiters(
        this.readyWaiters,
        error instanceof Error ? error : new Error(String(error))
      )
    })
  }

  private handleFrame(frame: SharedControlTypes.SharedControlFrame, generation: number): void {
    this.readiness.noteAnswer()
    handleRuntimeControlFrame({
      frame,
      socketGeneration: generation,
      isCurrent: (current) => this.socketGeneration.isCurrent(current),
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
      handleSocketClosed: (e) => this.handleSocketClosed(e, generation, 'protocol_error'),
      sendEncrypted: (payload) => this.sendEncrypted(payload),
      clientCapabilities: remoteRuntimeClientCapabilities(this.options.clientCapabilities),
      getSocket: () => this.ws,
      markReady: () => {
        this.diagnostics.markReady()
        this.options.onReady?.()
        // Clear predecessor-attempt diagnostics on recovery so Connected cannot retain stale failure details.
        this.publishDiagnostics()
        this.readiness.scheduleStableReset(generation)
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

  private readonly sendEncrypted = (payload: unknown): boolean =>
    sharedControlProtocol.sendSharedControlEncrypted({
      state: this.state,
      ws: this.ws,
      handshake: this.handshake,
      payload
    })

  private readonly handleSocketClosed: SharedControlTypes.SharedControlSocketClosed = (
    refused,
    generation,
    cause
  ) => {
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
      retry: () => this.scheduleRetry(),
      publishDiagnostics: () => this.publishDiagnostics()
    })
  }

  private scheduleRetry(): void {
    const generation = this.socketGeneration.peek()
    const epoch = this.retryEpoch
    schedulePreparedControlRetry(this.options, {
      current: () =>
        this.socketGeneration.isCurrent(generation) &&
        epoch === this.retryEpoch &&
        !this.intentionallyClosed &&
        this.state === 'closed' &&
        this.opening === null,
      subscriptionCount: () => this.subscriptions.size,
      reconnect: this.reconnect,
      open: () => this.open(),
      publish: this.publishDiagnostics
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
      clearReadinessTimer: () => this.readiness.clear()
    })
    this.ws = this.handshake = null
    this.socketCleanup = null
    this.state = 'closed'
    this.publishDiagnostics()
  }
}
