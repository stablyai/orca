// Wire contract for the owner-only streaming upgrade of the runtime's local Unix socket / named pipe.
// Why a length-prefixed stream after one NDJSON line: the upgrade request is an ordinary unary request,
// so an older runtime answers it with method_not_found and the client falls back without guessing.
import { z } from 'zod'

export const RUNTIME_LOCAL_STREAM_UPGRADE_METHOD = 'transport.upgrade'
export const RUNTIME_LOCAL_STREAM_PROTOCOL = 'orca-local-stream'
export const RUNTIME_LOCAL_STREAM_VERSION = 1
export const RUNTIME_LOCAL_STREAM_UNSUPPORTED_CODE = 'unsupported_transport'

export const RuntimeLocalStreamFrameKind = {
  Text: 1,
  Binary: 2
} as const
export type RuntimeLocalStreamFrameKind =
  (typeof RuntimeLocalStreamFrameKind)[keyof typeof RuntimeLocalStreamFrameKind]

export const RUNTIME_LOCAL_STREAM_HEADER_BYTES = 5
// Why: matches the WebSocket transport's inbound cap, so a local client cannot stall main with one frame.
export const RUNTIME_LOCAL_STREAM_MAX_INBOUND_FRAME_BYTES = 1024 * 1024
// Why: replies carry whole file listings and diffs locally; clients must accept frames up to this size.
export const RUNTIME_LOCAL_STREAM_MAX_OUTBOUND_FRAME_BYTES = 64 * 1024 * 1024

export const RuntimeLocalStreamUpgradeParams = z.object({
  protocol: z.string(),
  versions: z.array(z.number().int()).max(16),
  clientCapabilities: z.array(z.string()).optional()
})

export type RuntimeLocalStreamUpgradeResult = {
  protocol: typeof RUNTIME_LOCAL_STREAM_PROTOCOL
  version: typeof RUNTIME_LOCAL_STREAM_VERSION
  connectionId: string
}

export function encodeRuntimeLocalStreamFrame(
  kind: RuntimeLocalStreamFrameKind,
  payload: string | Uint8Array<ArrayBufferLike>
): Buffer {
  const bodyBytes =
    typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : payload.length
  const frame = Buffer.allocUnsafe(RUNTIME_LOCAL_STREAM_HEADER_BYTES + bodyBytes)
  frame[0] = kind
  frame.writeUInt32BE(bodyBytes, 1)
  if (typeof payload === 'string') {
    frame.write(payload, RUNTIME_LOCAL_STREAM_HEADER_BYTES, 'utf8')
  } else {
    frame.set(payload, RUNTIME_LOCAL_STREAM_HEADER_BYTES)
  }
  return frame
}

export type RuntimeLocalStreamFrameHandlers = {
  onText: (text: string) => void
  onBinary: (bytes: Buffer) => void
  onFatal: (reason: string) => void
}

export type RuntimeLocalStreamFrameReader = {
  feed(chunk: Buffer): void
}

export function createRuntimeLocalStreamFrameReader(
  handlers: RuntimeLocalStreamFrameHandlers,
  maxFrameBytes: number
): RuntimeLocalStreamFrameReader {
  let chunks: Buffer[] = []
  let bufferedBytes = 0
  let failed = false

  const contiguousHead = (bytes: number): Buffer => {
    if (chunks[0].length < bytes) {
      chunks = [Buffer.concat(chunks, bufferedBytes)]
    }
    return chunks[0]
  }

  const consume = (head: Buffer, bytes: number): void => {
    if (head.length === bytes) {
      chunks.shift()
    } else {
      chunks[0] = head.subarray(bytes)
    }
    bufferedBytes -= bytes
  }

  const fail = (reason: string): void => {
    failed = true
    chunks = []
    bufferedBytes = 0
    handlers.onFatal(reason)
  }

  return {
    feed(chunk: Buffer): void {
      if (failed || chunk.length === 0) {
        return
      }
      chunks.push(chunk)
      bufferedBytes += chunk.length
      while (!failed && bufferedBytes >= RUNTIME_LOCAL_STREAM_HEADER_BYTES) {
        let head = contiguousHead(RUNTIME_LOCAL_STREAM_HEADER_BYTES)
        const kind = head[0]
        const bodyBytes = head.readUInt32BE(1)
        if (
          kind !== RuntimeLocalStreamFrameKind.Text &&
          kind !== RuntimeLocalStreamFrameKind.Binary
        ) {
          fail('unknown_frame_kind')
          return
        }
        if (bodyBytes > maxFrameBytes) {
          fail('frame_too_large')
          return
        }
        const frameBytes = RUNTIME_LOCAL_STREAM_HEADER_BYTES + bodyBytes
        if (bufferedBytes < frameBytes) {
          return
        }
        head = contiguousHead(frameBytes)
        // Why: copy so a retained frame does not pin the whole socket read buffer.
        const body = Buffer.from(head.subarray(RUNTIME_LOCAL_STREAM_HEADER_BYTES, frameBytes))
        consume(head, frameBytes)
        if (kind === RuntimeLocalStreamFrameKind.Text) {
          handlers.onText(body.toString('utf8'))
        } else {
          handlers.onBinary(body)
        }
      }
    }
  }
}
