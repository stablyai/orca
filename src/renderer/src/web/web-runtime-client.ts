/* eslint-disable max-lines -- Why: one transport boundary — E2EE WebSocket state machine, JSON-RPC routing, streaming, binary frame forwarding. */
import type { RuntimeRpcResponse, RuntimeRpcSuccess } from '../../../shared/runtime-rpc-envelope'
import { isKeepaliveFrame } from '../../../shared/runtime-rpc-envelope'
import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'
import { MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS } from '../../../shared/e2ee-crypto'
import {
  createWsOutboundBackpressureQueue,
  type WsOutboundEnqueueResult,
  type WsOutboundBackpressureQueue
} from '../../../shared/ws-outbound-backpressure-queue'
import type { WebPairingOffer } from './web-pairing'
import { installWindowVisibilityInterval } from '../lib/window-visibility-interval'
import { withRemoteRuntimeTailscaleHint } from '../../../shared/remote-runtime-tailscale-hint'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  encryptBytes,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './web-e2ee'
import {
  createWebRuntimeOutboundMemoryBudget,
  WEB_RUNTIME_OUTBOUND_MAX_QUEUED_BYTES,
  WEB_RUNTIME_OUTBOUND_MAX_QUEUED_FRAMES,
  type WebRuntimeOutboundMemoryBudget,
  type WebRuntimeOutboundSocketMemory
} from './web-runtime-outbound-memory-budget'
import {
  stringifyWebRuntimeOutboundJson,
  WebRuntimeOutboundJsonLimitError
} from './web-runtime-outbound-json'
import {
  isWebRuntimeJsonStructureCapacityError,
  parseWebRuntimeInboundJson
} from './web-runtime-inbound-json'

type WebRuntimeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'auth-failed'

type PendingRequest = {
  cancelQueuedFrame: () => boolean
  method: string
  resolve: (response: RuntimeRpcResponse<unknown>) => void
  reject: (error: Error) => void
  timeout: number
}

type SubscriptionCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
  onTransportInterrupted?: () => void
  onTransportReplayed?: () => void
}

type RuntimeSubscription = {
  id: string
  method: string
  paramsJson: string | undefined
  paramsByteLength: number
  callbacks: SubscriptionCallbacks
  needsReplay: boolean
  releaseRetainedBytes: () => void
  cancelQueuedFrame: () => boolean
}

type PreparedSubscriptionInput = {
  paramsJson: string | undefined
  paramsByteLength: number
  retainedBytes: number
  teardownKey: string
  worktree: string
}

type WebRuntimeOutboundFrame = {
  bytes: number
  payload: string | Uint8Array<ArrayBuffer>
}

export type WebRuntimeSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export type SubscribeOptions = {
  timeoutMs?: number
  // Why: token-keyed server cleanup needs an explicit unsubscribe to be reaped on view-toggle, not just socket close.
  buildUnsubscribe?: (params: unknown) => { method: string; params: unknown } | null
}

const REQUEST_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000]
const SHARED_CONNECTION_SUBSCRIPTION_METHODS = new Set(['files.watch'])
// Why: browser WebSockets hide pings/pongs, so a half-open socket stays OPEN with no onclose/onerror — poll liveness in-app.
const HEARTBEAT_INTERVAL_MS = 10_000
const HEARTBEAT_IDLE_MS = 25_000
const HEARTBEAT_PROBE_GRACE_MS = 20_000
export const WEB_RUNTIME_MAX_CONNECTION_WAITERS = 256
export const WEB_RUNTIME_MAX_PENDING_REQUESTS = 256
export const WEB_RUNTIME_MAX_SUBSCRIPTIONS = 256
export const WEB_RUNTIME_MAX_CHILD_CLIENTS = 64
export const WEB_RUNTIME_MAX_BINARY_FRAME_BYTES = 64 * 1024 * 1024
export const WEB_RUNTIME_MAX_ENCRYPTED_TEXT_FRAME_BYTES = MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS
export const WEB_RUNTIME_MAX_OUTBOUND_JSON_BYTES = 4 * 1024 * 1024
export const WEB_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES = 1024 * 1024
export const WEB_RUNTIME_MAX_RPC_METHOD_BYTES = 8 * 1024
export const WEB_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES = 8 * 1024 * 1024

const WEB_RUNTIME_OUTBOUND_SOCKET_SOFT_CAP_BYTES = 8 * 1024 * 1024
const WEB_RUNTIME_MAX_OUTBOUND_WIRE_FRAME_BYTES = WEB_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES + 64

const WEB_RUNTIME_BUSY_MESSAGE = 'Remote Orca runtime client is busy; retry after requests finish.'
const RPC_PARAMS_MEMBER_PREFIX = ',"params":'
const cancelNothing = (): boolean => false
const releaseNothing = (): void => undefined
const REJECTED_OUTBOUND_ENQUEUE: WsOutboundEnqueueResult = {
  accepted: false,
  queued: false,
  cancel: cancelNothing
}

export class WebRuntimeClient {
  private ws: WebSocket | null = null
  private sharedKey: Uint8Array | null = null
  private state: WebRuntimeConnectionState = 'disconnected'
  private requestCounter = 0
  private reconnectAttempt = 0
  private intentionallyClosed = false
  private connectTimer: number | null = null
  private handshakeTimer: number | null = null
  private reconnectTimer: number | null = null
  private heartbeatCleanup: (() => void) | null = null
  private lastInboundFrameAt = 0
  // Timestamp of an outstanding liveness probe (null = none); dead-close fires only on an unanswered sent probe.
  private heartbeatProbeSentAt: number | null = null
  // Why: tracks last tick time to detect a suspended loop (frozen tab) so a long gap re-probes instead of closing.
  private lastHeartbeatTickAt = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly subscriptions = new Map<string, RuntimeSubscription>()
  private readonly fileWatchTeardownRetries = new Map<string, Set<() => Promise<void>>>()
  private readonly childClients = new Set<WebRuntimeClient>()
  private readonly waiters: { resolve: () => void; reject: (error: Error) => void }[] = []
  private readonly serverPublicKey: Uint8Array
  private outboundQueue: WsOutboundBackpressureQueue<WebRuntimeOutboundFrame> | null = null
  private outboundSocketMemory: WebRuntimeOutboundSocketMemory | null = null
  private activeCallAdmissions = 0
  private pendingSubscriptionAdmissions = 0

