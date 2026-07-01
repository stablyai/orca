/* eslint-disable max-lines -- Why: this browser runtime client owns the E2EE
   WebSocket state machine, JSON-RPC request routing, streaming callbacks, and
   binary frame forwarding as one transport boundary. */
import type { RuntimeRpcResponse, RuntimeRpcSuccess } from '../../../shared/runtime-rpc-envelope'
import { isKeepaliveFrame } from '../../../shared/runtime-rpc-envelope'
import type { WebPairingOffer } from './web-pairing'
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

type WebRuntimeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'auth-failed'

type PendingRequest = {
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
}

type RuntimeSubscription = {
  method: string
  params: unknown
  callbacks: SubscriptionCallbacks
}

export type WebRuntimeSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export type SubscribeOptions = {
  timeoutMs?: number
  // Why: streaming subscriptions whose server-side cleanup is keyed by a
  // client-supplied token (native chat keys its fs-watcher by agent:sessionId)
  // must send an explicit unsubscribe RPC on teardown so the watcher is reaped
  // on view-toggle, not just on socket close. Returns the RPC frame to emit, or
  // null when the method needs no explicit teardown.
  buildUnsubscribe?: (params: unknown) => { method: string; params: unknown } | null
}

const REQUEST_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 10_000
const FILE_WATCH_READY_CLEANUP_TIMEOUT_MS = 5_000
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000]
const SHARED_CONNECTION_SUBSCRIPTION_METHODS = new Set(['files.watch'])
// Why: the browser WebSocket API hides protocol pings/pongs, so a half-open
// connection (mobile NAT idle timeout, server crash, wifi→cellular handoff)
// leaves readyState===OPEN with no onclose/onerror — the UI silently freezes on
// stale data and never reconnects. Poll connection liveness while the tab is
// visible: after HEARTBEAT_IDLE_MS of silence send a cheap status.get probe
// (any inbound frame proves liveness), and only if that probe stays unanswered
// for HEARTBEAT_PROBE_GRACE_MS close the socket to drive the reconnect path.
// Closing is gated on an unanswered PROBE, never on raw accumulated silence, so
// a backgrounded/frozen tab can never be mistaken for a dead socket on resume.
const HEARTBEAT_INTERVAL_MS = 10_000
const HEARTBEAT_IDLE_MS = 25_000
const HEARTBEAT_PROBE_GRACE_MS = 20_000

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
  private heartbeatTimer: number | null = null
  private lastInboundFrameAt = 0
  // Why: timestamp of an outstanding liveness probe (null = none in flight).
  // The dead-close fires only when a SENT probe goes unanswered, never on raw
  // silence, so a hidden/frozen tab resuming after a long gap re-probes first.
  private heartbeatProbeSentAt: number | null = null
  // Why: detect a suspended tick loop (backgrounded/frozen tab). If a tick lands
  // far later than scheduled, treat the gap as "no evidence", reset the clocks,
  // and re-probe instead of closing.
  private lastHeartbeatTickAt = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly subscriptions = new Map<string, RuntimeSubscription>()
  private readonly childClients = new Set<WebRuntimeClient>()
  private readonly waiters: { resolve: () => void; reject: (error: Error) => void }[] = []
  private readonly serverPublicKey: Uint8Array

  constructor(private readonly pairing: WebPairingOffer) {
    this.serverPublicKey = publicKeyFromBase64(pairing.publicKeyB64)
    this.openConnection()
  }

  async call(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<RuntimeRpcResponse<unknown>> {
    await this.waitForConnected(options?.timeoutMs)
    return new Promise((resolve, reject) => {
      const id = this.nextId()
      const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS
      const timeout = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timeout })
      if (!this.sendEncrypted({ id, deviceToken: this.pairing.deviceToken, method, params })) {
        this.pending.delete(id)
        window.clearTimeout(timeout)
        reject(new Error('Remote Orca runtime is not connected.'))
      }
    })
  }

  async subscribe(
    method: string,
    params: unknown,
    callbacks: SubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeSubscriptionHandle> {
    if (SHARED_CONNECTION_SUBSCRIPTION_METHODS.has(method)) {
      // Why: file watches are text-only and already have an explicit
      // files.unwatch RPC, so sharing the main socket avoids exhausting the
      // server's WebSocket connection cap in large browser sessions.
      return this.subscribeSharedFileWatch(params, callbacks, options)
    }
    const client = new WebRuntimeClient(this.pairing)
    this.childClients.add(client)
    const closeChild = (notifySubscriptions = false): void => {
      this.childClients.delete(client)
      client.close({ notifySubscriptions })
    }
    try {
      const wrappedCallbacks: SubscriptionCallbacks = {
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
          // Why: emit the explicit teardown RPC (e.g. nativeChat.unsubscribe)
          // on the child socket BEFORE closing it, so the server reaps the
          // fs-watcher on view-toggle instead of leaking it until socket close.
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

  private async subscribeSharedFileWatch(
    params: unknown,
    callbacks: SubscriptionCallbacks,
    options?: { timeoutMs?: number }
  ): Promise<WebRuntimeSubscriptionHandle> {
    let stopped = false
    let remoteSubscriptionId: string | null = null
    let unwatchStarted = false
    let handle: WebRuntimeSubscriptionHandle | null = null
    let readyCleanupTimer: number | null = null
    const clearReadyCleanupTimer = (): void => {
      if (readyCleanupTimer === null) {
        return
      }
      window.clearTimeout(readyCleanupTimer)
      readyCleanupTimer = null
    }
    const dropLocalSubscription = (): void => {
      clearReadyCleanupTimer()
      handle?.unsubscribe()
    }
    const schedulePreReadyCleanup = (): void => {
      if (readyCleanupTimer !== null) {
        return
      }
      // Why: if a stopped watch never reaches ready/error, no remote id exists
      // to unwatch; bound the lifetime of the local callback on this socket.
      readyCleanupTimer = window.setTimeout(() => {
        readyCleanupTimer = null
        handle?.unsubscribe()
      }, FILE_WATCH_READY_CLEANUP_TIMEOUT_MS)
    }
    const unwatchAndDropLocalSubscription = (): void => {
      if (unwatchStarted) {
        return
      }
      unwatchStarted = true
      if (!remoteSubscriptionId) {
        dropLocalSubscription()
        return
      }
      clearReadyCleanupTimer()
      // Why: shared files.watch streams stay on this socket, so stop the
      // server watcher before removing the local callback that receives ready.
      void this.call(
        'files.unwatch',
        { subscriptionId: remoteSubscriptionId },
        { timeoutMs: 5_000 }
      )
        .catch((error) => {
          console.warn('Failed to unwatch remote file subscription:', error)
        })
        .finally(() => {
          dropLocalSubscription()
        })
    }
    const wrappedCallbacks: SubscriptionCallbacks = {
      ...callbacks,
      onResponse: (response) => {
        if (isFileWatchReadyResponse(response)) {
          remoteSubscriptionId = response.result.subscriptionId
          if (stopped) {
            unwatchAndDropLocalSubscription()
            return
          }
        }
        if (!stopped) {
          callbacks.onResponse(response)
        } else if (response.ok === false) {
          dropLocalSubscription()
        }
      },
      onError: (error) => {
        if (!stopped) {
          callbacks.onError?.(error)
        }
      },
      onClose: () => {
        if (!stopped) {
          callbacks.onClose?.()
        }
      }
    }
    handle = await this.subscribeOnCurrentConnection(
      'files.watch',
      params,
      wrappedCallbacks,
      options
    )

    return {
      unsubscribe: () => {
        if (stopped) {
          return
        }
        stopped = true
        if (remoteSubscriptionId) {
          unwatchAndDropLocalSubscription()
        } else {
          schedulePreReadyCleanup()
        }
      },
      sendBinary: (bytes) => handle?.sendBinary(bytes)
    }
  }

  private async subscribeOnCurrentConnection(
    method: string,
    params: unknown,
    callbacks: SubscriptionCallbacks,
    options?: SubscribeOptions
  ): Promise<WebRuntimeSubscriptionHandle> {
    await this.waitForConnected(options?.timeoutMs)
    const id = this.nextId()
    this.subscriptions.set(id, { method, params, callbacks })
    if (!this.sendEncrypted({ id, deviceToken: this.pairing.deviceToken, method, params })) {
      this.subscriptions.delete(id)
      throw new Error('Remote Orca runtime is not connected.')
    }
    return {
      unsubscribe: () => {
        this.subscriptions.delete(id)
        // Tell the server to reap its keyed cleanup (e.g. native-chat fs-watcher)
        // before the socket goes away. Best-effort: a closed socket already reaps.
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

  close(options: { notifySubscriptions?: boolean } = {}): void {
    const shouldNotifySubscriptions = options.notifySubscriptions ?? true
    this.intentionallyClosed = true
    for (const child of Array.from(this.childClients)) {
      child.close({ notifySubscriptions: shouldNotifySubscriptions })
    }
    this.childClients.clear()
    this.clearTimers()
    this.rejectAllPending('Remote Orca runtime connection closed.')
    this.rejectAllWaiters(new Error('Remote Orca runtime connection closed.'))
    if (shouldNotifySubscriptions) {
      this.notifySubscriptionsClosed()
    } else {
      this.subscriptions.clear()
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.sharedKey = null
    this.setState('disconnected')
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
      // Why: stale socket callbacks can arrive after reconnect swaps this.ws;
      // they must not drive auth or subscription state on the replacement.
      if (this.ws !== ws) {
        return
      }
      // Why: any inbound frame (RPC reply, subscription push, keepalive, probe
      // echo) proves the socket is alive — reset the liveness watchdog and clear
      // any outstanding probe.
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
    if (this.state === 'handshaking') {
      if (raw === null || !this.sharedKey) {
        return
      }
      try {
        const control = JSON.parse(raw) as { type?: unknown }
        if (control.type === 'e2ee_ready') {
          this.sendEncrypted({ type: 'e2ee_auth', deviceToken: this.pairing.deviceToken })
          return
        }
      } catch {
        // The authenticated control frame is encrypted, so non-JSON is normal here.
      }

      const plaintext = decrypt(raw, this.sharedKey)
      if (plaintext === null) {
        return
      }
      try {
        const control = JSON.parse(plaintext) as {
          type?: unknown
          error?: { code?: string; message?: string }
        }
        if (control.type === 'e2ee_authenticated') {
          this.clearHandshakeTimer()
          this.reconnectAttempt = 0
          this.setState('connected')
        } else if (control.type === 'e2ee_error' || control.error?.code === 'unauthorized') {
          this.intentionallyClosed = true
          this.setState('auth-failed')
          this.rejectAllPending('Unauthorized. Pair this web client again.')
          this.notifySubscriptionsError('unauthorized', 'Unauthorized. Pair this web client again.')
          this.ws?.close()
        }
      } catch {
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
      for (const subscription of this.subscriptions.values()) {
        subscription.callbacks.onBinary?.(plaintext)
      }
      return
    }

    const plaintext = decrypt(raw, this.sharedKey)
    if (plaintext === null) {
      return
    }

    let response: RuntimeRpcResponse<unknown> | Record<string, unknown>
    try {
      response = JSON.parse(plaintext) as RuntimeRpcResponse<unknown> | Record<string, unknown>
    } catch {
      return
    }
    if (isKeepaliveFrame(response)) {
      return
    }
    if (!('id' in response) || typeof response.id !== 'string') {
      return
    }
    if (isRuntimeFailureResponse(response) && response.error.code === 'unauthorized') {
      this.intentionallyClosed = true
      this.setState('auth-failed')
      this.rejectAllPending('Unauthorized. Pair this web client again.')
      this.notifySubscriptionsError('unauthorized', 'Unauthorized. Pair this web client again.')
      this.ws?.close()
      return
    }

    const subscription = this.subscriptions.get(response.id)
    if (subscription && isSubscriptionResponse(response)) {
      subscription.callbacks.onResponse(response)
      if (response.ok && isEndResult(response.result)) {
        this.subscriptions.delete(response.id)
        subscription.callbacks.onClose?.()
      }
      return
    }

    const pending = this.pending.get(response.id)
    if (!pending) {
      return
    }
    this.pending.delete(response.id)
    window.clearTimeout(pending.timeout)
    pending.resolve(response as RuntimeRpcResponse<unknown>)
  }

  private sendEncrypted(message: unknown): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.sharedKey) {
      return false
    }
    ws.send(encrypt(JSON.stringify(message), this.sharedKey))
    return true
  }

  private sendEncryptedBinary(bytes: Uint8Array<ArrayBufferLike>): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.sharedKey) {
      return false
    }
    ws.send(encryptBytes(bytes, this.sharedKey))
    return true
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

  private handleSocketClosed(closedWs: WebSocket): void {
    if (this.ws !== closedWs) {
      return
    }
    this.ws = null
    this.sharedKey = null
    this.clearConnectTimer()
    this.clearHandshakeTimer()
    this.clearHeartbeatTimer()
    this.rejectAllPending('Remote Orca runtime connection interrupted.')
    this.notifySubscriptionsClosed()
    if (this.intentionallyClosed || this.state === 'auth-failed') {
      this.setState(this.state === 'auth-failed' ? 'auth-failed' : 'disconnected')
      return
    }
    this.setState('disconnected')
    this.scheduleReconnect()
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
      pending.reject(error)
    }
  }

  private rejectAllWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error)
    }
  }

  private notifySubscriptionsClosed(): void {
    const subscriptions = Array.from(this.subscriptions.values())
    this.subscriptions.clear()
    for (const subscription of subscriptions) {
      subscription.callbacks.onClose?.()
    }
  }

  private notifySubscriptionsError(code: string, message: string): void {
    const subscriptions = Array.from(this.subscriptions.values())
    this.subscriptions.clear()
    for (const subscription of subscriptions) {
      subscription.callbacks.onError?.({ code, message })
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

  // Why: overridable seams so a test can drive deterministic time + visibility
  // without faking globals across the whole crypto/transport fixture.
  protected now(): number {
    return Date.now()
  }

  protected isDocumentVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer()
    const now = this.now()
    this.lastInboundFrameAt = now
    this.lastHeartbeatTickAt = now
    this.heartbeatProbeSentAt = null
    this.heartbeatTimer = window.setInterval(() => this.runHeartbeatTick(), HEARTBEAT_INTERVAL_MS)
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      window.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.heartbeatProbeSentAt = null
  }

  private runHeartbeatTick(): void {
    const now = this.now()
    // Why: if this tick lands far later than scheduled, the loop was suspended
    // (backgrounded/frozen tab) — that gap is NOT evidence the socket died, so
    // re-baseline the liveness clocks and drop any stale probe before judging.
    const sinceLastTick = now - this.lastHeartbeatTickAt
    this.lastHeartbeatTickAt = now
    if (sinceLastTick >= HEARTBEAT_INTERVAL_MS * 2) {
      this.lastInboundFrameAt = now
      this.heartbeatProbeSentAt = null
    }
    // Why: a backgrounded tab shows no live data and the user can't see
    // staleness, so don't spend battery probing; the next visible tick re-checks.
    if (!this.isDocumentVisible()) {
      return
    }
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || this.state !== 'connected') {
      return
    }
    // Why: close ONLY when a probe we actually sent has gone unanswered past the
    // grace window — never on raw accumulated silence. This guarantees at least
    // one real round-trip attempt before declaring the socket half-open.
    if (
      this.heartbeatProbeSentAt !== null &&
      now - this.heartbeatProbeSentAt >= HEARTBEAT_PROBE_GRACE_MS
    ) {
      ws.close()
      this.handleSocketClosed(ws)
      return
    }
    if (this.heartbeatProbeSentAt === null && now - this.lastInboundFrameAt >= HEARTBEAT_IDLE_MS) {
      // Why: a fire-and-forget liveness probe. The reply (or any other frame)
      // resets lastInboundFrameAt and clears heartbeatProbeSentAt; the id is
      // intentionally unmatched in handleSocketMessage so it adds no pending
      // request or timeout. If sending fails the socket isn't OPEN — skip.
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

function isSubscriptionResponse(
  response: RuntimeRpcResponse<unknown> | Record<string, unknown>
): response is RuntimeRpcResponse<unknown> {
  if (!('ok' in response)) {
    return false
  }
  if (response.ok === false) {
    return true
  }
  if (response.ok === false) {
    return true
  }
  const success = response as RuntimeRpcResponse<unknown> & { ok: true; streaming?: true }
  return (
    success.streaming === true || isEndResult(success.result) || isScrollbackResult(success.result)
  )
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

function isFileWatchReadyResponse(
  response: RuntimeRpcResponse<unknown>
): response is RuntimeRpcSuccess<{ type: 'ready'; subscriptionId: string }> {
  if (!response.ok) {
    return false
  }
  const result = response.result
  return (
    !!result &&
    typeof result === 'object' &&
    (result as { type?: unknown }).type === 'ready' &&
    typeof (result as { subscriptionId?: unknown }).subscriptionId === 'string'
  )
}

function isEndResult(value: unknown): value is { type: 'end' } {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'end'
}

function isScrollbackResult(value: unknown): value is { type: 'scrollback' } {
  return !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'scrollback'
}

async function websocketPayloadToUint8(
  value: unknown
): Promise<Uint8Array<ArrayBufferLike> | null> {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer())
  }
  return null
}
