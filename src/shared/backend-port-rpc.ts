import { BackendRequestSchema } from './backend-service-contract'
import { RuntimeRpcEnvelopeSchema } from './runtime-rpc-envelope'

export type BackendPort = {
  postMessage(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  onClose(listener: () => void): () => void
  close(): void
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void }
const MAX_REQUESTS = 32

/** Responses retain a credit until consumed, bounding a slow document's native port queue. */
export class BackendPortRpc {
  private readonly pending = new Map<string, Pending>()
  private readonly admitted = new Map<string, boolean>()
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
    private readonly onDisconnect: () => void = () => {}
  ) {
    this.detach = [
      port.onMessage((message) => {
        void this.receive(message).catch(() => this.close())
      }),
      port.onClose(() => this.close())
    ]
  }

  call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('Orca disconnected. Try again after it reconnects.'))
    }
    if (this.pending.size >= MAX_REQUESTS) {
      return Promise.reject(
        new Error('Too many usage requests. Try again when the current requests finish.')
      )
    }
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        const request = { id, method, params }
        this.port.postMessage(request)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
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
      call.reject(new Error('Orca disconnected. Try again after it reconnects.'))
    }
    this.pending.clear()
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
    const response = RuntimeRpcEnvelopeSchema.safeParse(message)
    if (response.success && !('_keepalive' in response.data)) {
      const reply = response.data
      const call = this.pending.get(reply.id)
      if (!call) {
        return
      }
      this.pending.delete(reply.id)
      this.port.postMessage({ ack: reply.id })
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
    this.admitted.set(request.id, false)
    let reply
    try {
      reply = {
        id: request.id,
        ok: true,
        result: await this.invoke(request.method, request.params, this.lifetime.signal),
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