  constructor(
    private readonly pairing: WebPairingOffer,
    private readonly outboundMemoryBudget: WebRuntimeOutboundMemoryBudget = createWebRuntimeOutboundMemoryBudget()
  ) {
    this.serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
    this.openConnection()
  }

  async call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<RuntimeRpcResponse<unknown>> {
    assertRpcMethodWithinLimit(method)
    const releaseCallAdmission = this.claimCallAdmission()
    let releasePreparedBytes: (() => void) | null = null
    let serialized: string | undefined
    try {
      const id = this.nextId()
      serialized = stringifyWebRuntimeOutboundJson(
        { id, deviceToken: this.pairing.deviceToken, method, params },
        WEB_RUNTIME_MAX_OUTBOUND_JSON_BYTES
      ).serialized
      params = undefined
      releasePreparedBytes = this.outboundMemoryBudget.claimPreparedRpcBytes(
        retainedPreparedFrameBytes(serialized, method)
      )
      if (!releasePreparedBytes) {
        throw new Error(WEB_RUNTIME_BUSY_MESSAGE)
      }
      await this.waitForConnected(options?.timeoutMs)
      return await new Promise((resolve, reject) => {
        if (this.pending.size >= WEB_RUNTIME_MAX_PENDING_REQUESTS) {
          reject(new Error(WEB_RUNTIME_BUSY_MESSAGE))
          return
        }
        const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS
        const pending: PendingRequest = {
          cancelQueuedFrame: cancelNothing,
          method,
          resolve,
          reject,
          timeout: 0
        }
        const timeout = window.setTimeout(() => {
          if (this.pending.get(id) !== pending) {
            return
          }
          pending.cancelQueuedFrame()
          this.pending.delete(id)
          reject(new Error(`Request timed out: ${method}`))
        }, timeoutMs)
        pending.timeout = timeout
        this.pending.set(id, pending)
        const sent = serialized
          ? this.sendEncryptedSerialized(serialized)
          : REJECTED_OUTBOUND_ENQUEUE
        serialized = undefined
        pending.cancelQueuedFrame = sent.cancel
        releasePreparedBytes?.()
        releasePreparedBytes = null
        if (sent.accepted) {
          return
        }
        this.pending.delete(id)
        window.clearTimeout(timeout)
        reject(new Error('Remote Orca runtime could not send the request.'))
      })
    } finally {
      serialized = undefined
      releasePreparedBytes?.()
      releaseCallAdmission()
    }
  }

