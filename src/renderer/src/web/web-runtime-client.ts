import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'
import { subscribeWebRuntimeFileWatch } from './web-runtime-file-watch-subscription'
import type { WebPairingOffer } from './web-pairing'
import type { WebRuntimeConnectionState } from './web-runtime-connection-frame-router'
import type {
  WebRuntimeSubscribeOptions,
  WebRuntimeSubscriptionCallbacks,
  WebRuntimeTransportSubscription,
  WebRuntimeTransportSubscriptionHandle
} from './web-runtime-subscription-contract'

export type WebRuntimeSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export type SubscribeOptions = WebRuntimeSubscribeOptions

const SHARED_CONNECTION_SUBSCRIPTION_METHODS = new Set(['files.watch'])

export class WebRuntimeClient {
  private readonly transport: WebRuntimeConnectionTransport
  private readonly fileWatchTeardownRetries = new Map<string, Set<() => Promise<void>>>()
  private readonly childClients = new Set<WebRuntimeClient>()

  constructor(private readonly pairing: WebPairingOffer) {
    this.transport = new WebRuntimeConnectionTransport(pairing, {
      now: () => this.now(),
      isDocumentVisible: () => this.isDocumentVisible()
    })
  }

  call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<RuntimeRpcResponse<unknown>> {
    return this.transport.call(method, params, options)
  }

  async subscribe(
    method: string,
    params: unknown,
    callbacks: WebRuntimeSubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeSubscriptionHandle> {
    if (SHARED_CONNECTION_SUBSCRIPTION_METHODS.has(method)) {
      return subscribeWebRuntimeFileWatch({
        params,
        callbacks,
        subscribe: (wrappedCallbacks) =>
          this.subscribeOnCurrentConnection('files.watch', params, wrappedCallbacks, options),
        call: (callMethod, callParams, callOptions) =>
          this.call(callMethod, callParams, callOptions),
        teardownRetries: this.fileWatchTeardownRetries
      })
    }
    const client = new WebRuntimeClient(this.pairing)
    this.childClients.add(client)
    const closeChild = (notifySubscriptions = false): void => {
      this.childClients.delete(client)
      client.close({ notifySubscriptions })
    }
    try {
      const wrappedCallbacks: WebRuntimeSubscriptionCallbacks = {
        ...callbacks,
        onError: (error) => {
          callbacks.onError?.(error)
          closeChild()
        },
        onClose: () => {
          callbacks.onClose?.()
          closeChild()
        }
      }
      const handle = await client.subscribeOnCurrentConnection(
        method,
        params,
        wrappedCallbacks,
        options
      )
      return {
        unsubscribe: () => {
          handle.unsubscribe()
          closeChild()
        },
        sendBinary: (bytes) => handle.sendBinary(bytes)
      }
    } catch (error) {
      closeChild()
      throw error
    }
  }

  close(options: { notifySubscriptions?: boolean } = {}): void {
    const shouldNotifySubscriptions = options.notifySubscriptions ?? true
    for (const child of Array.from(this.childClients)) {
      child.close({ notifySubscriptions: shouldNotifySubscriptions })
    }
    this.childClients.clear()
    this.fileWatchTeardownRetries.clear()
    this.transport.close(options)
  }

  private async subscribeOnCurrentConnection(
    method: string,
    params: unknown,
    callbacks: WebRuntimeSubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeTransportSubscriptionHandle> {
    await this.waitForConnected(options?.timeoutMs)
    const id = this.nextId()
    const subscription = { id, method, params, callbacks, needsReplay: false }
    this.subscriptions.set(id, subscription)
    if (!this.sendEncrypted({ id, deviceToken: this.pairing.deviceToken, method, params })) {
      this.subscriptions.delete(id)
      throw new Error('Remote Orca runtime is not connected.')
    }
    return {
      unsubscribe: () => {
        this.subscriptions.delete(subscription.id)
        const teardown = options?.buildUnsubscribe?.(params)
        if (teardown) {
          this.sendEncrypted({
            id: this.nextId(),
            deviceToken: this.pairing.deviceToken,
            method: teardown.method,
            params: teardown.params
          })
        }
      },
      sendBinary: (bytes) => {
        this.sendEncryptedBinary(bytes)
      }
    }
  }

  protected now(): number {
    return Date.now()
  }

  protected isDocumentVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
  }

  protected get ws(): WebSocket | null {
    return this.transport.ws
  }

  protected set ws(socket: WebSocket | null) {
    this.transport.ws = socket
  }

  protected get sharedKey(): Uint8Array | null {
    return this.transport.sharedKey
  }

  protected set sharedKey(key: Uint8Array | null) {
    this.transport.sharedKey = key
  }

  protected get state(): WebRuntimeConnectionState {
    return this.transport.state
  }

  protected set state(state: WebRuntimeConnectionState) {
    this.transport.state = state
  }

  private get subscriptions(): Map<string, WebRuntimeTransportSubscription> {
    return this.transport.subscriptions
  }

  protected get lastInboundFrameAt(): number {
    return this.transport.heartbeat.lastInboundFrameAt
  }

  protected set lastInboundFrameAt(value: number) {
    this.transport.heartbeat.lastInboundFrameAt = value
  }

  protected get lastHeartbeatTickAt(): number {
    return this.transport.heartbeat.lastHeartbeatTickAt
  }

  protected set lastHeartbeatTickAt(value: number) {
    this.transport.heartbeat.lastHeartbeatTickAt = value
  }

  protected get heartbeatProbeSentAt(): number | null {
    return this.transport.heartbeat.heartbeatProbeSentAt
  }

  protected set heartbeatProbeSentAt(value: number | null) {
    this.transport.heartbeat.heartbeatProbeSentAt = value
  }

  protected startHeartbeat(): void {
    this.transport.heartbeat.start()
  }

  protected runHeartbeatTick(): void {
    this.transport.heartbeat.runTick()
  }

  protected handleSocketMessage(rawData: unknown, sourceWs?: WebSocket): Promise<void> {
    return this.transport.handleSocketMessage(rawData, sourceWs)
  }

  protected handleSocketClosed(socket: WebSocket): void {
    this.transport.handleSocketClosed(socket)
  }

  protected setState(state: WebRuntimeConnectionState): void {
    this.transport.setState(state)
  }

  private waitForConnected(timeoutMs?: number): Promise<void> {
    return this.transport.waitForConnected(timeoutMs)
  }

  private sendEncrypted(message: unknown): boolean {
    return this.transport.sendEncrypted(message)
  }

  private sendEncryptedBinary(bytes: Uint8Array<ArrayBufferLike>): boolean {
    return this.transport.sendEncryptedBinary(bytes)
  }

  private nextId(): string {
    return this.transport.nextId()
  }
}
