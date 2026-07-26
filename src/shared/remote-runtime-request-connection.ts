import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import { decrypt, encrypt } from './e2ee-crypto'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import {
  serializeRemoteRuntimePayload,
  serializeRemoteRuntimeRpcRequest
} from './remote-runtime-memory-limits'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  takeRemoteRuntimePreparedRequest,
  toRemoteRuntimeRequestError,
  type RemoteRuntimePendingRequest,
  type RemoteRuntimePreparedRequest
} from './remote-runtime-prepared-request-admission'
import {
  invalidRemoteRuntimeResponseError,
  parseAuthenticatedFrame,
  parseReadyFrame,
  parseRemoteRuntimeRpcFrame,
  remoteRuntimeTimeoutError,
  remoteRuntimeUnavailableError
} from './remote-runtime-request-frames'
import {
  rejectRemoteRuntimeRequestReadyWaiters,
  resolveRemoteRuntimeRequestReadyWaiters,
  waitForRemoteRuntimeRequestReady,
  type RemoteRuntimeRequestReadyWaiter
} from './remote-runtime-request-ready-waiters'
import { openRemoteRuntimeWebSocket } from './remote-runtime-request-websocket'

type ConnectionState = 'closed' | 'awaiting_ready' | 'awaiting_authenticated' | 'ready'

const IDLE_CLOSE_MS = 60_000

