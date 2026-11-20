import { BackendRequestSchema } from './backend-service-contract'
import { RuntimeRpcEnvelopeSchema } from '../remote-runtime/rpc/runtime-rpc-envelope'

export type BackendPort = {
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  onClose(listener: () => void): () => void
  close(): void
}

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  settled?: true
  release?: () => void
}
/** Request credits; later stream deliveries get their own pool so they cannot starve requests. */
const MAX_REQUESTS = 32

/** Responses retain a credit until consumed, bounding a slow document's native port queue. */
export class BackendPortRpc {
  private readonly pending = new Map<string, Pending>()
  // A request holds its cancel controller while running, then `true` until its reply is acked.
  private readonly admitted = new Map<string, AbortController | true>()
  private readonly lifetime = new AbortController()
  private nextId = 1
  private closed = false
  private readonly detach: (() => void)[]

  constructor(
    private readonly port: BackendPort,
    private readonly incarnation: string,
    private readonly invoke: (
      method: string,
      params: unknown,
      signal: AbortSignal
    ) => Promise<unknown>,
    private readonly onDisconnect: () => void = () => {},
    /** A reply from any other backend incarnation means this port outlived its owner. */
    private readonly peerIncarnation?: string
  ) {
    this.detach = [
      port.onMessage((message) => {
        void this.receive(message).catch(() => this.close())
      }),
      port.onClose(() => this.close())
    ]
  }

  call(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('Orca disconnected. Try again after it reconnects.'))
    }
    if (signal?.aborted) {
      return Promise.reject(cancelled())
    }
    if (this.pending.size >= MAX_REQUESTS) {
      return Promise.reject(
        new Error('Too many usage requests. Try again when the current requests finish.')
      )
    }
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const call: Pending = { resolve, reject }
      this.pending.set(id, call)
      try {
        const request = { id, method, params }
        this.port.postMessage(request)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (!signal) {
        return
      }
      const abort = (): void => {
        if (this.pending.get(id) !== call || call.settled) {
          return
        }
        // The credit stays held until the peer's reply arrives and is acknowledged.
        call.settled = true
        reject(cancelled())
        try {
          this.port.postMessage({ cancel: id })
        } catch {
          this.close()
        }
      }
      // A long-lived signal must not retain every finished call.
      call.release = () => signal.removeEventListener('abort', abort)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.lifetime.abort()
    for (const detach of this.detach) {
      detach()
    }
    this.port.close()
    for (const call of this.pending.values()) {
      call.release?.()
      call.reject(new Error('Orca disconnected. Try again after it reconnects.'))
    }
    this.pending.clear()
    for (const state of this.admitted.values()) {
      if (state !== true) {
        state.abort()
      }
    }
    this.admitted.clear()
    this.onDisconnect()
  }

  private async receive(message: unknown): Promise<void> {
    if (this.closed) {
      return
    }
    if (
      message &&
      typeof message === 'object' &&
      'ack' in message &&
      typeof message.ack === 'string'
    ) {
      if (this.admitted.get(message.ack) !== true) {
        this.close()
        return
      }
      this.admitted.delete(message.ack)
      return
    }
    if (
      message &&
      typeof message === 'object' &&
      'cancel' in message &&
      typeof message.cancel === 'string'
    ) {
      const running = this.admitted.get(message.cancel)
      if (running !== true) {
        running?.abort()
      }
      return
    }
    const response = RuntimeRpcEnvelopeSchema.safeParse(message)
    if (response.success && !('_keepalive' in response.data)) {
      const reply = response.data
      const call = this.pending.get(reply.id)
      if (!call) {
        return
      }
      if (this.peerIncarnation !== undefined && reply._meta?.runtimeId !== this.peerIncarnation) {
        this.close()
        return
      }
      this.pending.delete(reply.id)
      call.release?.()
      this.port.postMessage({ ack: reply.id })
      if (call.settled) {
        return
      }
      if (reply.ok) {
        call.resolve(reply.result)
      } else {
        call.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }))
      }
      return
    }
    const parsed = BackendRequestSchema.safeParse(message)
    if (
      !parsed.success ||
      this.admitted.size >= MAX_REQUESTS ||
      this.admitted.has(parsed.data.id)
    ) {
      this.close()
      return
    }
    const request = parsed.data
    const cancel = new AbortController()
    this.admitted.set(request.id, cancel)
    let reply
    try {
      reply = {
        id: request.id,
        ok: true,
        result: await this.invoke(
          request.method,
          request.params,
          AbortSignal.any([this.lifetime.signal, cancel.signal])
        ),
        _meta: { runtimeId: this.incarnation }
      }
    } catch (error) {
      reply = {
        id: request.id,
        ok: false,
        error: {
          code: 'runtime_error',
          message: error instanceof Error ? error.message : 'Usage operation failed. Try again.'
        },
        _meta: { runtimeId: this.incarnation }
      }
    }
    if (!this.closed) {
      try {
        this.admitted.set(request.id, true)
        this.port.postMessage(reply)
      } catch {
        this.close()
      }
    }
  }
}

function cancelled(): Error {
  return Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' })
}
