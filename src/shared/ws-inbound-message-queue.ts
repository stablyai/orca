import {
  REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES,
  REMOTE_RUNTIME_MAX_PENDING_REQUESTS,
  REMOTE_RUNTIME_MAX_WEBSOCKET_FRAME_BYTES
} from './remote-runtime/remote-runtime-memory-limits'
import { getUtf8ByteLength } from './utf8-byte-limits'

type InboundMessage = { raw: unknown; release: () => void }

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
  private tail: Promise<void> = Promise.resolve()
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
    const message = { raw, release }
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
      .finally(release)
    return this.tail
  }

  dispose(): void {
    this.disposed = true
    // A blocked conversion must not retain every later frame until it finishes.
    for (const message of this.pending) {
      message.raw = undefined
      message.release()
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
