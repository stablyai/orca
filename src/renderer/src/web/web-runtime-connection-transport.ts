import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { withReconnectJitter } from '../../../shared/reconnect-jitter'
import { WebRuntimeConnectionHeartbeat } from './web-runtime-connection-heartbeat'
import {
  routeWebRuntimeConnectionFrame,
  type WebRuntimeConnectionState
} from './web-runtime-connection-frame-router'
import {
  WebRuntimeConnectionAuth,
  type WebRuntimeConnectionLifecycle
} from './web-runtime-connection-auth'
import type { WebRuntimeAuthPlan } from './web-runtime-credential-source'
import { WebRuntimeConnectionTimers } from './web-runtime-connection-timers'
import {
  createPairedE2EEClientHandshake,
  type PairedE2EEClientHandshake
} from '../../../shared/paired-e2ee-client-handshake'
import { WEB_PAIRED_E2EE_PRIMITIVES } from './web-paired-e2ee-primitives'
import { withWebClientUpgradeMarker } from '../../../shared/web-origin-security'
import type { WebRuntimeTransportSubscription } from './web-runtime-subscription-contract'
import { WebRuntimeSubscriptionRegistry } from './web-runtime-subscription-registry'
import { WebRuntimeRequestRegistry } from './web-runtime-request-registry'
import { WebRuntimeConnectionWaiters } from './web-runtime-connection-waiters'

const CONNECT_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000]

export class WebRuntimeConnectionTransport {
  ws: WebSocket | null = null
  handshake: PairedE2EEClientHandshake | null = null
  private readonly auth: WebRuntimeConnectionAuth
  state: WebRuntimeConnectionState = 'disconnected'
  readonly subscriptions: Map<string, WebRuntimeTransportSubscription>
  readonly heartbeat: WebRuntimeConnectionHeartbeat
  private requestCounter = 0
  private reconnectAttempt = 0
  private intentionallyClosed = false
  private readonly timers = new WebRuntimeConnectionTimers()
  private readonly subscriptionRegistry: WebRuntimeSubscriptionRegistry
  private readonly requestRegistry: WebRuntimeRequestRegistry
  private readonly connectionWaiters: WebRuntimeConnectionWaiters

  constructor(
    private readonly connection: PairedRuntimeConnection,
    clock: { now: () => number; isDocumentVisible: () => boolean },
    private readonly lifecycle: WebRuntimeConnectionLifecycle = {}
  ) {
    this.auth = new WebRuntimeConnectionAuth(connection, {
      ...lifecycle,
      retryLater: () => this.scheduleReconnect()
    })
    this.connectionWaiters = new WebRuntimeConnectionWaiters({
      endpoint: connection.endpoint,
      getState: () => this.state,
      getAuthError: () => this.auth.failureError(),
      isIntentionallyClosed: () => this.intentionallyClosed
    })
    this.subscriptionRegistry = new WebRuntimeSubscriptionRegistry({
      deviceToken: connection.credential.deviceToken,
      nextId: () => this.nextId(),
      sendEncrypted: (message) => this.sendEncrypted(message)
    })
    this.subscriptions = this.subscriptionRegistry.subscriptions
    this.requestRegistry = new WebRuntimeRequestRegistry({
      deviceToken: connection.credential.deviceToken,
      nextId: () => this.nextId(),
      waitForConnected: (timeoutMs, signal) => this.connectionWaiters.wait(timeoutMs, signal),
      sendEncrypted: (message) => this.sendEncrypted(message)
    })
    this.heartbeat = new WebRuntimeConnectionHeartbeat({
      now: clock.now,
      isDocumentVisible: clock.isDocumentVisible,
      isConnected: () => this.state === 'connected',
      getSocket: () => this.ws,
      sendProbe: () =>
        this.sendEncrypted({
          id: `web-heartbeat-${this.nextId()}`,
          deviceToken: this.connection.credential.deviceToken,
          method: 'status.get'
        }),
      handleDeadSocket: (socket) => this.handleSocketClosed(socket)
    })
    this.openConnection()
  }

  async call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RuntimeRpcResponse<unknown>> {
    return this.requestRegistry.call(method, params, options)
  }

  close(options: { notifySubscriptions?: boolean } = {}): void {
    this.intentionallyClosed = true
    this.clearTimers()
    this.requestRegistry.rejectAll('Remote Orca runtime connection closed.')
    this.connectionWaiters.rejectAll(new Error('Remote Orca runtime connection closed.'))
    this.subscriptionRegistry.close(options.notifySubscriptions ?? true)
    this.ws?.close()
    this.ws = null
    this.handshake = null
    this.setState('disconnected')
  }

  async handleSocketMessage(rawData: unknown, sourceWs?: WebSocket): Promise<void> {
    await routeWebRuntimeConnectionFrame(rawData, sourceWs, {
      getState: () => this.state,
      getHandshake: () => this.handshake,
      getSocket: () => this.ws,
      pending: this.requestRegistry.pending,
      subscriptions: this.subscriptions,
      sendAuth: (handshake) => this.sendAuth(handshake),
      setConnected: () => this.handleAuthenticated(),
      authRejected: (reply) => void this.handleAuthRejected(reply)
    })
  }

  private handleAuthenticated(): void {
    const socket = this.ws
    const handshake = this.handshake
    if (
      socket &&
      handshake &&
      this.auth.migrateIfPlanned({
        handshake,
        beginMigration: () => this.setState('migrating'),
        call: (method, params) => this.requestRegistry.callNow(method, params),
        // Why reconnect either way: the next socket authenticates with the key or the token.
        reconnect: () => {
          if (this.ws === socket) {
            this.reconnectAttempt = 0
            socket.close()
            this.handleSocketClosed(socket)
          }
        }
      })
    ) {
      return
    }
    this.timers.clear('handshake')
    this.reconnectAttempt = 0
    this.setState('connected')
  }

