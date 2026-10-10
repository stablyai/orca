import { randomUUID } from 'node:crypto'
import type WebSocket from 'ws'
import { encrypt } from './e2ee-crypto'
import type { PairingOffer } from './pairing'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { serializeRemoteRuntimeRpcRequest } from './remote-runtime-memory-limits'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'
import { isSafeTimerDelayMs, MAX_TIMER_DELAY_MS } from './timer-delay'

type PendingRemoteRuntimeSubscriptionRequest = {
  resolve: (response: RuntimeRpcResponse<unknown>) => void
  reject: (error: RemoteRuntimeClientError) => void
  timeout: ReturnType<typeof setTimeout>
}

const MAX_PENDING_SUBSCRIPTION_REQUESTS = 32

/**
 * Requests the caller sends over an existing subscription socket rather than a socket of their
 * own. Why they ride this connection: a lease's requests must share its liveness, so a dead link
 * fails them instead of leaving them to time out against a socket nobody is watching.
 */
export class RemoteRuntimeSubscriptionRequestChannel {
  private readonly pending = new Map<string, PendingRemoteRuntimeSubscriptionRequest>()

  constructor(
    private readonly options: {
      pairing: PairingOffer
      sharedKey: Uint8Array
      // The socket to write on, or null while the subscription is not ready to carry requests.
      resolveWritableSocket: () => WebSocket | null
      enqueue: (socket: WebSocket, frame: string) => boolean
      fail: (error: RemoteRuntimeClientError) => void
    }
  ) {}

  // An arrow property so callers can hand the bare function to a subscription handle.
  send = (
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<RuntimeRpcResponse<unknown>> => {
    if (!isSafeTimerDelayMs(timeoutMs)) {
      return Promise.reject(
        new RemoteRuntimeClientError(
          'invalid_argument',
          `Runtime request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms.`
        )
      )
    }
    const socket = this.options.resolveWritableSocket()
    if (!socket) {
      return Promise.reject(
        new RemoteRuntimeClientError(
          'remote_runtime_unavailable',
          'Remote runtime subscription is not writable.'
        )
      )
    }
    if (this.pending.size >= MAX_PENDING_SUBSCRIPTION_REQUESTS) {
      return Promise.reject(
        new RemoteRuntimeClientError(
          'runtime_busy',
          'Remote runtime subscription request capacity reached.'
        )
      )
    }
    const requestId = randomUUID()
    let serialized: string
    try {
      serialized = serializeRemoteRuntimeRpcRequest({
        requestId,
        deviceToken: this.options.pairing.deviceToken,
        method,
        params
      })
    } catch (error) {
      return Promise.reject(
        error instanceof RemoteRuntimeClientError
          ? error
          : new RemoteRuntimeClientError('invalid_argument', String(error))
      )
    }
    const encrypted = encrypt(serialized, this.options.sharedKey)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.options.fail(
          new RemoteRuntimeClientError(
            'runtime_timeout',
            'Timed out waiting for a remote runtime subscription request.'
          )
        )
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timeout })
      if (!this.options.enqueue(socket, encrypted)) {
        this.options.fail(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            'Remote runtime subscription request could not be queued.'
          )
        )
      }
    })
  }

  resolveResponse(response: RuntimeRpcResponse<unknown>): boolean {
    const pending = this.pending.get(response.id)
    if (!pending) {
      return false
    }
    this.pending.delete(response.id)
    clearTimeout(pending.timeout)
    pending.resolve(response)
    return true
  }

  rejectAll(error: RemoteRuntimeClientError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
