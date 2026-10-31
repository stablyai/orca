import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import { withReconnectJitter } from '../../../shared/reconnect-jitter'
import { WebRuntimeConnectionHeartbeat } from './web-runtime-connection-heartbeat'
import {
  routeWebRuntimeConnectionFrame,
  type WebRuntimeConnectionState
} from './web-runtime-connection-frame-router'
import {
  WebRuntimeConnectionAuth,
  handleRejectedWebRuntimeAuth,
  type WebRuntimeConnectionLifecycle
} from './web-runtime-connection-auth'
import type { WebRuntimeAuthPlan } from './web-runtime-credential-source'
import { WebRuntimeConnectionTimers } from './web-runtime-connection-timers'
import type { PairedE2EEClientHandshake } from '../../../shared/paired-e2ee-client-handshake'
import { withWebClientUpgradeMarker } from '../../../shared/web-origin-security'
import type { WebRuntimeTransportSubscription } from './web-runtime-subscription-contract'
import { WebRuntimeSubscriptionRegistry } from './web-runtime-subscription-registry'
import { WebRuntimeRequestRegistry } from './web-runtime-request-registry'
import {
  installWebRuntimeSocket,
  sendWebRuntimeSocketAuth,
  closeWebRuntimeSocket
} from './web-runtime-connection-socket'
import { WebRuntimeConnectionWaiters } from './web-runtime-connection-waiters'
import {
  runtimeEnvironmentSetupFailure,
  type RuntimeEnvironmentSetupFailure
} from '../../../shared/runtime-environment-subscription-setup'

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
  readonly requestRegistry: WebRuntimeRequestRegistry
  private readonly connectionWaiters: WebRuntimeConnectionWaiters
  setupFailure: RuntimeEnvironmentSetupFailure | undefined

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
      getSetupFailure: () => this.setupFailure,
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

  readonly call: WebRuntimeRequestRegistry['call'] = (method, params, options) =>
    this.requestRegistry.call(method, params, options)

  close(options: { notifySubscriptions?: boolean } = {}): void {
    this.intentionallyClosed = true
    this.clearTimers()
    this.requestRegistry.rejectAll('Remote Orca runtime connection closed.')
    this.connectionWaiters.rejectAll(new Error('Remote Orca runtime connection closed.'))
    this.subscriptionRegistry.close(options.notifySubscriptions ?? true)
    closeWebRuntimeSocket(this, this.lifecycle.crewAttempt === true, (error) => {
      this.setupFailure ??= runtimeEnvironmentSetupFailure(error, 'subscription')
    })
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

  private handleAuthRejected(
    reply: Parameters<WebRuntimeConnectionAuth['rejected']>[0]
  ): Promise<void> {
    return handleRejectedWebRuntimeAuth(reply, {
      auth: this.auth,
      lifecycle: this.lifecycle,
      getSocket: () => this.ws,
      isClosed: () => this.intentionallyClosed,
      failSetup: (error) => this.failSetup(error),
      failAuth: (error) => {
        if (this.lifecycle.crewAttempt) {
          this.setupFailure = { error, fact: { kind: 'remote', code: 'unauthorized' } }
        }
        this.intentionallyClosed = true
        this.setState('auth-failed')
        this.requestRegistry.rejectAll(error)
        this.subscriptionRegistry.notifyError('unauthorized', error.message)
      },
      close: () => this.close({ notifySubscriptions: false })
    })
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
    if (this.lifecycle.crewAttempt && !this.intentionallyClosed) {
      this.failSetup(new Error('Remote Orca runtime connection interrupted.'))
      return
    }
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
      this.requestRegistry.connectionOpened()
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
      this.lifecycle.assertCurrent?.()
      socket = new WebSocket(withWebClientUpgradeMarker(this.connection.endpoint))
    } catch (error) {
      if (this.lifecycle.crewAttempt) {
        this.failSetup(error)
        return
      }
      this.requestRegistry.rejectAll(error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }
    socket.binaryType = 'arraybuffer'
    this.ws = socket
    this.handshake = null
    installWebRuntimeSocket({
      socket,
      connection: this.connection,
      plan,
      auth: this.auth,
      timers: this.timers,
      owner: this,
      noteInboundFrame: () => this.heartbeat.noteInboundFrame(),
      rejectUnavailable: () => this.connectionWaiters.rejectUnavailable(),
      isClosed: () => this.intentionallyClosed,
      failSetup: (error) => this.failSetup(error),
      finite: this.lifecycle.crewAttempt === true,
      assertCurrent: this.lifecycle.assertCurrent
    })
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
    sendWebRuntimeSocketAuth(handshake, {
      owner: this,
      connection: this.connection,
      authOwner: this.auth,
      lifecycle: this.lifecycle,
      isClosed: () => this.intentionallyClosed,
      failSetup: (error) => this.failSetup(error)
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

  waitForConnected(timeoutMs = 30_000, signal?: AbortSignal): Promise<void> {
    return this.connectionWaiters.wait(timeoutMs, signal)
  }

  private failSetup(error: unknown): void {
    this.setupFailure ??= runtimeEnvironmentSetupFailure(error, 'subscription')
    this.connectionWaiters.rejectAll(this.setupFailure.error)
    this.close()
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