  private async handleAuthRejected(
    reply: Parameters<WebRuntimeConnectionAuth['rejected']>[0]
  ): Promise<void> {
    const socket = this.ws
    const outcome = await this.auth.rejected(reply)
    if (outcome.kind === 'failed') {
      this.intentionallyClosed = true
      this.setState('auth-failed')
      this.requestRegistry.rejectAll(outcome.error)
      this.subscriptionRegistry.notifyError('unauthorized', outcome.error.message)
    }
    socket?.close()
  }

  handleSocketClosed(closedWs: WebSocket): void {
    if (this.ws !== closedWs) {
      return
    }
    this.auth.socketClosed()
    this.ws = null
    this.handshake = null
    this.timers.clear('connect')
    this.timers.clear('handshake')
    this.heartbeat.clear()
    this.requestRegistry.rejectAll('Remote Orca runtime connection interrupted.')
    this.subscriptionRegistry.handleInterrupted()
    if (this.intentionallyClosed || this.state === 'auth-failed') {
      this.setState(this.state === 'auth-failed' ? 'auth-failed' : 'disconnected')
      return
    }
    this.setState('disconnected')
    this.scheduleReconnect()
  }

  setState(next: WebRuntimeConnectionState): void {
    this.state = next
    if (next === 'connected') {
      this.subscriptionRegistry.replayInterrupted()
      this.heartbeat.start()
      this.connectionWaiters.resolveAll()
    } else if (next === 'auth-failed') {
      this.connectionWaiters.rejectAll(this.auth.failureError())
    }
    this.lifecycle.onStateChanged?.(next)
  }

  private openConnection(): void {
    if (this.intentionallyClosed) {
      return
    }
    this.auth.open((plan) => {
      if (!this.intentionallyClosed && !this.ws) {
        this.openSocket(plan)
      }
    })
  }

  private openSocket(plan: WebRuntimeAuthPlan): void {
    let socket: WebSocket
    try {
      socket = new WebSocket(withWebClientUpgradeMarker(this.connection.endpoint))
    } catch (error) {
      this.requestRegistry.rejectAll(error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.ws = socket
    this.handshake = null
    this.setState('connecting')
    this.timers.arm('connect', CONNECT_TIMEOUT_MS, () => {
      if (this.ws === socket && socket.readyState === WebSocket.CONNECTING) {
        socket.close()
        this.handleSocketClosed(socket)
      }
    })
    socket.onopen = () => {
      if (this.ws !== socket) {
        return
      }
      this.timers.clear('connect')
      this.setState('handshaking')
      const handshake = createPairedE2EEClientHandshake({
        primitives: WEB_PAIRED_E2EE_PRIMITIVES,
        hostPublicKeyB64: this.connection.hostPublicKeyB64,
        framing: this.auth.framingFor(plan),
        transport: 'direct'
      })
      this.handshake = handshake
      socket.send(handshake.helloText())
      this.timers.arm('handshake', HANDSHAKE_TIMEOUT_MS, () => {
        if (this.ws === socket && (this.state === 'handshaking' || this.state === 'migrating')) {
          socket.close()
        }
      })
    }
    socket.onmessage = (event) => {
      if (this.ws !== socket) {
        return
      }
      this.heartbeat.noteInboundFrame()
      void this.handleSocketMessage(event.data, socket)
    }
    socket.onclose = () => this.handleSocketClosed(socket)
    socket.onerror = () => {
      if (this.state === 'connecting') {
        this.connectionWaiters.rejectUnavailable()
      }
    }
  }

  sendEncrypted(message: unknown): boolean {
    const socket = this.ws
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.handshake) {
      return false
    }
    socket.send(this.handshake.channel.sealText(JSON.stringify(this.auth.outbound(message))))
    return true
  }

  private sendAuth(handshake: PairedE2EEClientHandshake): void {
    const socket = this.ws
    this.auth.sendAuth({
      handshake,
      fallbackToken: this.connection.credential.deviceToken,
      // Why: the socket may have closed or been replaced while the auth step ran.
      isCurrent: () =>
        this.handshake === handshake &&
        this.ws === socket &&
        socket?.readyState === WebSocket.OPEN &&
        this.state === 'handshaking',
      send: (frame) => socket?.send(frame),
      fail: () => socket?.close()
    })
  }

  sendEncryptedBinary(bytes: Uint8Array<ArrayBufferLike>): boolean {
    const socket = this.ws
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.handshake) {
      return false
    }
    socket.send(this.handshake.channel.sealBinary(bytes))
    return true
  }

  waitForConnected(timeoutMs = 30_000): Promise<void> {
    return this.connectionWaiters.wait(timeoutMs)
  }

  private scheduleReconnect(): void {
    if (
      this.timers.has('reconnect') ||
      this.intentionallyClosed ||
      this.lifecycle.reconnect === false
    ) {
      return
    }
    const delay = withReconnectJitter(
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    )
    this.reconnectAttempt += 1
    this.timers.arm('reconnect', delay, () => this.openConnection())
  }

  nextId(): string {
    this.requestCounter += 1
    return `web-rpc-${this.requestCounter}-${Date.now()}`
  }

  private clearTimers(): void {
    this.timers.clearAll()
    this.heartbeat.clear()
  }
}
