import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { abortSignalReason } from '../../abort-signal-reason'
import type { PairedRuntimeConnection } from '../../paired-runtime-connection'
import { scheduleOrphanedRemoteRuntimeSocketClose } from '../remote-runtime-abort-orphaned-socket'
import { serializeRemoteRuntimeRpcRequest } from '../remote-runtime-memory-limits'
import type { PairedE2EEClientHandshake } from '../../paired-e2ee-client-handshake'
import {
  prepareRemoteRuntimeRequest,
  releaseRemoteRuntimePreparedRequest,
  takeRemoteRuntimePreparedRequestAtHandoff,
  toRemoteRuntimeRequestError,
  type RemoteRuntimePendingRequest,
  type RemoteRuntimePreparedRequest
} from './remote-runtime-prepared-request-admission'
import {
  invalidRemoteRuntimeResponseError,
  remoteRuntimeAuthReplyError,
  remoteRuntimeReadyError,
  remoteRuntimeTimeoutError,
  remoteRuntimeUnavailableError
} from './remote-runtime-request-frames'
import { settleRemoteRuntimeRequestRpcFrame } from './remote-runtime-request-rpc-frame'
import type { RuntimeRpcResponse } from '../../runtime-rpc-envelope'
import {
  rejectRemoteRuntimeRequestReadyWaiters,
  resolveRemoteRuntimeRequestReadyWaiters,
  waitForRemoteRuntimeRequestReady,
  type RemoteRuntimeRequestReadyWaiter
} from './remote-runtime-request-ready-waiters'
import { openRemoteRuntimeWebSocket } from './remote-runtime-request-websocket'
import { sendRemoteRuntimeTokenAuth } from '../remote-runtime-client-handshake'
import { remoteRuntimeClientCapabilities } from '../remote-runtime-client-capabilities'
import type { RuntimeCapability } from '../../protocol-version'
import {
  remoteRuntimeRequestDispatchCutoff,
  remoteRuntimeRequestDispatchObserver
} from './remote-runtime-request-dispatch-observation'
import { RemoteRuntimeRequestIdleClose } from './remote-runtime-request-idle-close'
type ConnectionState = 'closed' | 'awaiting_ready' | 'awaiting_authenticated' | 'ready'

export class RemoteRuntimeRequestConnection {
  private state: ConnectionState = 'closed'
  private ws: WebSocket | null = null
  private handshake: PairedE2EEClientHandshake | null = null
  private socketCleanup: (() => void) | null = null
  private readonly pendingRequests = new Map<string, RemoteRuntimePendingRequest<unknown>>()
  private readonly readyWaiters: RemoteRuntimeRequestReadyWaiter[] = []
  private readonly idleClose = new RemoteRuntimeRequestIdleClose(() => this.close())

  constructor(
    private readonly connection: PairedRuntimeConnection,
    private readonly additionalClientCapabilities: readonly RuntimeCapability[] = []
  ) {}

  isReady(): boolean {
    return this.state === 'ready' && this.ws?.readyState === WebSocket.OPEN && !!this.handshake
  }

  request<TResult>(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RuntimeRpcResponse<TResult>> {
    if (signal?.aborted) {
      return Promise.reject(abortSignalReason(signal))
    }
    const requestId = randomUUID()
    const serialize = (selected: unknown): string =>
      serializeRemoteRuntimeRpcRequest({
        requestId,
        deviceToken: this.connection.credential.deviceToken,
        method,
        params: selected
      })
    let preparedRequest: RemoteRuntimePreparedRequest
    try {
      preparedRequest = prepareRemoteRuntimeRequest(this.pendingRequests, () => serialize(params))
    } catch (error) {
      return Promise.reject(toRemoteRuntimeRequestError(error))
    }
    this.idleClose.clear()
    return new Promise<RuntimeRpcResponse<TResult>>((resolve, reject) => {
      const onAbort = (): void => {
        const error = abortSignalReason(signal!)
        this.rejectPendingRequest(requestId, error)
        scheduleOrphanedRemoteRuntimeSocketClose(
          () =>
            this.pendingRequests.size === 0 &&
            this.readyWaiters.length === 0 &&
            this.state !== 'ready',
          () => this.close(error)
        )
      }
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
        resolve: (response) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(response as RuntimeRpcResponse<TResult>)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timeout,
        preparedRequest,
        onFrameSent: remoteRuntimeRequestDispatchObserver(params),
        assertInTime: remoteRuntimeRequestDispatchCutoff(params)
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }

      void this.ensureReady(signal).then(
        () => this.sendRequest(requestId, params, serialize),
        (error) => this.rejectPendingRequest(requestId, toRemoteRuntimeRequestError(error))
      )
    })
  }

