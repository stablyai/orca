import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import type { PairingOffer } from './pairing'
import { decrypt, encrypt } from './e2ee-crypto'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import { RemoteRuntimeClientError } from './remote-runtime-client'
import {
  invalidRemoteRuntimeResponseError,
  parseAuthenticatedFrame,
  parseReadyFrame,
  parseRemoteRuntimeRpcFrame,
  remoteRuntimeTimeoutError,
  remoteRuntimeUnavailableError
} from './remote-runtime-request-frames'
import { openRemoteRuntimeWebSocket } from './remote-runtime-request-websocket'

type ConnectionState = 'closed' | 'awaiting_ready' | 'awaiting_authenticated' | 'ready'

type PendingRequest<TResult> = {
  resolve: (response: RuntimeRpcResponse<TResult>) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type ReadyWaiter = {
  resolve: () => void
  reject: (error: Error) => void
}

const IDLE_CLOSE_MS = 60_000

export class RemoteRuntimeRequestConnection {
  private readonly pairing: PairingOffer
  private state: ConnectionState = 'closed'
  private ws: WebSocket | null = null
  private sharedKey: Uint8Array | null = null
  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>()
  private readonly readyWaiters: ReadyWaiter[] = []
  private idleCloseTimer: ReturnType<typeof setTimeout> | null = null

  constructor(pairing: PairingOffer) {
    this.pairing = pairing
  }

  request<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<RuntimeRpcResponse<TResult>> {
    this.clearIdleCloseTimer()
    const requestId = randomUUID()
    return new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId)
        if (!pending) {
          return
        }
        this.pendingRequests.delete(requestId)
        const error = remoteRuntimeTimeoutError()
        pending.reject(error)
        this.close(error)
      }, timeoutMs)
      this.pendingRequests.set(requestId, {
        resolve: resolve as (response: RuntimeRpcResponse<unknown>) => void,
        reject,
        timeout
      })

      void this.ensureReady().then(
        () => this.sendRequest(requestId, method, params),
        (error) => this.rejectPendingRequest(requestId, toClientError(error))
      )
    })
  }

  close(error?: Error): void {
    const ws = this.ws
    this.ws = null
    this.sharedKey = null
    this.state = 'closed'
    this.clearIdleCloseTimer()

    const closeError = error ?? remoteRuntimeUnavailableError()
    this.rejectReadyWaiters(closeError)
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(requestId)
      pending.reject(closeError)
    }

    try {
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

    const promise = new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject })
    })

    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this.open()
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
        JSON.stringify({ type: 'e2ee_auth', deviceToken: this.pairing.deviceToken }),
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
    this.resolveReadyWaiters()
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
    pending.resolve(response)
    this.scheduleIdleCloseIfUnused()
  }

  private sendRequest(requestId: string, method: string, params: unknown): void {
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
    ws.send(
      encrypt(
        JSON.stringify({
          id: requestId,
          deviceToken: this.pairing.deviceToken,
          method,
          params
        }),
        sharedKey
      )
    )
  }

  private rejectPendingRequest(requestId: string, error: Error): void {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) {
      return
    }
    this.pendingRequests.delete(requestId)
    clearTimeout(pending.timeout)
    pending.reject(error)
    this.scheduleIdleCloseIfUnused()
  }

  private resolveReadyWaiters(): void {
    const waiters = this.readyWaiters.splice(0)
    for (const waiter of waiters) {
      waiter.resolve()
    }
  }

  private rejectReadyWaiters(error: Error): void {
    const waiters = this.readyWaiters.splice(0)
    for (const waiter of waiters) {
      waiter.reject(error)
    }
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

function toClientError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  return new RemoteRuntimeClientError('runtime_error', String(error))
}
