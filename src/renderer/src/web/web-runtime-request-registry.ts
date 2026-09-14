import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { WebRuntimePendingRequest } from './web-runtime-connection-frame-router'

const REQUEST_TIMEOUT_MS = 30_000

type WebRuntimeRequestRegistryOptions = {
  deviceToken: string
  nextId: () => string
  waitForConnected: (timeoutMs?: number, signal?: AbortSignal) => Promise<void>
  sendEncrypted: (message: unknown) => boolean
}

export class WebRuntimeRequestRegistry {
  readonly pending = new Map<string, WebRuntimePendingRequest>()

  constructor(private readonly options: WebRuntimeRequestRegistryOptions) {}

  async call(
    method: string,
    params?: unknown,
    callOptions?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RuntimeRpcResponse<unknown>> {
    const signal = callOptions?.signal
    await this.options.waitForConnected(callOptions?.timeoutMs, signal)
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = this.options.nextId()
      const timeoutMs = callOptions?.timeoutMs ?? REQUEST_TIMEOUT_MS
      const timeout = window.setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        reject(new Error(`Request timed out: ${method}`))
      }, timeoutMs)
      const cleanup = (): void => {
        signal?.removeEventListener('abort', abort)
      }
      const abort = (): void => {
        this.pending.delete(id)
        window.clearTimeout(timeout)
        cleanup()
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        method,
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        timeout
      })
      if (
        !this.options.sendEncrypted({
          id,
          deviceToken: this.options.deviceToken,
          method,
          params
        })
      ) {
        this.pending.delete(id)
        window.clearTimeout(timeout)
        cleanup()
        reject(new Error('Remote Orca runtime is not connected.'))
      }
    })
  }

  rejectAll(reason: string | Error): void {
    const error = typeof reason === 'string' ? new Error(reason) : reason
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      window.clearTimeout(pending.timeout)
      pending.reject(error)
    }
  }
}
