type InboundMessage = { raw: unknown }

export class WsInboundMessageQueue {
  private readonly pending = new Set<InboundMessage>()
  private tail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(
    private readonly processMessage: (raw: unknown) => void | Promise<void>,
    private readonly onError: (error: unknown) => void
  ) {}

  enqueue(raw: unknown): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    const message = { raw }
    this.pending.add(message)
    this.tail = this.tail
      .then(() => {
        this.pending.delete(message)
        if (this.disposed) {
          return
        }
        const raw = message.raw
        message.raw = undefined
        return this.processMessage(raw)
      })
      .catch((error: unknown) => {
        if (!this.disposed) {
          this.onError(error)
        }
      })
    return this.tail
  }

  dispose(): void {
    this.disposed = true
    // A blocked conversion must not retain every later frame until it finishes.
    for (const message of this.pending) {
      message.raw = undefined
    }
    this.pending.clear()
  }
}
