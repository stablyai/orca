import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { WebRuntimePendingRequest } from './web-runtime-connection-frame-router'

const REQUEST_TIMEOUT_MS = 30_000

type WebRuntimeRequestRegistryOptions = {
  deviceToken: string
  nextId: () => string
  waitForConnected: (timeoutMs?: number) => Promise<void>
  sendEncrypted: (message: unknown) => boolean
}

export class WebRuntimeRequestRegistry {
  readonly pending = new Map<string, WebRuntimePendingRequest>()

  constructor(private readonly options: WebRuntimeRequestRegistryOptions) {}

  async call(
    method: string,
    params?: unknown,
    callOptions?: { timeoutMs?: number }
  ): Promise<RuntimeRpcResponse<unknown>> {
    await this.options.waitForConnected(callOptions?.timeoutMs)
    return new Promise((resolve, reject) => {
      const id = this.options.nextId()
      const timeoutMs = callOptions?.timeoutMs ?? REQUEST_TIMEOUT_MS
      const timeout = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timeout })
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
