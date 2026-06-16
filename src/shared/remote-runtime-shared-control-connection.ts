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
import { scheduleSharedControlReconnectOrFinish } from './remote-runtime-shared-control-reconnect'
import { requestSharedControl } from './remote-runtime-shared-control-requests'
import { scheduleSharedControlStableReset } from './remote-runtime-shared-control-stability'
import * as sharedControlState from './remote-runtime-shared-control-state'
import {
  sendSharedControlRequest,
  sendSharedControlSubscription
} from './remote-runtime-shared-control-send'
import { closeSharedControlSocket } from './remote-runtime-shared-control-socket-close'
import * as sharedControlSubscriptions from './remote-runtime-shared-control-subscriptions'
import { startSharedControlSubscription } from './remote-runtime-shared-control-subscription-start'
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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readyStableTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private intentionallyClosed = false
  private lastConnectedAt: number | null = null
  private lastClose: { code: number; reason: string } | null = null
  private lastError: string | null = null
  private readonly pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
  private readonly subscriptions = new Map<string, SharedControlLogicalSubscription<unknown>>()
  private readonly readyWaiters: SharedControlReadyWaiter[] = []

  constructor(
    private readonly pairing: PairingOffer,
    private readonly options: { environmentId?: string; reconnectStableResetMs?: number } = {}
  ) {}

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
    this.clearReconnectTimer()
    for (const subscription of Array.from(this.subscriptions.values())) {
      this.closeSubscription(subscription.requestId)
    }
    this.closeSocket(error)
  }

  getDiagnostics(): RemoteRuntimeSharedConnectionDiagnostics {
    return sharedControlState.buildSharedControlDiagnostics({
      state: this.state,
      reconnecting: this.reconnectTimer !== null,
      pendingRequestCount: this.pendingRequests.size,
      subscriptionCount: this.subscriptions.size,
      reconnectAttempt: this.reconnectAttempt,
      lastConnectedAt: this.lastConnectedAt,
      lastClose: this.lastClose,
      lastError: this.lastError
    })
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
    this.clearReconnectTimer()
    const opened = openSharedControlSocket(this.pairing, {
      getCurrentSocket: () => this.ws,
      onClose: (close, error) => {
        this.lastClose = close
        this.handleSocketClosed(error)
      },
      onError: (error) => {
        this.lastError = error.message
        this.handleSocketClosed(error)
      },
      onTextFrame: (frame) => this.handleTextFrame(frame)
    })
    if (!opened.ok) {
      this.handleSocketClosed(opened.error)
      return
    }
    this.ws = opened.socket.ws
    this.sharedKey = opened.socket.sharedKey
    this.socketCleanup = opened.socket.cleanup
    this.state = 'awaiting_ready'
  }

  private handleTextFrame(frame: string): void {
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
      handleSocketClosed: (error) => this.handleSocketClosed(error),
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
      send: (subscription) => this.sendSubscription(subscription)
    })
  }

  private closeSubscription(requestId: string): void {
    const subscription = this.subscriptions.get(requestId)
    if (!subscription) {
      return
    }
    sharedControlSubscriptions.closeSharedControlLogicalSubscription({
      subscriptions: this.subscriptions,
      subscription,
      request: (method, params) => this.sendSubscriptionCleanupRequest(method, params)
    })
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

  private handleSocketClosed(error: RemoteRuntimeClientError): void {
    this.lastError = error.message
    this.closeSocket(error)
    if (this.subscriptions.size > 0 && !this.intentionallyClosed) {
      this.scheduleReconnect()
    }
  }

  private closeSocket(error?: Error): void {
    const cleanup = this.socketCleanup
    const ws = this.ws
    closeSharedControlSocket({
      environmentId: this.options.environmentId,
      state: this.state,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions,
      readyWaiters: this.readyWaiters,
      lastClose: this.lastClose,
      socketCleanup: cleanup,
      ws,
      error,
      clearReadyStableTimer: () => this.clearReadyStableTimer()
    })
    this.ws = null
    this.sharedKey = null
    this.socketCleanup = null
    this.state = 'closed'
  }

  private scheduleReconnect(): void {
    const scheduled = scheduleSharedControlReconnectOrFinish({
      current: this.reconnectTimer,
      intentionallyClosed: this.intentionallyClosed,
      reconnectAttempt: this.reconnectAttempt,
      delaysMs: [250, 500, 1000, 2000, 4000, 8000, 15_000],
      subscriptions: this.subscriptions,
      open: () => {
        this.reconnectTimer = null
        this.open()
      }
    })
    this.reconnectTimer = scheduled.timer
    this.reconnectAttempt = scheduled.reconnectAttempt
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private scheduleReconnectAttemptReset(): void {
    this.clearReadyStableTimer()
    this.readyStableTimer = scheduleSharedControlStableReset({
      delayMs: this.options.reconnectStableResetMs ?? 30_000,
      getState: () => this.state,
      getSocket: () => this.ws,
      reset: () => {
        this.reconnectAttempt = 0
      },
      clearCurrent: () => {
        this.readyStableTimer = null
      }
    })
  }

  private clearReadyStableTimer(): void {
    if (this.readyStableTimer) {
      clearTimeout(this.readyStableTimer)
      this.readyStableTimer = null
    }
  }
}