  close(error?: Error): void {
    const ws = this.ws
    const cleanup = this.socketCleanup
    this.ws = this.handshake = null
    this.socketCleanup = null
    this.state = 'closed'
    this.idleClose.clear()

    const closeError = error ?? remoteRuntimeUnavailableError()
    rejectRemoteRuntimeRequestReadyWaiters(this.readyWaiters, closeError)
    for (const requestId of this.pendingRequests.keys()) {
      this.rejectPendingRequest(requestId, closeError)
    }

    try {
      cleanup?.()
      ws?.close()
    } catch {
      // Best-effort shutdown for a cached remote control connection.
    }
  }

  private ensureReady(signal?: AbortSignal): Promise<void> {
    const ws = this.ws
    if (this.isReady()) {
      return Promise.resolve()
    }

    const promise = waitForRemoteRuntimeRequestReady(this.readyWaiters, signal)

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
    const opened = openRemoteRuntimeWebSocket(this.connection, {
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
    this.handshake = opened.socket.handshake
    this.socketCleanup = opened.socket.cleanup
    this.state = 'awaiting_ready'
  }

  private handleTextFrame(frame: string): void {
    if (this.state === 'awaiting_ready') {
      this.handleReadyFrame(frame)
      return
    }

    const handshake = this.handshake
    if (!handshake) {
      return
    }
    const plaintext = handshake.channel.openText(frame)
    if (plaintext === null) {
      this.close(
        invalidRemoteRuntimeResponseError('Remote Orca runtime returned an undecryptable frame.')
      )
      return
    }

    if (this.state === 'awaiting_authenticated') {
      this.handleAuthenticatedFrame(handshake, plaintext)
      return
    }

    this.handleRpcFrame(plaintext)
  }

  private handleReadyFrame(frame: string): void {
    const handshake = this.handshake
    if (!handshake) {
      return
    }
    const error = remoteRuntimeReadyError(handshake.acceptReadyText(frame))
    if (error) {
      this.close(error)
      return
    }
    this.state = 'awaiting_authenticated'
    void sendRemoteRuntimeTokenAuth({
      handshake,
      deviceToken: this.connection.credential.deviceToken,
      clientCapabilities: remoteRuntimeClientCapabilities(this.additionalClientCapabilities),
      stillAwaiting: () => this.handshake === handshake && this.state === 'awaiting_authenticated',
      send: (authFrame) => this.ws?.send(authFrame),
      fail: (error) => {
        if (this.handshake === handshake) {
          this.close(toRemoteRuntimeRequestError(error))
        }
      }
    })
  }

  private handleAuthenticatedFrame(handshake: PairedE2EEClientHandshake, plaintext: string): void {
    const error = remoteRuntimeAuthReplyError(handshake.classifyAuthReply(plaintext))
    if (error) {
      this.close(error)
      return
    }
    this.state = 'ready'
    resolveRemoteRuntimeRequestReadyWaiters(this.readyWaiters)
    this.scheduleIdleCloseIfUnused()
  }

  private handleRpcFrame(plaintext: string): void {
    const result = settleRemoteRuntimeRequestRpcFrame({
      plaintext,
      pendingRequests: this.pendingRequests
    })
    if (result.error) {
      this.close(result.error)
      return
    }
    if (result.resolved) {
      this.scheduleIdleCloseIfUnused()
    }
  }

  private sendRequest(requestId: string, sent: unknown, toBytes: (p: unknown) => string): void {
    const pending = this.pendingRequests.get(requestId)
    const ws = this.ws
    const handshake = this.handshake
    if (!pending) {
      return
    }
    if (this.state !== 'ready' || !ws || ws.readyState !== WebSocket.OPEN || !handshake) {
      this.rejectPendingRequest(requestId, remoteRuntimeUnavailableError())
      return
    }
    try {
      // Its bytes are chosen now, after readiness: the early ones cannot carry its budget.
      const serializedRequest = takeRemoteRuntimePreparedRequestAtHandoff(pending, sent, toBytes)
      if (serializedRequest === null) {
        this.rejectPendingRequest(requestId, remoteRuntimeUnavailableError())
        return
      }
      const frame = handshake.channel.sealText(serializedRequest)
      pending.assertInTime?.()
      // Handed to the socket from here: an error past this point leaves it possibly sent.
      pending.onFrameSent?.()
      ws.send(frame)
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
    this.idleClose.schedule()
  }
}
