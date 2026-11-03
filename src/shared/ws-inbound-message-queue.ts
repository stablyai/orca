import {
  REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES,
  REMOTE_RUNTIME_MAX_PENDING_REQUESTS,
  REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES
} from './remote-runtime/remote-runtime-memory-limits'
import { getUtf8ByteLength } from './utf8-byte-limits'

type InboundMessage = { raw: unknown; release: () => void; settle: () => void }

export class WsInboundMessageBudget {
  private bytes = 0
  private frames = 0

  reserve(bytes: number): (() => void) | null {
    if (
      this.bytes + bytes > REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES ||
      this.frames >= REMOTE_RUNTIME_MAX_PENDING_REQUESTS
    ) {
      return null
    }
    this.bytes += bytes
    this.frames++
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.bytes -= bytes
      this.frames--
    }
  }
}

export class WsInboundMessageQueue {
  private readonly pending = new Set<InboundMessage>()
  private active = false
  private disposed = false

  constructor(
    private readonly processMessage: (raw: unknown) => void | Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly budget = new WsInboundMessageBudget()
  ) {}

  enqueue(raw: unknown): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    const { wireBytes, retainedBytes: bytes } = inboundMessageBytes(raw)
    const release =
      wireBytes <= REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES ? this.budget.reserve(bytes) : null
    if (!release) {
      this.dispose()
      this.onError(new Error('WebSocket inbound buffer overflow'))
      return Promise.resolve()
    }
    let settle = (): void => {}
    const completed = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.pending.add({ raw, release, settle })
    this.drain()
    return completed
  }

  private drain(): void {
    while (!this.active && !this.disposed) {
      const message = this.pending.values().next().value
      if (!message) {
        return
      }
      this.pending.delete(message)
      this.active = true
      let asynchronous = false
      try {
        const raw = message.raw
        message.raw = undefined
        const result = this.processMessage(raw)
        if (result) {
          asynchronous = true
          void Promise.resolve(result)
            .catch((error: unknown) => {
              if (!this.disposed) {
                this.onError(error)
              }
            })
            .finally(() => {
              this.complete(message)
              this.drain()
            })
          return
        }
      } catch (error) {
        if (!this.disposed) {
          this.onError(error)
        }
      } finally {
        if (!asynchronous) {
          this.complete(message)
        }
      }
    }
  }

  private complete(message: InboundMessage): void {
    message.release()
    message.settle()
    this.active = false
  }

  dispose(): void {
    this.disposed = true
    // A blocked conversion must not retain every later frame until it finishes.
    for (const message of this.pending) {
      message.raw = undefined
      message.release()
      message.settle()
    }
    this.pending.clear()
  }
}

function inboundMessageBytes(raw: unknown): { wireBytes: number; retainedBytes: number } {
  if (typeof raw === 'string') {
    const wireBytes = getUtf8ByteLength(raw)
    return { wireBytes, retainedBytes: Math.max(raw.length * 2, wireBytes) }
  }
  if (raw instanceof ArrayBuffer) {
    return { wireBytes: raw.byteLength, retainedBytes: raw.byteLength }
  }
  if (ArrayBuffer.isView(raw)) {
    return { wireBytes: raw.byteLength, retainedBytes: raw.buffer.byteLength }
  }
  if (typeof Blob !== 'undefined' && raw instanceof Blob) {
    return { wireBytes: raw.size, retainedBytes: raw.size }
  }
  return { wireBytes: Number.POSITIVE_INFINITY, retainedBytes: Number.POSITIVE_INFINITY }
}