  async subscribe(
    method: string,
    params: unknown,
    callbacks: SubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeSubscriptionHandle> {
    assertRpcMethodWithinLimit(method)
    const sharedConnection = SHARED_CONNECTION_SUBSCRIPTION_METHODS.has(method)
    if (!sharedConnection && this.childClients.size >= WEB_RUNTIME_MAX_CHILD_CLIENTS) {
      throw new Error(WEB_RUNTIME_BUSY_MESSAGE)
    }
    const releaseAdmission = this.claimSubscriptionAdmission()
    let releaseRetainedBytes: (() => void) | null = null
    let ownershipTransferred = false
    try {
      const preparedInput = prepareSubscriptionInput(method, params)
      params = undefined
      releaseRetainedBytes = this.outboundMemoryBudget.claimSubscriptionBytes(
        preparedInput.retainedBytes
      )
      if (!releaseRetainedBytes) {
        throw new Error(WEB_RUNTIME_BUSY_MESSAGE)
      }
      if (sharedConnection) {
        // Why: sharing the main socket for file watches avoids exhausting the server's WebSocket connection cap.
        const handle = await this.subscribeSharedFileWatch(
          preparedInput,
          releaseRetainedBytes,
          callbacks,
          options
        )
        ownershipTransferred = true
        return handle
      }
      const client = new WebRuntimeClient(this.pairing, this.outboundMemoryBudget)
      this.childClients.add(client)
      const closeChild = (notifySubscriptions = false): void => {
        this.childClients.delete(client)
        client.close({ notifySubscriptions })
      }
      const wrappedCallbacks: SubscriptionCallbacks = {
        ...callbacks,
        onError: (error) => {
          closeChild()
          invokeConsumerCallback(() => callbacks.onError?.(error))
        },
        onClose: () => {
          closeChild()
          invokeConsumerCallback(() => callbacks.onClose?.())
        }
      }
      let handle: WebRuntimeSubscriptionHandle
      try {
        handle = await client.subscribePreparedOnCurrentConnection(
          method,
          preparedInput,
          releaseRetainedBytes,
          wrappedCallbacks,
          options
        )
      } catch (error) {
        closeChild()
        throw error
      }
      ownershipTransferred = true
      preparedInput.paramsJson = undefined
      preparedInput.teardownKey = ''
      return {
        unsubscribe: () => {
          // Why: emit the teardown RPC before closing the child socket so the server reaps the fs-watcher on view-toggle.
          try {
            handle.unsubscribe()
          } finally {
            closeChild()
          }
        },
        sendBinary: (bytes) => handle.sendBinary(bytes)
      }
    } finally {
      if (!ownershipTransferred) {
        releaseRetainedBytes?.()
      }
      releaseAdmission()
    }
  }

  private async subscribeSharedFileWatch(
    preparedInput: PreparedSubscriptionInput,
    releaseRetainedBytes: () => void,
    callbacks: SubscriptionCallbacks,
    options?: { timeoutMs?: number }
  ): Promise<WebRuntimeSubscriptionHandle> {
    const initialTeardownKey = preparedInput.teardownKey
    let teardownKey: string | null = initialTeardownKey
    const worktree = preparedInput.worktree
    await Promise.all(
      Array.from(this.fileWatchTeardownRetries.get(initialTeardownKey) ?? [], (retry) => retry())
    )
    let stopped = false
    let remoteSubscriptionId: string | null = null
    let transportInterrupted = false
    let pendingReplayResync = false
    let unwatchStarted = false
    let handle: WebRuntimeSubscriptionHandle | null = null
    const dropLocalSubscription = (): void => {
      handle?.unsubscribe()
    }
    let unwatchAttempt: Promise<void> | null = null
    const retryRemoteUnwatch = (): Promise<void> => {
      if (unwatchAttempt) {
        return unwatchAttempt
      }
      unwatchStarted = true
      const attempt = this.call(
        'files.unwatch',
        { subscriptionId: remoteSubscriptionId! },
        { timeoutMs: 5_000 }
      )
        .then((response) => {
          if (response.ok === false) {
            throw new Error(`${response.error.code}: ${response.error.message}`)
          }
          const key = teardownKey
          const retries = key ? this.fileWatchTeardownRetries.get(key) : undefined
          retries?.delete(retryRemoteUnwatch)
          if (retries?.size === 0) {
            this.fileWatchTeardownRetries.delete(key!)
          }
          dropLocalSubscription()
          teardownKey = null
        })
        .catch((error: unknown) => {
          console.warn('Failed to unwatch remote file subscription:', error)
          throw error
        })
        .finally(() => {
          unwatchAttempt = null
          unwatchStarted = false
        })
      unwatchAttempt = attempt
      return attempt
    }
    const unwatchAndDropLocalSubscription = (): void => {
      if (unwatchStarted) {
        return
      }
      if (!remoteSubscriptionId) {
        dropLocalSubscription()
        return
      }
      // Why: retain the callback and retry until the server acks physical teardown; a new watch joins this barrier.
      const key = teardownKey
      if (!key) {
        dropLocalSubscription()
        return
      }
      const retries = this.fileWatchTeardownRetries.get(key) ?? new Set()
      retries.add(retryRemoteUnwatch)
      this.fileWatchTeardownRetries.set(key, retries)
      void retryRemoteUnwatch().catch(() => {})
    }
    const wrappedCallbacks: SubscriptionCallbacks = {
      ...callbacks,
      onResponse: (response) => {
        transportInterrupted = false
        const nextSubscriptionId = getFileWatchSubscriptionId(response)
        if (nextSubscriptionId) {
          remoteSubscriptionId = nextSubscriptionId
          if (stopped) {
            unwatchAndDropLocalSubscription()
            return
          }
        }
        // Why: server publishes cancellation ownership before native setup; callers become ready only once the watcher is live.
        if (isFileWatchStartingResponse(response)) {
          return
        }
        if (!stopped) {
          invokeConsumerCallback(() => callbacks.onResponse(response))
          if (pendingReplayResync && nextSubscriptionId && response.ok) {
            pendingReplayResync = false
            // Why: a replayed watch only reports events after its own setup, so consumers must re-scan the reconnect gap.
            invokeConsumerCallback(() =>
              callbacks.onResponse(createFileWatchReplayOverflowResponse(response, worktree))
            )
          }
        } else if (response.ok === false) {
          dropLocalSubscription()
        }
      },
      onError: (error) => {
        if (!stopped) {
          invokeConsumerCallback(() => callbacks.onError?.(error))
        }
      },
      onClose: () => {
        if (!stopped) {
          invokeConsumerCallback(() => callbacks.onClose?.())
        }
      },
      onTransportInterrupted: () => {
        transportInterrupted = true
        remoteSubscriptionId = null
        if (!stopped) {
          return
        }
        const key = teardownKey
        const retries = key ? this.fileWatchTeardownRetries.get(key) : undefined
        retries?.delete(retryRemoteUnwatch)
        if (retries?.size === 0) {
          this.fileWatchTeardownRetries.delete(key!)
        }
        // Why: socket close physically releases the server subscription — a stopped watch must not replay on the replacement.
        dropLocalSubscription()
        teardownKey = null
      },
      onTransportReplayed: () => {
        transportInterrupted = false
        pendingReplayResync = true
      }
    }
    handle = await this.subscribePreparedOnCurrentConnection(
      'files.watch',
      preparedInput,
      releaseRetainedBytes,
      wrappedCallbacks,
      options
    )
    preparedInput.paramsJson = undefined
    preparedInput.teardownKey = ''

    return {
      unsubscribe: () => {
        if (stopped) {
          return
        }
        stopped = true
        if (remoteSubscriptionId) {
          unwatchAndDropLocalSubscription()
        } else if (transportInterrupted) {
          // Why: socket close already released the server subscription — drop its replay record, don't revive a stopped watch.
          dropLocalSubscription()
        }
        // Why: an older server may not publish its id until ready — retain the callback so a late response can still unwatch.
      },
      sendBinary: (bytes) => handle?.sendBinary(bytes)
    }
  }

  protected async subscribeOnCurrentConnection(
    method: string,
    params: unknown,
    callbacks: SubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeSubscriptionHandle> {
    assertRpcMethodWithinLimit(method)
    const releaseAdmission = this.claimSubscriptionAdmission()
    let releaseRetainedBytes: (() => void) | null = null
    let ownershipTransferred = false
    try {
      const preparedInput = prepareSubscriptionInput(method, params)
      params = undefined
      releaseRetainedBytes = this.outboundMemoryBudget.claimSubscriptionBytes(
        preparedInput.retainedBytes
      )
      if (!releaseRetainedBytes) {
        throw new Error(WEB_RUNTIME_BUSY_MESSAGE)
      }
      const handle = await this.subscribePreparedOnCurrentConnection(
        method,
        preparedInput,
        releaseRetainedBytes,
        callbacks,
        options
      )
      ownershipTransferred = true
      preparedInput.paramsJson = undefined
      preparedInput.teardownKey = ''
      return handle
    } finally {
      if (!ownershipTransferred) {
        releaseRetainedBytes?.()
      }
      releaseAdmission()
    }
  }

  private async subscribePreparedOnCurrentConnection(
    method: string,
    preparedInput: PreparedSubscriptionInput,
    releaseRetainedBytes: () => void,
    callbacks: SubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeSubscriptionHandle> {
    await this.waitForConnected(options?.timeoutMs)
    if (this.subscriptions.size >= WEB_RUNTIME_MAX_SUBSCRIPTIONS) {
      throw new Error(WEB_RUNTIME_BUSY_MESSAGE)
    }
    const id = this.nextId()
    const serialized = serializePreparedRpcFrame({
      id,
      deviceToken: this.pairing.deviceToken,
      method,
      paramsJson: preparedInput.paramsJson,
      paramsByteLength: preparedInput.paramsByteLength
    })
    const subscription: RuntimeSubscription = {
      id,
      method,
      paramsJson: preparedInput.paramsJson,
      paramsByteLength: preparedInput.paramsByteLength,
      callbacks,
      needsReplay: false,
      releaseRetainedBytes,
      cancelQueuedFrame: cancelNothing
    }
    this.subscriptions.set(id, subscription)
    const sent = this.sendEncryptedSerialized(serialized)
    subscription.cancelQueuedFrame = sent.cancel
    if (!sent.accepted) {
      this.removeSubscription(id, subscription)
      throw new Error('Remote Orca runtime could not send the subscription.')
    }
    return {
      unsubscribe: () => {
        const paramsJson = subscription.paramsJson
        if (!this.removeSubscription(subscription.id, subscription)) {
          return
        }
        // Tell the server to reap its keyed cleanup before the socket closes; best-effort (a closed socket already reaps).
        const teardown = options?.buildUnsubscribe?.(parseSerializedParams(paramsJson))
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

  close(options: { notifySubscriptions?: boolean } = {}): void {
    const shouldNotifySubscriptions = options.notifySubscriptions ?? true
    this.intentionallyClosed = true
    const children = Array.from(this.childClients)
    this.childClients.clear()
    this.fileWatchTeardownRetries.clear()
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    this.sharedKey = null
    this.disposeOutboundTransport()
    if (ws) {
      try {
        ws.close()
      } catch {
        // The client is already detached; a browser close failure must not retain transport state.
      }
    }
    this.rejectAllPending('Remote Orca runtime connection closed.')
    this.rejectAllWaiters(new Error('Remote Orca runtime connection closed.'))
    this.setState('disconnected')
    for (const child of children) {
      try {
        child.close({ notifySubscriptions: shouldNotifySubscriptions })
      } catch {
        // Continue closing sibling transports even if one child cleanup fails.
      }
    }
    if (shouldNotifySubscriptions) {
      this.notifySubscriptionsClosed()
    } else {
      this.clearSubscriptions()
    }
  }

  private openConnection(): void {
    if (this.intentionallyClosed) {
      return
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(this.pairing.endpoint)
    } catch (error) {
      this.rejectAllPending(error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }
    try {
      this.outboundSocketMemory = this.outboundMemoryBudget.registerBufferedAmount(
        () => ws.bufferedAmount
      )
    } catch {
      ws.close()
      this.scheduleReconnect()
      return
    }

    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.sharedKey = null
    this.setState('connecting')

    this.connectTimer = window.setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close()
        this.handleSocketClosed(ws)
      }
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (this.ws !== ws) {
        return
      }
      this.clearConnectTimer()
      this.setState('handshaking')
      const keyPair = generateKeyPair()
      this.sharedKey = deriveSharedKey(keyPair.secretKey, this.serverPublicKey)
      this.ensureOutboundQueue(ws)
      ws.send(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: publicKeyToBase64(keyPair.publicKey)
        })
      )
      this.handshakeTimer = window.setTimeout(() => {
        if (this.ws === ws && this.state === 'handshaking') {
          ws.close()
        }
      }, HANDSHAKE_TIMEOUT_MS)
    }

    ws.onmessage = (event) => {
      // Why: stale callbacks from a pre-reconnect socket must not drive state on the replacement this.ws.
      if (this.ws !== ws) {
        return
      }
      // Why: any inbound frame proves the socket is alive — reset the liveness watchdog and clear any outstanding probe.
      this.lastInboundFrameAt = this.now()
      this.heartbeatProbeSentAt = null
      void this.handleSocketMessage(event.data, ws)
    }

    ws.onclose = () => this.handleSocketClosed(ws)
    ws.onerror = () => {
      if (this.state === 'connecting') {
        this.rejectAllWaiters(
          new Error(
            withRemoteRuntimeTailscaleHint(
              'Could not connect to the remote Orca runtime.',
              this.pairing.endpoint
            )
          )
        )
      }
    }
  }

  private async handleSocketMessage(rawData: unknown, sourceWs?: WebSocket): Promise<void> {
    const raw = typeof rawData === 'string' ? rawData : null
    if (raw !== null && raw.length > WEB_RUNTIME_MAX_ENCRYPTED_TEXT_FRAME_BYTES) {
      const offendingSocket = sourceWs ?? this.ws
      if (offendingSocket) {
        this.failOutboundSocket(offendingSocket)
      }
      return
    }
    if (this.state === 'handshaking') {
      if (raw === null || !this.sharedKey) {
        return
      }
      try {
        const control = parseWebRuntimeInboundJson<{ type?: unknown }>(raw)
        if (control.type === 'e2ee_ready') {
          this.sendEncrypted({ type: 'e2ee_auth', deviceToken: this.pairing.deviceToken })
          return
        }
      } catch (error) {
        if (isWebRuntimeJsonStructureCapacityError(error)) {
          this.failInboundJsonCapacity(sourceWs)
          return
        }
        // The authenticated control frame is encrypted, so non-JSON is normal here.
      }

      const plaintext = decrypt(raw, this.sharedKey)
      if (plaintext === null) {
        return
      }
      try {
        const control = parseWebRuntimeInboundJson<{
          type?: unknown
          error?: { code?: string; message?: string }
        }>(plaintext)
        if (control.type === 'e2ee_authenticated') {
          this.clearHandshakeTimer()
          this.reconnectAttempt = 0
          this.setState('connected')
        } else if (control.type === 'e2ee_error' || control.error?.code === 'unauthorized') {
          this.handleAuthenticationFailure()
        }
      } catch (error) {
        if (isWebRuntimeJsonStructureCapacityError(error)) {
          this.failInboundJsonCapacity(sourceWs)
          return
        }
        // Ignore malformed handshake payloads; the server will close on timeout.
      }
      return
    }

    if (this.state !== 'connected' || !this.sharedKey) {
      return
    }

    if (raw === null) {
      const encrypted = await websocketPayloadToUint8(rawData)
      if (sourceWs && this.ws !== sourceWs) {
        return
      }
      if (!encrypted) {
        return
      }
      const plaintext = decryptBytes(encrypted, this.sharedKey)
      if (!plaintext) {
        return
      }
      for (const subscription of Array.from(this.subscriptions.values())) {
        invokeConsumerCallback(() => subscription.callbacks.onBinary?.(plaintext))
      }
      return
    }

    const plaintext = decrypt(raw, this.sharedKey)
    if (plaintext === null) {
      return
    }

    let response: RuntimeRpcResponse<unknown> | Record<string, unknown>
    try {
      response = parseWebRuntimeInboundJson<RuntimeRpcResponse<unknown> | Record<string, unknown>>(
        plaintext
      )
    } catch (error) {
      if (isWebRuntimeJsonStructureCapacityError(error)) {
        this.failInboundJsonCapacity(sourceWs)
      }
      return
    }
    if (isKeepaliveFrame(response)) {
      return
    }
    if (!('id' in response) || typeof response.id !== 'string') {
      return
    }
    if (isRuntimeFailureResponse(response) && response.error.code === 'unauthorized') {
      this.handleAuthenticationFailure()
      return
    }

    const subscription = this.subscriptions.get(response.id)
    if (subscription) {
      const subscriptionResponse = response as RuntimeRpcResponse<unknown>
      subscription.cancelQueuedFrame = cancelNothing
      const ended = subscriptionResponse.ok && isEndResult(subscriptionResponse.result)
      // Why: terminal subscriptions must release replay payloads before consumer code can throw or reconnect.
      if (subscriptionResponse.ok === false || ended) {
        this.removeSubscription(response.id, subscription)
      }
      // Why: subscription-backed unary RPCs can return ordinary success frames.
      invokeConsumerCallback(() => subscription.callbacks.onResponse(subscriptionResponse))
      if (ended) {
        invokeConsumerCallback(() => subscription.callbacks.onClose?.())
      }
      return
    }

    const pending = this.pending.get(response.id)
    if (!pending) {
      return
    }
    pending.cancelQueuedFrame()
    pending.cancelQueuedFrame = cancelNothing
    this.pending.delete(response.id)
    window.clearTimeout(pending.timeout)
    pending.resolve(response as RuntimeRpcResponse<unknown>)
  }

  private sendEncrypted(message: unknown): boolean {
    try {
      const { serialized } = stringifyWebRuntimeOutboundJson(
        message,
        WEB_RUNTIME_MAX_OUTBOUND_JSON_BYTES
      )
      return serialized !== undefined && this.sendEncryptedSerialized(serialized).accepted
    } catch {
      return false
    }
  }

  private sendEncryptedSerialized(serialized: string): WsOutboundEnqueueResult {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.sharedKey) {
      return REJECTED_OUTBOUND_ENQUEUE
    }
    const queue = this.ensureOutboundQueue(ws)
    if (!queue) {
      return REJECTED_OUTBOUND_ENQUEUE
    }
    try {
      const payload = encrypt(serialized, this.sharedKey)
      return queue.enqueueCancelable({ payload, bytes: payload.length })
    } catch {
      return REJECTED_OUTBOUND_ENQUEUE
    }
  }

  private sendEncryptedBinary(bytes: Uint8Array<ArrayBufferLike>): boolean {
    const ws = this.ws
    if (ws && bytes.byteLength > WEB_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES) {
      this.failOutboundSocket(ws)
      return false
    }
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.sharedKey) {
      return false
    }
    const queue = this.ensureOutboundQueue(ws)
    if (!queue) {
      return false
    }
    try {
      const payload = encryptBytes(bytes, this.sharedKey)
      return queue.enqueue({ payload, bytes: payload.byteLength })
    } catch {
      return false
    }
  }

  private waitForConnected(timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
    if (this.state === 'connected') {
      return Promise.resolve()
    }
    if (this.state === 'auth-failed') {
      return Promise.reject(new Error('Unauthorized. Pair this web client again.'))
    }
    if (this.intentionallyClosed) {
      return Promise.reject(new Error('Remote Orca runtime connection closed.'))
    }
    if (this.waiters.length >= WEB_RUNTIME_MAX_CONNECTION_WAITERS) {
      return Promise.reject(new Error(WEB_RUNTIME_BUSY_MESSAGE))
    }
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve)
        if (index !== -1) {
          this.waiters.splice(index, 1)
        }
        reject(
          new Error(
            withRemoteRuntimeTailscaleHint(
              'Timed out while connecting to the remote Orca runtime.',
              this.pairing.endpoint
            )
          )
        )
      }, timeoutMs)
      this.waiters.push({
        resolve: () => {
          window.clearTimeout(timeout)
          resolve()
        },
        reject: (error) => {
          window.clearTimeout(timeout)
          reject(error)
        }
      })
    })
  }

  private claimCallAdmission(): () => void {
    if (this.activeCallAdmissions >= WEB_RUNTIME_MAX_PENDING_REQUESTS) {
      throw new Error(WEB_RUNTIME_BUSY_MESSAGE)
    }
    this.activeCallAdmissions += 1
    return releaseOnce(() => {
      this.activeCallAdmissions -= 1
    })
  }

  private claimSubscriptionAdmission(): () => void {
    if (this.pendingSubscriptionAdmissions >= WEB_RUNTIME_MAX_SUBSCRIPTIONS) {
      throw new Error(WEB_RUNTIME_BUSY_MESSAGE)
    }
    this.pendingSubscriptionAdmissions += 1
    return releaseOnce(() => {
      this.pendingSubscriptionAdmissions -= 1
    })
  }

  private handleAuthenticationFailure(): void {
    this.intentionallyClosed = true
    this.clearTimers()
    this.setState('auth-failed')
    const ws = this.ws
    this.ws = null
    this.sharedKey = null
    this.disposeOutboundTransport()
    if (ws) {
      try {
        ws.close()
      } catch {
        // Authentication failure already detached the socket and released its memory claims.
      }
    }
    this.rejectAllPending('Unauthorized. Pair this web client again.')
    this.notifySubscriptionsError('unauthorized', 'Unauthorized. Pair this web client again.')
  }

  private handleSocketClosed(closedWs: WebSocket): void {
    if (this.ws !== closedWs) {
      return
    }
    this.disposeOutboundTransport()
    this.ws = null
    this.sharedKey = null
    this.clearConnectTimer()
    this.clearHandshakeTimer()
    this.clearHeartbeatTimer()
    this.rejectAllPending('Remote Orca runtime connection interrupted.')
    this.handleInterruptedSubscriptions()
    if (this.intentionallyClosed || this.state === 'auth-failed') {
      this.setState(this.state === 'auth-failed' ? 'auth-failed' : 'disconnected')
      return
    }
    this.setState('disconnected')
    this.scheduleReconnect()
  }

  private ensureOutboundQueue(
    ws: WebSocket
  ): WsOutboundBackpressureQueue<WebRuntimeOutboundFrame> | null {
    if (this.outboundQueue) {
      return this.outboundQueue
    }
    if (!this.outboundSocketMemory) {
      try {
        this.outboundSocketMemory = this.outboundMemoryBudget.registerBufferedAmount(
          () => ws.bufferedAmount
        )
      } catch {
        return null
      }
    }
    const socketMemory = this.outboundSocketMemory
    this.outboundQueue = createWsOutboundBackpressureQueue<WebRuntimeOutboundFrame>({
      send: (frame) => {
        try {
          ws.send(frame.payload)
        } catch {
          this.failOutboundSocket(ws)
        }
      },
      byteLengthOf: (frame) => frame.bytes,
      getBufferedAmount: () => ws.bufferedAmount,
      isWritable: () => this.ws === ws && ws.readyState === WebSocket.OPEN && !!this.sharedKey,
      canSend: (bytes) => socketMemory.canSend(bytes),
      claimQueuedBytes: (bytes) => this.outboundMemoryBudget.claimQueuedBytes(bytes),
      softCapBytes: WEB_RUNTIME_OUTBOUND_SOCKET_SOFT_CAP_BYTES,
      maxQueuedBytes: WEB_RUNTIME_OUTBOUND_MAX_QUEUED_BYTES,
      maxQueuedFrames: WEB_RUNTIME_OUTBOUND_MAX_QUEUED_FRAMES,
      maxFrameBytes: WEB_RUNTIME_MAX_OUTBOUND_WIRE_FRAME_BYTES,
      onOverflow: () => this.failOutboundSocket(ws)
    })
    return this.outboundQueue
  }

  private failOutboundSocket(ws: WebSocket): void {
    if (this.ws !== ws) {
      return
    }
    try {
      ws.close()
    } finally {
      this.handleSocketClosed(ws)
    }
  }

  private failInboundJsonCapacity(sourceWs?: WebSocket): void {
    const ws = sourceWs ?? this.ws
    if (ws) {
      this.failOutboundSocket(ws)
    }
  }

  private disposeOutboundTransport(): void {
    this.outboundQueue?.dispose()
    this.outboundQueue = null
    this.outboundSocketMemory?.release()
    this.outboundSocketMemory = null
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionallyClosed) {
      return
    }
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.openConnection()
    }, delay)
  }

  private setState(next: WebRuntimeConnectionState): void {
    this.state = next
    if (next === 'connected') {
      this.replayInterruptedSubscriptions()
      this.startHeartbeat()
      for (const waiter of this.waiters.splice(0)) {
        waiter.resolve()
      }
    } else if (next === 'auth-failed') {
      this.rejectAllWaiters(new Error('Unauthorized. Pair this web client again.'))
    }
  }

  private nextId(): string {
    this.requestCounter += 1
    return `web-rpc-${this.requestCounter}-${Date.now()}`
  }

  private rejectAllPending(reason: string): void {
    const error = new Error(reason)
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      window.clearTimeout(pending.timeout)
      pending.cancelQueuedFrame()
      pending.cancelQueuedFrame = cancelNothing
      pending.reject(error)
    }
  }

  private rejectAllWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error)
    }
  }

  private removeSubscription(id: string, expected?: RuntimeSubscription): boolean {
    const subscription = this.subscriptions.get(id)
    if (!subscription || (expected && subscription !== expected)) {
      return false
    }
    this.subscriptions.delete(id)
    subscription.cancelQueuedFrame?.()
    subscription.cancelQueuedFrame = cancelNothing
    subscription.paramsJson = undefined
    subscription.paramsByteLength = 0
    subscription.releaseRetainedBytes?.()
    subscription.releaseRetainedBytes = releaseNothing
    return true
  }

  private clearSubscriptions(): void {
    for (const [id, subscription] of Array.from(this.subscriptions)) {
      this.removeSubscription(id, subscription)
    }
  }

  private notifySubscriptionsClosed(): void {
    const subscriptions = Array.from(this.subscriptions.values())
    this.clearSubscriptions()
    for (const subscription of subscriptions) {
      invokeConsumerCallback(() => subscription.callbacks.onClose?.())
    }
  }

  private handleInterruptedSubscriptions(): void {
    for (const [id, subscription] of Array.from(this.subscriptions)) {
      if (!SHARED_CONNECTION_SUBSCRIPTION_METHODS.has(subscription.method)) {
        this.removeSubscription(id, subscription)
        invokeConsumerCallback(() => subscription.callbacks.onClose?.())
        continue
      }
      subscription.cancelQueuedFrame = cancelNothing
      invokeConsumerCallback(() => subscription.callbacks.onTransportInterrupted?.())
      if (this.subscriptions.get(subscription.id) === subscription) {
        subscription.needsReplay = true
      }
    }
  }

  private replayInterruptedSubscriptions(): void {
    for (const subscription of Array.from(this.subscriptions.values())) {
      if (!subscription.needsReplay) {
        continue
      }
      this.subscriptions.delete(subscription.id)
      subscription.id = this.nextId()
      subscription.needsReplay = false
      this.subscriptions.set(subscription.id, subscription)
      let sent = REJECTED_OUTBOUND_ENQUEUE
      try {
        const serialized = serializePreparedRpcFrame({
          id: subscription.id,
          deviceToken: this.pairing.deviceToken,
          method: subscription.method,
          paramsJson: subscription.paramsJson,
          paramsByteLength: subscription.paramsByteLength
        })
        sent = this.sendEncryptedSerialized(serialized)
      } catch {
        // A previously admitted subscription stays replayable if a replacement frame cannot be prepared.
      }
      subscription.cancelQueuedFrame = sent.cancel
      if (sent.accepted) {
        invokeConsumerCallback(() => subscription.callbacks.onTransportReplayed?.())
      } else {
        subscription.needsReplay = true
      }
    }
  }

  private notifySubscriptionsError(code: string, message: string): void {
    const subscriptions = Array.from(this.subscriptions.values())
    this.clearSubscriptions()
    for (const subscription of subscriptions) {
      invokeConsumerCallback(() => subscription.callbacks.onError?.({ code, message }))
    }
  }

  private clearTimers(): void {
    this.clearConnectTimer()
    this.clearHandshakeTimer()
    this.clearHeartbeatTimer()
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      window.clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      window.clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  // Why: overridable seams so tests can drive deterministic time + visibility without faking globals.
  protected now(): number {
    return Date.now()
  }

  protected isDocumentVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer()
    // Why: this runs at 'connected', right after the handshake's inbound frames — a genuine liveness
    // baseline. Only the fresh-connect moment resets lastInboundFrameAt; the visible re-arm below must not.
    const now = this.now()
    this.lastInboundFrameAt = now
    this.lastHeartbeatTickAt = now
    this.heartbeatProbeSentAt = null
    this.heartbeatCleanup = installWindowVisibilityInterval({
      run: () => this.runHeartbeatTick(),
      runOnVisible: () => this.rebaselineHeartbeat(),
      intervalMs: HEARTBEAT_INTERVAL_MS
    })
  }

  private rebaselineHeartbeat(): void {
    // Why: the interval is merely parked while hidden, so on becoming visible reset the tick clock (don't
    // let the parked gap trip the suspended-loop rebaseline) and drop a probe that was in flight when we
    // hid. But PRESERVE lastInboundFrameAt: if the socket went silent while hidden, keeping the real
    // last-heard time lets the next tick detect the staleness and probe promptly, instead of masking a
    // dead connection for another full idle window (#9883 review).
    this.lastHeartbeatTickAt = this.now()
    this.heartbeatProbeSentAt = null
  }

  private clearHeartbeatTimer(): void {
    this.heartbeatCleanup?.()
    this.heartbeatCleanup = null
    this.heartbeatProbeSentAt = null
  }

  private runHeartbeatTick(): void {
    const now = this.now()
    // Why: a much-later-than-scheduled tick means the loop was suspended (frozen tab), not a dead socket — re-baseline.
    const sinceLastTick = now - this.lastHeartbeatTickAt
    this.lastHeartbeatTickAt = now
    if (sinceLastTick >= HEARTBEAT_INTERVAL_MS * 2) {
      this.lastInboundFrameAt = now
      this.heartbeatProbeSentAt = null
    }
    // Why: don't probe while hidden — no visible staleness to detect and it wastes battery; next visible tick re-checks.
    if (!this.isDocumentVisible()) {
      return
    }
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || this.state !== 'connected') {
      return
    }
    // Why: close only when a probe we actually sent goes unanswered past grace — never on raw accumulated silence.
    if (
      this.heartbeatProbeSentAt !== null &&
      now - this.heartbeatProbeSentAt >= HEARTBEAT_PROBE_GRACE_MS
    ) {
      ws.close()
      this.handleSocketClosed(ws)
      return
    }
    if (this.heartbeatProbeSentAt === null && now - this.lastInboundFrameAt >= HEARTBEAT_IDLE_MS) {
      // Why: fire-and-forget liveness probe; its id is intentionally unmatched so it registers no pending request/timeout.
      if (
        this.sendEncrypted({
          id: `web-heartbeat-${this.nextId()}`,
          deviceToken: this.pairing.deviceToken,
          method: 'status.get'
        })
      ) {
        this.heartbeatProbeSentAt = now
      }
    }
  }
}

