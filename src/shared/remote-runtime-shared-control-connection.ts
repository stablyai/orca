import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RemoteRuntimeClientError } from './remote-runtime-client'
import {
  parseAuthenticatedFrame,
  parseReadyFrame,
  remoteRuntimeUnavailableError
} from './remote-runtime-request-frames'
import { openSharedControlSocket } from './remote-runtime-shared-control-open'
import {
  logSharedControlSocketClose,
  logUnknownSharedControlResponse
} from './remote-runtime-shared-control-diagnostics-log'
import {
  parseSharedControlFrame,
  sendSharedControlEncrypted
} from './remote-runtime-shared-control-protocol'
import {
  isSharedControlReady,
  waitForSharedControlReadyWithTimeout
} from './remote-runtime-shared-control-ready'
import { scheduleSharedControlReconnectOrFinish } from './remote-runtime-shared-control-reconnect'
import { requestSharedControl } from './remote-runtime-shared-control-requests'
import { scheduleSharedControlStableReset } from './remote-runtime-shared-control-stability'
import {
  buildSharedControlDiagnostics,
  closeSharedControlSocketState,
  finishSharedControlSubscription,
  refreshSharedControlPendingRequestTimeouts,
  rejectSharedControlPendingRequest,
  rejectSharedControlReadyWaiters,
  resolveSharedControlPendingResponse,
  resolveSharedControlReadyWaiters
} from './remote-runtime-shared-control-state'
import {
  closeSharedControlLogicalSubscription,
  createSharedControlSubscription,
  finishCloseAfterReadySubscriptions,
  handleSharedControlLogicalResponse,
  replaySharedControlSubscriptions,
  sendSharedControlCleanupRequest
} from './remote-runtime-shared-control-subscriptions'
import type {
  RemoteRuntimeSharedConnectionDiagnostics,
  RemoteRuntimeSharedSubscription,
  SharedControlConnectionState,
  SharedControlLogicalSubscription,
  SharedControlPendingRequest,
  SharedControlReadyWaiter,
  SharedControlSubscriptionCallbacks
} from './remote-runtime-shared-control-types'

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000]
const RECONNECT_STABLE_RESET_MS = 30_000
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
    const requestId = randomUUID()
    const subscription = createSharedControlSubscription({ requestId, method, params, callbacks })
    this.subscriptions.set(requestId, subscription as SharedControlLogicalSubscription<unknown>)
    try {
      await this.ensureReadyWithTimeout(timeoutMs)
    } catch (error) {
      finishSharedControlSubscription(
        this.subscriptions,
        subscription as SharedControlLogicalSubscription<unknown>,
        false
      )
      throw error
    }
    if (this.subscriptions.get(requestId) !== subscription) {
      throw remoteRuntimeUnavailableError('Remote runtime subscription closed before it started.')
    }
    this.sendSubscription(subscription as SharedControlLogicalSubscription<unknown>)
    return { requestId, close: () => this.closeSubscription(requestId), sendBinary: () => false }
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
    return buildSharedControlDiagnostics({
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
      rejectSharedControlReadyWaiters(this.readyWaiters, remoteRuntimeUnavailableError())
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
    if (this.state === 'awaiting_ready') {
      const error = parseReadyFrame(frame)
      if (error) {
        this.handleSocketClosed(error)
        return
      }
      this.state = 'awaiting_authenticated'
      this.sendEncrypted({ type: 'e2ee_auth', deviceToken: this.pairing.deviceToken })
      return
    }
    const parsed = parseSharedControlFrame(frame, this.sharedKey, this.state)
    if (parsed.type === 'auth') {
      const error = parseAuthenticatedFrame(parsed.plaintext)
      if (error) {
        this.handleSocketClosed(error)
        return
      }
      this.state = 'ready'
      this.lastConnectedAt = Date.now()
      this.scheduleReconnectAttemptReset()
      resolveSharedControlReadyWaiters(this.readyWaiters)
      this.replaySubscriptions()
      return
    }
    if (parsed.type === 'error') {
      this.handleSocketClosed(parsed.error)
      return
    }
    if (parsed.frame.type === 'keepalive') {
      refreshSharedControlPendingRequestTimeouts(this.pendingRequests)
      return
    }
    const response = parsed.frame.response
    const subscription = this.subscriptions.get(response.id)
    if (subscription) {
      handleSharedControlLogicalResponse({
        subscriptions: this.subscriptions,
        subscription,
        response,
        request: (method, params) => this.sendSubscriptionCleanupRequest(method, params)
      })
      return
    }
    if (this.pendingRequests.has(response.id)) {
      resolveSharedControlPendingResponse(this.pendingRequests, response.id, response)
      return
    }
    logUnknownSharedControlResponse({
      environmentId: this.options.environmentId,
      responseId: response.id,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions
    })
  }

  private sendRequest(requestId: string, method: string, params: unknown): void {
    if (!this.pendingRequests.has(requestId)) {
      return
    }
    if (
      !this.sendEncrypted({ id: requestId, deviceToken: this.pairing.deviceToken, method, params })
    ) {
      rejectSharedControlPendingRequest(
        this.pendingRequests,
        requestId,
        remoteRuntimeUnavailableError()
      )
    }
  }

  private sendSubscription(subscription: SharedControlLogicalSubscription<unknown>): void {
    if (subscription.closed || subscription.sent) {
      return
    }
    if (
      this.sendEncrypted({
        id: subscription.requestId,
        deviceToken: this.pairing.deviceToken,
        method: subscription.method,
        params: subscription.params
      })
    ) {
      subscription.sent = true
      return
    }
    finishSharedControlSubscription(
      this.subscriptions,
      subscription,
      true,
      remoteRuntimeUnavailableError()
    )
  }

  private replaySubscriptions(): void {
    replaySharedControlSubscriptions({
      subscriptions: this.subscriptions,
      send: (subscription) => this.sendSubscription(subscription)
    })
  }

  private closeSubscription(requestId: string): void {
    const subscription = this.subscriptions.get(requestId)
    if (!subscription) {
      return
    }
    closeSharedControlLogicalSubscription({
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
    sendSharedControlCleanupRequest({
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
    this.logSocketClose(error)
    this.clearReadyStableTimer()
    this.ws = null
    this.sharedKey = null
    this.socketCleanup = null
    this.state = 'closed'
    finishCloseAfterReadySubscriptions(this.subscriptions)
    closeSharedControlSocketState({
      readyWaiters: this.readyWaiters,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions,
      socketCleanup: cleanup,
      ws,
      error
    })
  }

  private scheduleReconnect(): void {
    const scheduled = scheduleSharedControlReconnectOrFinish({
      current: this.reconnectTimer,
      intentionallyClosed: this.intentionallyClosed,
      reconnectAttempt: this.reconnectAttempt,
      delaysMs: RECONNECT_DELAYS_MS,
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
      delayMs: this.options.reconnectStableResetMs ?? RECONNECT_STABLE_RESET_MS,
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

  private logSocketClose(error?: Error): void {
    if (!this.ws && !this.socketCleanup) {
      return
    }
    logSharedControlSocketClose({
      environmentId: this.options.environmentId ?? 'unknown',
      state: this.state,
      pendingRequests: this.pendingRequests,
      subscriptions: this.subscriptions,
      lastClose: this.lastClose,
      error
    })
  }
}