export class RemoteRuntimeRequestConnection {
  private state: ConnectionState = 'closed'
  private ws: WebSocket | null = null
  private sharedKey: Uint8Array | null = null
  private socketCleanup: (() => void) | null = null
  private readonly pendingRequests = new Map<string, RemoteRuntimePendingRequest<unknown>>()
  private readonly readyWaiters: RemoteRuntimeRequestReadyWaiter[] = []
  private idleCloseTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly pairing: PairingOffer) {}

  request<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<RuntimeRpcResponse<TResult>> {
    const requestId = randomUUID()
    let preparedRequest: RemoteRuntimePreparedRequest
    try {
      preparedRequest = prepareRemoteRuntimeRequest(this.pendingRequests, () =>
        serializeRemoteRuntimeRpcRequest({
          requestId,
          deviceToken: this.pairing.deviceToken,
          method,
          params
        })
      )
    } catch (error) {
      return Promise.reject(toRemoteRuntimeRequestError(error))
    }
    this.clearIdleCloseTimer()
    return new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId)
        if (!pending) {
          return
        }
        this.pendingRequests.delete(requestId)
        releaseRemoteRuntimePreparedRequest(pending)
        const error = remoteRuntimeTimeoutError()
        pending.reject(error)
        this.close(error)
      }, timeoutMs)
      this.pendingRequests.set(requestId, {
        resolve: resolve as (response: RuntimeRpcResponse<unknown>) => void,
        reject,
        timeout,
        preparedRequest
      })

      void this.ensureReady().then(
        () => this.sendRequest(requestId),
        (error) => this.rejectPendingRequest(requestId, toRemoteRuntimeRequestError(error))
      )
    })
  }

  close(error?: Error): void {
    const ws = this.ws
    const cleanup = this.socketCleanup
    this.ws = this.sharedKey = null
    this.socketCleanup = null
    this.state = 'closed'
    this.clearIdleCloseTimer()

    const closeError = error ?? remoteRuntimeUnavailableError()
    rejectRemoteRuntimeRequestReadyWaiters(this.readyWaiters, closeError)
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(requestId)
      releaseRemoteRuntimePreparedRequest(pending)
      pending.reject(closeError)
    }

    try {
      cleanup?.()
      ws?.close()
    } catch {
      // Best-effort shutdown for a cached remote control connection.
    }
  }

  private ensureReady(): Promise<void> {
    const ws = this.ws
    if (this.state === 'ready' && ws?.readyState === WebSocket.OPEN && this.sharedKey) {
      return Promise.resolve()
    }

    const promise = waitForRemoteRuntimeRequestReady(this.readyWaiters)

    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      try {
        this.open()
      } catch (error) {
        this.close(toRemoteRuntimeRequestError(error))
      }
    }

    return promise
  }

  private open(): void {
    const opened = openRemoteRuntimeWebSocket(this.pairing, {
      onClose: (ws) => {
        if (this.ws === ws) {
          this.close()
        }
      },
      onError: (ws, error) => {
        if (this.ws === ws) {
          this.close(error)
        }
      },
      onTextFrame: (ws, frame) => {
        if (this.ws === ws) {
          this.handleTextFrame(frame)
        }
      }
    })
    if (!opened.ok) {
      this.close(opened.error)
      return
    }
    this.ws = opened.socket.ws
    this.sharedKey = opened.socket.sharedKey
    this.socketCleanup = opened.socket.cleanup
    this.state = 'awaiting_ready'
  }

  private handleTextFrame(frame: string): void {
    if (this.state === 'awaiting_ready') {
      this.handleReadyFrame(frame)
      return
    }

    const sharedKey = this.sharedKey
    if (!sharedKey) {
      return
    }
    const plaintext = decrypt(frame, sharedKey)
    if (plaintext === null) {
      this.close(
        invalidRemoteRuntimeResponseError('Remote Orca runtime returned an undecryptable frame.')
      )
      return
    }

    if (this.state === 'awaiting_authenticated') {
      this.handleAuthenticatedFrame(plaintext)
      return
    }

    this.handleRpcFrame(plaintext)
  }

  private handleReadyFrame(frame: string): void {
    const error = parseReadyFrame(frame)
    if (error) {
      this.close(error)
      return
    }
    this.state = 'awaiting_authenticated'
    const sharedKey = this.sharedKey
    if (!sharedKey) {
      return
    }
    this.ws?.send(
      encrypt(
        serializeRemoteRuntimePayload({
          type: 'e2ee_auth',
          deviceToken: this.pairing.deviceToken
        }),
        sharedKey
      )
    )
  }

  private handleAuthenticatedFrame(plaintext: string): void {
    const error = parseAuthenticatedFrame(plaintext)
    if (error) {
      this.close(error)
      return
    }
    this.state = 'ready'
    resolveRemoteRuntimeRequestReadyWaiters(this.readyWaiters)
    this.scheduleIdleCloseIfUnused()
  }

  private handleRpcFrame(plaintext: string): void {
    const parsed = parseRemoteRuntimeRpcFrame(plaintext)
    if (parsed.type === 'keepalive') {
      return
    }
    if (parsed.type === 'error') {
      this.close(parsed.error)
      return
    }

    const response = parsed.response
    const pending = this.pendingRequests.get(response.id)
    if (!pending) {
      return
    }
    this.pendingRequests.delete(response.id)
    clearTimeout(pending.timeout)
    releaseRemoteRuntimePreparedRequest(pending)
    pending.resolve(response)
    this.scheduleIdleCloseIfUnused()
  }

  private sendRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId)
    const ws = this.ws
    const sharedKey = this.sharedKey
    if (!pending) {
      return
    }
    if (this.state !== 'ready' || !ws || ws.readyState !== WebSocket.OPEN || !sharedKey) {
      this.rejectPendingRequest(requestId, remoteRuntimeUnavailableError())
      return
    }
    const serializedRequest = takeRemoteRuntimePreparedRequest(pending)
    if (serializedRequest === null) {
      this.rejectPendingRequest(requestId, remoteRuntimeUnavailableError())
      return
    }
    try {
      ws.send(encrypt(serializedRequest, sharedKey))
    } catch (error) {
      this.rejectPendingRequest(requestId, toRemoteRuntimeRequestError(error))
    }
  }

  private rejectPendingRequest(requestId: string, error: Error): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) {
      return
    }
    this.pendingRequests.delete(requestId)
    clearTimeout(pending.timeout)
    releaseRemoteRuntimePreparedRequest(pending)
    pending.reject(error)
    this.scheduleIdleCloseIfUnused()
  }

  private scheduleIdleCloseIfUnused(): void {
    if (this.pendingRequests.size > 0 || this.readyWaiters.length > 0 || this.state !== 'ready') {
      return
    }
    this.clearIdleCloseTimer()
    this.idleCloseTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
    if (typeof this.idleCloseTimer.unref === 'function') {
      this.idleCloseTimer.unref()
    }
  }

  private clearIdleCloseTimer(): void {
    if (this.idleCloseTimer) {
      clearTimeout(this.idleCloseTimer)
      this.idleCloseTimer = null
    }
  }
}