function assertRpcMethodWithinLimit(method: string): void {
  if (
    measureUtf8ByteLength(method, { stopAfterBytes: WEB_RUNTIME_MAX_RPC_METHOD_BYTES })
      .exceededLimit
  ) {
    throw new Error(`Remote runtime RPC method exceeds ${WEB_RUNTIME_MAX_RPC_METHOD_BYTES} bytes`)
  }
}

function prepareSubscriptionInput(method: string, params: unknown): PreparedSubscriptionInput {
  const prepared = stringifyWebRuntimeOutboundJson(params, WEB_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES)
  const canonicalParams = parseSerializedParams(prepared.serialized)
  const worktree = (canonicalParams as { worktree?: unknown } | null)?.worktree
  const normalizedWorktree = typeof worktree === 'string' ? worktree : ''
  return {
    paramsJson: prepared.serialized,
    paramsByteLength: prepared.byteLength,
    retainedBytes:
      retainedPreparedFrameBytes(prepared.serialized, method) + normalizedWorktree.length * 2,
    teardownKey: prepared.serialized ?? String(canonicalParams),
    worktree: normalizedWorktree
  }
}

function serializePreparedRpcFrame(input: {
  id: string
  deviceToken: string
  method: string
  paramsJson: string | undefined
  paramsByteLength: number
}): string {
  const header = stringifyWebRuntimeOutboundJson(
    { id: input.id, deviceToken: input.deviceToken, method: input.method },
    WEB_RUNTIME_MAX_OUTBOUND_JSON_BYTES
  )
  if (header.serialized === undefined) {
    throw new WebRuntimeOutboundJsonLimitError(WEB_RUNTIME_MAX_OUTBOUND_JSON_BYTES)
  }
  if (input.paramsJson === undefined) {
    return header.serialized
  }
  const totalBytes = header.byteLength + RPC_PARAMS_MEMBER_PREFIX.length + input.paramsByteLength
  if (totalBytes > WEB_RUNTIME_MAX_OUTBOUND_JSON_BYTES) {
    throw new WebRuntimeOutboundJsonLimitError(WEB_RUNTIME_MAX_OUTBOUND_JSON_BYTES)
  }
  return `${header.serialized.slice(0, -1)}${RPC_PARAMS_MEMBER_PREFIX}${input.paramsJson}}`
}

