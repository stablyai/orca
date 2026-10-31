import {
  subscribeDedicatedWebRuntime,
  observeCrewSubscriptionSetup,
  enrollWebRuntimeSubscription,
  type WebRuntimeCrewSetupOutcome
} from './web-runtime-dedicated-subscription'
import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import type { PairedE2EEClientHandshake } from '../../../shared/paired-e2ee-client-handshake'
import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import type { RuntimeEnvironmentSetupFailure } from '../../../shared/runtime-environment-subscription-setup'
import { RuntimeHostStatusOwner } from '../../../shared/runtime-host-status-owner'
import type {
  RuntimeHostStatusSnapshot,
  RuntimeHostStatusResponse
} from '../../../shared/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'
import type { WebRuntimeCredentialSource } from './web-runtime-credential-source'
import { subscribeWebRuntimeFileWatch } from './web-runtime-file-watch-subscription'
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

  readonly statusOwner?: RuntimeHostStatusOwner

  private readonly credential: WebRuntimeCredentialSource | undefined

  constructor(
    private readonly connection: PairedRuntimeConnection,
    options: {
      reconnect?: boolean
      // Absent: the connection's token over legacy framing, as before device keys.
      credential?: WebRuntimeCredentialSource
      allowKeyMigration?: boolean
      crewAttempt?: true
      assertCurrent?: () => void
      status?: {
        environmentId: string
        pairingRevision: number
        publish: (snapshot: RuntimeHostStatusSnapshot) => void
        verified: (response: RuntimeHostStatusResponse) => void
      }
    } = {}
  ) {
    this.credential = options.credential
    this.transport = new WebRuntimeConnectionTransport(
      connection,
      {
        now: () => this.now(),
        isDocumentVisible: () => this.isDocumentVisible()
      },
      {
        reconnect: options.reconnect,
        credential: options.credential,
        allowKeyMigration: options.allowKeyMigration,
        crewAttempt: options.crewAttempt,
        assertCurrent: options.assertCurrent,
        onStateChanged: (state) => {
          if (state === 'auth-failed') {
            this.statusOwner?.authenticationRejected()
          }
          this.statusOwner?.connectionChanged(
            state === 'connected'
              ? 'ready'
              : state === 'disconnected' || state === 'auth-failed'
                ? 'disconnected'
                : 'connecting'
          )
        }
      }
    )
    if (options.status) {
      const status = options.status
      this.statusOwner = new RuntimeHostStatusOwner({
        ...status,
        persistent: true,
        request: (signal) =>
          this.transport.call('status.get', undefined, {
            timeoutMs: 15_000,
            signal
          }) as Promise<RuntimeHostStatusResponse>,
        verified: (response) => {
          status.verified(response)
          return true
        }
      })
      this.statusOwner.connectionChanged(
        this.transport.state === 'connected' ? 'ready' : 'connecting'
      )
      this.statusOwner.activate()
    }
  }

  get connectionEpoch(): number {
    return this.transport.requestRegistry.connectionEpoch
  }

  call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; expectedConnectionEpoch?: number }
  ): Promise<RuntimeRpcResponse<unknown>> {
    return method === 'status.get' && this.statusOwner
      ? this.statusOwner.refresh(options)
      : this.transport.call(method, params, options)
  }

  subscribe(
    method: string,
    params: unknown,
    callbacks: WebRuntimeSubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeSubscriptionHandle> {
    try {
      throwIfSignalAborted(options?.signal)
      return SHARED_CONNECTION_SUBSCRIPTION_METHODS.has(method)
        ? this.subscribeFileWatch(params, callbacks, options)
        : this.subscribeDedicated(method, params, callbacks, options)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private async subscribeFileWatch(
    params: unknown,
    callbacks: WebRuntimeSubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeSubscriptionHandle> {
    return subscribeWebRuntimeFileWatch({
      params,
      callbacks,
      subscribe: (wrappedCallbacks) =>
        this.subscribeOnCurrentConnection('files.watch', params, wrappedCallbacks, options),
      call: (callMethod, callParams, callOptions) => this.call(callMethod, callParams, callOptions),
      teardownRetries: this.fileWatchTeardownRetries
    })
  }

  subscribeCrewAttempt(
    params: unknown,
    callbacks: WebRuntimeSubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeCrewSetupOutcome<WebRuntimeSubscriptionHandle>> {
    return observeCrewSubscriptionSetup((observe) => {
      throwIfSignalAborted(options?.signal)
      return this.subscribeDedicated(
        'orchestration.crewSubscribe',
        params,
        callbacks,
        options,
        observe
      )
    })
  }

  private subscribeDedicated(
    method: string,
    params: unknown,
    callbacks: WebRuntimeSubscriptionCallbacks,
    options?: SubscribeOptions,
    observeFailure?: (failure: RuntimeEnvironmentSetupFailure) => void
  ): Promise<WebRuntimeSubscriptionHandle> {
    return subscribeDedicatedWebRuntime({
      createClient: () =>
        new WebRuntimeClient(this.connection, {
          credential: this.credential,
          ...(observeFailure
            ? { reconnect: false, crewAttempt: true, assertCurrent: options?.assertCurrent }
            : {})
        }),
      children: this.childClients,
      subscribe: (client, wrapped) =>
        client.subscribeOnCurrentConnection(method, params, wrapped, options),
      getSetupFailure: (client) => client.transport.setupFailure,
      callbacks,
      options,
      observeFailure
    })
  }

  close(options: { notifySubscriptions?: boolean } = {}): void {
    this.statusOwner?.dispose()
    const shouldNotifySubscriptions = options.notifySubscriptions ?? true
    for (const child of Array.from(this.childClients)) {
      child.close({ notifySubscriptions: shouldNotifySubscriptions })
    }
    this.childClients.clear()
    this.fileWatchTeardownRetries.clear()
    this.transport.close(options)
  }

  private subscribeOnCurrentConnection(
    method: string,
    params: unknown,
    callbacks: WebRuntimeSubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeTransportSubscriptionHandle> {
    return enrollWebRuntimeSubscription({
      method,
      params,
      callbacks,
      options,
      waitForConnected: (timeout, signal) => this.waitForConnected(timeout, signal),
      nextId: () => this.nextId(),
      subscriptions: this.subscriptions,
      sendEncrypted: (message) => this.sendEncrypted(message),
      sendBinary: (bytes) => this.sendEncryptedBinary(bytes),
      deviceToken: this.connection.credential.deviceToken
    })
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

  protected get handshake(): PairedE2EEClientHandshake | null {
    return this.transport.handshake
  }

  protected set handshake(handshake: PairedE2EEClientHandshake | null) {
    this.transport.handshake = handshake
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

  private waitForConnected(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    return this.transport.waitForConnected(timeoutMs, signal)
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
