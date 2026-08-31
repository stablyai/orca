const LENGTH_BYTES = 4
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 + 16
const DEFAULT_MAX_RETAINED_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_QUEUED_BYTES = 1024 * 1024
const DEFAULT_MAX_QUEUED_FRAMES = 512

export function encodeBrowserNetworkTunnelStreamFrame(frame: Uint8Array): Uint8Array {
  if (frame.byteLength === 0 || frame.byteLength > DEFAULT_MAX_FRAME_BYTES) {
    throw new Error('browser_tunnel_stream_frame_invalid')
  }
  const encoded = new Uint8Array(LENGTH_BYTES + frame.byteLength)
  new DataView(encoded.buffer).setUint32(0, frame.byteLength, false)
  encoded.set(frame, LENGTH_BYTES)
  return encoded
}

export class BrowserNetworkTunnelStreamFrameDecoder {
  private retained = new Uint8Array()
  private closed = false

  constructor(
    private readonly onFrame: (frame: Uint8Array) => void,
    private readonly onError: (error: Error) => void,
    private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    private readonly maxRetainedBytes = DEFAULT_MAX_RETAINED_BYTES
  ) {}

  feed(chunk: Uint8Array): void {
    if (this.closed || chunk.byteLength === 0) {
      return
    }
    if (this.retained.byteLength + chunk.byteLength > this.maxRetainedBytes) {
      this.fail(new Error('browser_tunnel_stream_buffer_overflow'))
      return
    }
    const combined = new Uint8Array(this.retained.byteLength + chunk.byteLength)
    combined.set(this.retained)
    combined.set(chunk, this.retained.byteLength)
    let offset = 0
    while (combined.byteLength - offset >= LENGTH_BYTES) {
      const length = new DataView(
        combined.buffer,
        combined.byteOffset + offset,
        LENGTH_BYTES
      ).getUint32(0, false)
      if (length === 0 || length > this.maxFrameBytes) {
        this.fail(new Error('browser_tunnel_stream_frame_invalid'))
        return
      }
      const end = offset + LENGTH_BYTES + length
      if (end > combined.byteLength) {
        break
      }
      try {
        this.onFrame(combined.slice(offset + LENGTH_BYTES, end))
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (this.closed) {
        return
      }
      offset = end
    }
    this.retained = combined.slice(offset)
  }

  close(): void {
    this.closed = true
    this.retained = new Uint8Array()
  }

  private fail(error: Error): void {
    if (this.closed) {
      return
    }
    this.close()
    this.onError(error)
  }
}

type StreamWrite = (bytes: Uint8Array, callback: (error?: Error | null) => void) => void

type StreamFrameWriterOptions = {
  maxQueuedBytes?: number
  maxQueuedFrames?: number
}

export class BrowserNetworkTunnelStreamFrameWriter {
  private readonly frames: Uint8Array[] = []
  private readonly maxQueuedBytes: number
  private readonly maxQueuedFrames: number
  private retainedBytes = 0
  private writing = false
  private closed = false

  constructor(
    private readonly write: StreamWrite,
    private readonly onError: (error: Error) => void,
    options: StreamFrameWriterOptions = {}
  ) {
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
    this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES
  }

  get queuedBytes(): number {
    return this.retainedBytes
  }

  send(frame: Uint8Array): boolean {
    if (this.closed) {
      return false
    }
    let encoded: Uint8Array
    try {
      encoded = encodeBrowserNetworkTunnelStreamFrame(frame)
    } catch {
      return false
    }
    if (
      this.retainedBytes + encoded.byteLength > this.maxQueuedBytes ||
      this.frames.length + (this.writing ? 1 : 0) >= this.maxQueuedFrames
    ) {
      return false
    }
    this.frames.push(encoded)
    this.retainedBytes += encoded.byteLength
    this.pump()
    return true
  }

  close(): void {
    this.closed = true
    this.writing = false
    this.frames.length = 0
    this.retainedBytes = 0
  }

  private pump(): void {
    if (this.closed || this.writing) {
      return
    }
    const frame = this.frames.shift()
    if (!frame) {
      return
    }
    this.writing = true
    const settled = (error?: Error | null): void => {
      if (!this.writing) {
        return
      }
      this.writing = false
      this.retainedBytes -= frame.byteLength
      if (error) {
        this.fail(error)
        return
      }
      this.pump()
    }
    try {
      this.write(frame, settled)
    } catch (error) {
      settled(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private fail(error: Error): void {
    if (this.closed) {
      return
    }
    this.close()
    this.onError(error)
  }
}