function parseSerializedParams(serialized: string | undefined): unknown {
  return serialized === undefined ? undefined : JSON.parse(serialized)
}

function retainedPreparedFrameBytes(serialized: string | undefined, method: string): number {
  return (serialized?.length ?? 0) * 2 + method.length * 2 + 256
}

function releaseOnce(release: () => void): () => void {
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    release()
  }
}

function invokeConsumerCallback(callback: () => void): void {
  try {
    callback()
  } catch {
    // One consumer must not block transport cleanup, replay, or sibling notifications.
  }
}

function isRuntimeFailureResponse(
  response: RuntimeRpcResponse<unknown> | Record<string, unknown>
): response is RuntimeRpcResponse<unknown> & { ok: false } {
  return (
    'ok' in response &&
    response.ok === false &&
    'error' in response &&
    !!response.error &&
    typeof response.error === 'object' &&
    'code' in response.error
  )
}

function getFileWatchSubscriptionId(response: RuntimeRpcResponse<unknown>): string | null {
  if (!response.ok) {
    return null
  }
  const result = response.result
  if (!result || typeof result !== 'object') {
    return null
  }
  const subscriptionId = (result as { subscriptionId?: unknown }).subscriptionId
  return typeof subscriptionId === 'string' ? subscriptionId : null
}

