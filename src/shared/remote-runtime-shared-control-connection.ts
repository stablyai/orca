import WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from './remote-runtime-request-frames'
import { openSharedControlSocket } from './remote-runtime-shared-control-open'
import { handleSharedControlTextFrame } from './remote-runtime-shared-control-frame-handler'
import { sendSharedControlEncrypted } from './remote-runtime-shared-control-protocol'
import {
  isSharedControlReady,
  waitForSharedControlReadyWithTimeout
} from './remote-runtime-shared-control-ready'
import { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'
import { requestSharedControl } from './remote-runtime-shared-control-requests'
import { SharedControlReadyStableResetTimer } from './remote-runtime-shared-control-stability'
import * as sharedControlState from './remote-runtime-shared-control-state'
import {
  sendSharedControlRequest,
  sendSharedControlSubscription
} from './remote-runtime-shared-control-send'
import { closeSharedControlSocket } from './remote-runtime-shared-control-socket-close'
import type { RemoteRuntimeSocketLivenessOptions } from './remote-runtime-socket-liveness'
import * as sharedControlSubscriptions from './remote-runtime-shared-control-subscriptions'
import { startSharedControlSubscription } from './remote-runtime-shared-control-subscription-start'
import { SharedControlSocketGeneration } from './remote-runtime-shared-control-socket-generation'
import type {
  RemoteRuntimeSharedConnectionDiagnostics,
  RemoteRuntimeSharedSubscription,
  SharedControlConnectionState,
  SharedControlLogicalSubscription,
  SharedControlPendingRequest,
  SharedControlReadyWaiter,
  SharedControlSubscriptionCallbacks
} from './remote-runtime-shared-control-types'

export class RemoteRuntimeSharedControlConnection {
  private state: SharedControlConnectionState = 'closed'
  private ws: WebSocket | null = null
  private sharedKey: Uint8Array | null = null
  private socketCleanup: (() => void) | null = null
  private readonly reconnect = new SharedControlReconnectScheduler()
  private readonly readyStableReset: SharedControlReadyStableResetTimer
  private intentionallyClosed = false
  private lastConnectedAt: number | null = null
  private lastClose: { code: number; reason: string } | null = null
  private lastError: string | null = null
  private readonly pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
  private readonly subscriptions = new Map<string, SharedControlLogicalSubscription<unknown>>()
  private readonly readyWaiters: SharedControlReadyWaiter[] = []
  private everReady = false
  private readonly socketGeneration = new SharedControlSocketGeneration()

  constructor(
    private readonly pairing: PairingOffer,
    private readonly options: {
      environmentId?: string
      reconnectStableResetMs?: number
      liveness?: RemoteRuntimeSocketLivenessOptions
    } = {}
  ) {
    this.readyStableReset = new SharedControlReadyStableResetTimer(
      options.reconnectStableResetMs ?? 30_000
    )
  }

  request<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<RuntimeRpcResponse<TResult>> {
    return requestSharedControl({
      pendingRequests: this.pendingRequests,
      method,
      params,
      timeoutMs,
      ensureReady: () => this.ensureReadyWithTimeout(timeoutMs),
      send: (requestId, requestMethod, requestParams) =>
        this.sendRequest(requestId, requestMethod, requestParams)
    })
  }

  async subscribe<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    callbacks: SharedControlSubscriptionCallbacks<TResult>
  ): Promise<RemoteRuntimeSharedSubscription> {
    return startSharedControlSubscription({
      subscriptions: this.subscriptions,
      method,
      params,
      callbacks,
      ensureReady: () => this.ensureReadyWithTimeout(timeoutMs),
      sendSubscription: (subscription) => this.sendSubscription(subscription),
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
  }

  getDiagnostics(): RemoteRuntimeSharedConnectionDiagnostics {
    return sharedControlState.buildSharedControlDiagnostics({
      state: this.state,
      reconnecting: this.reconnect.isScheduled,
      pendingRequestCount: this.pendingRequests.size,
      subscriptionCount: this.subscriptions.size,
      reconnectAttempt: this.reconnect.attemptCount,
      lastConnectedAt: this.lastConnectedAt,
      lastClose: this.lastClose,
      lastError: this.lastError
    })
  }

  reconnectNow(): void {
    const ready = isSharedControlReady({
      state: this.state,
      ws: this.ws,
      sharedKey: this.sharedKey
    })
    if (this.intentionallyClosed || ready) {
      return
    }
    // Why: a successful one-shot status probe proves the restarted endpoint is reachable; replace even a stuck CONNECTING/awaiting-ready socket instead of waiting behind stale backoff.
    this.closeSocket(remoteRuntimeUnavailableError('Refreshing remote runtime control transport.'))
    this.open()
  }

  private ensureReadyWithTimeout(timeoutMs: number): Promise<void> {
    if (isSharedControlReady({ state: this.state, ws: this.ws, sharedKey: this.sharedKey })) {
      return Promise.resolve()
    }
    return waitForSharedControlReadyWithTimeout({
      readyWaiters: this.readyWaiters,
      timeoutMs,
      open: () => {
        if (
          !this.ws ||
          this.ws.readyState === WebSocket.CLOSED ||
          this.ws.readyState === WebSocket.CLOSING
        ) {
          this.open()
        }
      }
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
    const opened = openSharedControlSocket(this.pairing, {
      getCurrentSocket: () => this.ws,
      onClose: (close, error) => {
        if (this.socketGeneration.isCurrent(socketGeneration)) {
          this.lastClose = close
        }
        this.handleSocketClosed(error, socketGeneration)
      },
      onError: (error) => this.handleSocketClosed(error, socketGeneration),
      onTextFrame: (frame) => this.handleTextFrame(frame, socketGeneration),
      liveness: {
        options: this.options.liveness,
        onDead: (error) => this.handleSocketClosed(error, socketGeneration)
      }
    })
    if (!opened.ok) {
      this.handleSocketClosed(opened.error, socketGeneration)
      return
    }
    this.ws = opened.socket.ws
    this.sharedKey = opened.socket.sharedKey
    this.socketCleanup = opened.socket.cleanup
    this.state = 'awaiting_ready'
  }

  private handleTextFrame(frame: string, socketGeneration: number): void {
    if (!this.socketGeneration.isCurrent(socketGeneration)) {
      return
    }
    handleSharedControlTextFrame({
      frame,
      state: this.state,
      sharedKey: this.sharedKey,
      environmentId: this.options.environmentId,
      deviceToken: this.pairing.deviceToken,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions,
      readyWaiters: this.readyWaiters,
      setState: (state) => {
        this.state = state
      },
      handleSocketClosed: (error) => this.handleSocketClosed(error, socketGeneration),
      sendEncrypted: (payload) => this.sendEncrypted(payload),
      markReady: () => {
        this.lastConnectedAt = Date.now()
        this.scheduleReconnectAttemptReset()
      },
      replaySubscriptions: () => this.replaySubscriptions()
    })
  }

  private sendRequest(requestId: string, method: string, params: unknown): void {
    sendSharedControlRequest({
      pendingRequests: this.pendingRequests,
      requestId,
      deviceToken: this.pairing.deviceToken,
      method,
      params,
      send: (payload) => this.sendEncrypted(payload),
      reject: (id, error) =>
        sharedControlState.rejectSharedControlPendingRequest(this.pendingRequests, id, error)
    })
  }

  private sendSubscription(subscription: SharedControlLogicalSubscription<unknown>): void {
    sendSharedControlSubscription({
      subscriptions: this.subscriptions,
      subscription,
      deviceToken: this.pairing.deviceToken,
      send: (payload) => this.sendEncrypted(payload)
    })
  }

  private replaySubscriptions(): void {
    sharedControlSubscriptions.replaySharedControlSubscriptions({
      subscriptions: this.subscriptions,
      send: (subscription) => this.sendSubscription(subscription),
      tagReplayedResponses: this.everReady
    })
    this.everReady = true
  }

  private closeSubscription(requestId: string): void {
    sharedControlSubscriptions.closeSharedControlLogicalSubscription({
      subscriptions: this.subscriptions,
      subscription: this.subscriptions.get(requestId),
      request: (method, params) => this.sendSubscriptionCleanupRequest(method, params)
    })
    this.reconnect.clearWhenIdle(this.subscriptions.size === 0 && this.state === 'closed')
  }

  private sendEncrypted(payload: unknown): boolean {
    return sendSharedControlEncrypted({
      state: this.state,
      ws: this.ws,
      sharedKey: this.sharedKey,
      payload
    })
  }

  private sendSubscriptionCleanupRequest(method: string, params: unknown): void {
    sharedControlSubscriptions.sendSharedControlCleanupRequest({
      deviceToken: this.pairing.deviceToken,
      method,
      params,
      send: (payload) => this.sendEncrypted(payload)
    })
  }

  private handleSocketClosed(error: RemoteRuntimeClientError, socketGeneration: number): void {
    if (
      !this.socketGeneration.acceptClose({
        generation: socketGeneration,
        error,
        everReady: this.everReady,
        subscriptions: this.subscriptions,
        closeSocket: () => this.closeSocket(error)
      })
    ) {
      return
    }
    this.lastError = error.message
    if (this.subscriptions.size > 0 && !this.intentionallyClosed) {
      this.reconnect.scheduleWithDefaultBackoff(this.intentionallyClosed, () => this.open())
    }
  }

  private closeSocket(error?: Error): void {
    closeSharedControlSocket({
      environmentId: this.options.environmentId,
      state: this.state,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions,
      readyWaiters: this.readyWaiters,
      lastClose: this.lastClose,
      socketCleanup: this.socketCleanup,
      ws: this.ws,
      error,
      clearReadyStableTimer: () => this.readyStableReset.clear()
    })
    this.ws = null
    this.sharedKey = null
    this.socketCleanup = null
    this.state = 'closed'
  }

  private scheduleReconnectAttemptReset(): void {
    this.readyStableReset.schedule({
      getState: () => this.state,
      getSocket: () => this.ws,
      reset: () => this.reconnect.resetAttempt()
    })
  }
}
