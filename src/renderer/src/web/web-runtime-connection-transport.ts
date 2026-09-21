import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { withReconnectJitter } from '../../../shared/reconnect-jitter'
import { WebRuntimeConnectionHeartbeat } from './web-runtime-connection-heartbeat'
import {
  routeWebRuntimeConnectionFrame,
  type WebRuntimeConnectionState
} from './web-runtime-connection-frame-router'
import { createWebRuntimeUnauthorizedError } from './web-runtime-client-error'
import {
  deriveSharedKey,
  encrypt,
  encryptBytes,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './web-e2ee'
import type { WebPairingOffer } from './web-pairing'
import type { WebRuntimeTransportSubscription } from './web-runtime-subscription-contract'
import { WebRuntimeSubscriptionRegistry } from './web-runtime-subscription-registry'
import { WebRuntimeRequestRegistry } from './web-runtime-request-registry'
import { WebRuntimeConnectionWaiters } from './web-runtime-connection-waiters'

const CONNECT_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000]

export class WebRuntimeConnectionTransport {
  ws: WebSocket | null = null
  sharedKey: Uint8Array | null = null
  state: WebRuntimeConnectionState = 'disconnected'
  readonly subscriptions: Map<string, WebRuntimeTransportSubscription>
  readonly heartbeat: WebRuntimeConnectionHeartbeat
  private requestCounter = 0
  private reconnectAttempt = 0
  private intentionallyClosed = false
  private connectTimer: number | null = null
  private handshakeTimer: number | null = null
  private reconnectTimer: number | null = null
  private readonly serverPublicKey: Uint8Array
  private readonly subscriptionRegistry: WebRuntimeSubscriptionRegistry
  private readonly requestRegistry: WebRuntimeRequestRegistry
  private readonly connectionWaiters: WebRuntimeConnectionWaiters

  constructor(
    private readonly pairing: WebPairingOffer,
    clock: { now: () => number; isDocumentVisible: () => boolean }
  ) {
    this.serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
    this.connectionWaiters = new WebRuntimeConnectionWaiters({
      endpoint: pairing.endpoint,
      getState: () => this.state,
      isIntentionallyClosed: () => this.intentionallyClosed
    })
    this.subscriptionRegistry = new WebRuntimeSubscriptionRegistry({
      deviceToken: pairing.deviceToken,
      nextId: () => this.nextId(),
      sendEncrypted: (message) => this.sendEncrypted(message)
    })
    this.subscriptions = this.subscriptionRegistry.subscriptions
    this.requestRegistry = new WebRuntimeRequestRegistry({
      deviceToken: pairing.deviceToken,
      nextId: () => this.nextId(),
      waitForConnected: (timeoutMs) => this.connectionWaiters.wait(timeoutMs),
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
          deviceToken: this.pairing.deviceToken,
          method: 'status.get'
        }),
      handleDeadSocket: (socket) => this.handleSocketClosed(socket)
    })
    this.openConnection()
  }

  async call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<RuntimeRpcResponse<unknown>> {
    return this.requestRegistry.call(method, params, options)
  }

  close(options: { notifySubscriptions?: boolean } = {}): void {
    this.intentionallyClosed = true
    this.clearTimers()
    this.requestRegistry.rejectAll('Remote Orca runtime connection closed.')
    this.connectionWaiters.rejectAll(new Error('Remote Orca runtime connection closed.'))
    this.subscriptionRegistry.close(options.notifySubscriptions ?? true)
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.sharedKey = null
    this.setState('disconnected')
  }

  async handleSocketMessage(rawData: unknown, sourceWs?: WebSocket): Promise<void> {
    await routeWebRuntimeConnectionFrame(rawData, sourceWs, {
      getState: () => this.state,
      getSharedKey: () => this.sharedKey,
      getSocket: () => this.ws,
      pairingToken: this.pairing.deviceToken,
      pending: this.requestRegistry.pending,
      subscriptions: this.subscriptions,
      sendEncrypted: (message) => this.sendEncrypted(message),
      setConnected: () => {
        this.clearHandshakeTimer()
        this.reconnectAttempt = 0
        this.setState('connected')
      },
      setAuthFailed: () => {
        this.intentionallyClosed = true
        this.setState('auth-failed')
      },
      rejectUnauthorized: (error) => this.requestRegistry.rejectAll(error),
      notifyUnauthorized: () =>
        this.notifySubscriptionsError('unauthorized', 'Unauthorized. Pair this web client again.')
    })
  }

  handleSocketClosed(closedWs: WebSocket): void {
    if (this.ws !== closedWs) {
      return
    }
    this.ws = null
    this.sharedKey = null
    this.clearConnectTimer()
    this.clearHandshakeTimer()
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
      this.connectionWaiters.rejectAll(createWebRuntimeUnauthorizedError())
    }
  }

  private openConnection(): void {
    if (this.intentionallyClosed) {
      return
    }
    let socket: WebSocket
    try {
      socket = new WebSocket(this.pairing.endpoint)
    } catch (error) {
      this.requestRegistry.rejectAll(error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.ws = socket
    this.sharedKey = null
    this.setState('connecting')
    this.connectTimer = window.setTimeout(() => {
      if (this.ws === socket && socket.readyState === WebSocket.CONNECTING) {
        socket.close()
        this.handleSocketClosed(socket)
      }
    }, CONNECT_TIMEOUT_MS)
    socket.onopen = () => {
      if (this.ws !== socket) {
        return
      }
      this.clearConnectTimer()
      this.setState('handshaking')
      const keyPair = generateKeyPair()
      this.sharedKey = deriveSharedKey(keyPair.secretKey, this.serverPublicKey)
      socket.send(
        JSON.stringify({ type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(keyPair.publicKey) })
      )
      this.handshakeTimer = window.setTimeout(() => {
        if (this.ws === socket && this.state === 'handshaking') {
          socket.close()
        }
      }, HANDSHAKE_TIMEOUT_MS)
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
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.sharedKey) {
      return false
    }
    socket.send(encrypt(JSON.stringify(message), this.sharedKey))
    return true
  }

  sendEncryptedBinary(bytes: Uint8Array<ArrayBufferLike>): boolean {
    const socket = this.ws
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.sharedKey) {
      return false
    }
    socket.send(encryptBytes(bytes, this.sharedKey))
    return true
  }

  waitForConnected(timeoutMs = 30_000): Promise<void> {
    return this.connectionWaiters.wait(timeoutMs)
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionallyClosed) {
      return
    }
    const delay = withReconnectJitter(
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    )
    this.reconnectAttempt += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.openConnection()
    }, delay)
  }

  nextId(): string {
    this.requestCounter += 1
    return `web-rpc-${this.requestCounter}-${Date.now()}`
  }

  private notifySubscriptionsError(code: string, message: string): void {
    this.subscriptionRegistry.notifyError(code, message)
  }

  private clearTimers(): void {
    this.clearConnectTimer()
    this.clearHandshakeTimer()
    this.heartbeat.clear()
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearConnectTimer(): void {
    if (!this.connectTimer) {
      return
    }
    window.clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private clearHandshakeTimer(): void {
    if (!this.handshakeTimer) {
      return
    }
    window.clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }
}