function createFileWatchReplayOverflowResponse(
  readyResponse: RuntimeRpcSuccess<unknown>,
  worktree: string
): RuntimeRpcSuccess<{
  type: 'changed'
  worktree: string
  events: { kind: 'overflow'; absolutePath: string }[]
}> {
  return {
    id: readyResponse.id,
    ok: true,
    result: {
      type: 'changed',
      worktree,
      // Why: overflow consumers re-scan the whole root and ignore the path (client lacks the server-side root here).
      events: [{ kind: 'overflow', absolutePath: '' }]
    },
    _meta: readyResponse._meta
  }
}

function isFileWatchStartingResponse(
  response: RuntimeRpcResponse<unknown>
): response is RuntimeRpcSuccess<{ type: 'starting'; subscriptionId: string }> {
  return (
    response.ok &&
    !!response.result &&
    typeof response.result === 'object' &&
    (response.result as { type?: unknown }).type === 'starting'
  )
}

function isEndResult(value: unknown): value is { type: 'end' } {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'end'
}

async function websocketPayloadToUint8(
  value: unknown
): Promise<Uint8Array<ArrayBufferLike> | null> {
  if (value instanceof Uint8Array) {
    return value.byteLength <= WEB_RUNTIME_MAX_BINARY_FRAME_BYTES ? value : null
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength <= WEB_RUNTIME_MAX_BINARY_FRAME_BYTES ? new Uint8Array(value) : null
  }
  if (value instanceof Blob) {
    if (value.size > WEB_RUNTIME_MAX_BINARY_FRAME_BYTES) {
      return null
    }
    return new Uint8Array(await value.arrayBuffer())
  }
  return null
}
