export type LspPortLike = Pick<MessagePort, 'postMessage' | 'addEventListener' | 'start' | 'close'>

type Pending = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export class LspPortClient {
  private nextId = 1
  private closed = false
  private readonly pending = new Map<number, Pending>()

  constructor(
    private readonly port: LspPortLike,
    private readonly timeoutMs = 15_000
  ) {
    port.addEventListener('message', (event) => this.onMessage(event.data))
    port.addEventListener('close', () => this.markClosed())
    port.start()
  }

  get isClosed(): boolean {
    return this.closed
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('LSP session closed'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP ${method} timed out`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.port.postMessage({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) {
      this.port.postMessage({ jsonrpc: '2.0', method, params })
    }
  }

  close(): void {
    this.port.close()
    this.markClosed()
  }

  private onMessage(data: unknown): void {
    if (!isRecord(data) || typeof data.id !== 'number') {
      return
    }
    const pending = this.pending.get(data.id)
    if (!pending) {
      return
    }
    this.pending.delete(data.id)
    clearTimeout(pending.timer)
    if (isRecord(data.error)) {
      pending.reject(new Error(String(data.error.message)))
    } else {
      pending.resolve(data.result)
    }
  }

  private markClosed(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('LSP session closed'))
    }
    this.pending.clear()
  }
}
