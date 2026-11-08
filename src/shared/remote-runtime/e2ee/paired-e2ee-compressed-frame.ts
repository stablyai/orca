import {
  REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
} from '../remote-runtime-memory-limits'

/**
 * A text or binary frame the host gzipped and sealed as a binary frame: a 6-byte header (kind,
 * inflated payload kind, little-endian inflated byte length) and one gzip member. Binary carries it
 * without base64's third, and the kind byte keeps it apart from terminal (0x74) and screencast frames.
 */
export const COMPRESSED_FRAMES_CLIENT_CAPABILITY = 'transport.compressed-frames.v1' as const

/** Field rollback without a release: a host stops compressing, a desktop or CLI stops asking. */
export function compressedFramesDisabled(): boolean {
  return (
    typeof process !== 'undefined' && process.env?.ORCA_DISABLE_MOBILE_COMPRESSED_FRAMES === '1'
  )
}

const COMPRESSED_FRAME_KIND = 0x7a
const HEADER_BYTES = 6
const PAYLOAD_KIND_BYTES = { text: 1, binary: 2 } as const

export type CompressedFramePayloadKind = keyof typeof PAYLOAD_KIND_BYTES

// Why: below this a gzip member's fixed overhead and the inflate call outweigh the saved bytes.
export const COMPRESSED_FRAME_MIN_BYTES = 1024

export type InflatedFrame = { kind: 'text'; text: string } | { kind: 'binary'; bytes: Uint8Array }

/** Each client platform's gzip and UTF-8 decoders. */
export type CompressedFrameCodec = {
  /** Throws on a body that is not one well-formed gzip member. */
  gunzip: (gzipped: Uint8Array, outputLimit: number) => Uint8Array
  decodeUtf8: (bytes: Uint8Array) => string
}

export function encodeCompressedFrame(args: {
  payloadKind: CompressedFramePayloadKind
  inflatedByteLength: number
  gzipped: Uint8Array
}): Uint8Array {
  const frame = new Uint8Array(HEADER_BYTES + args.gzipped.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint8(0, COMPRESSED_FRAME_KIND)
  view.setUint8(1, PAYLOAD_KIND_BYTES[args.payloadKind])
  view.setUint32(2, args.inflatedByteLength, true)
  frame.set(args.gzipped, HEADER_BYTES)
  return frame
}

/** Null for any other binary frame, so callers pass it through unchanged. */
export function readCompressedFrame(frame: Uint8Array): {
  payloadKind: CompressedFramePayloadKind
  inflatedByteLength: number
  gzipped: Uint8Array
} | null {
  if (frame.byteLength < HEADER_BYTES || frame[0] !== COMPRESSED_FRAME_KIND) {
    return null
  }
  const payloadKind =
    frame[1] === PAYLOAD_KIND_BYTES.text
      ? 'text'
      : frame[1] === PAYLOAD_KIND_BYTES.binary
        ? 'binary'
        : null
  if (!payloadKind) {
    return null
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return {
    payloadKind,
    inflatedByteLength: view.getUint32(2, true),
    gzipped: frame.subarray(HEADER_BYTES)
  }
}

/** What a compressed frame carries, or null for any other binary frame; throws on a corrupt one. */
export function inflateCompressedFrame(
  frame: Uint8Array,
  codec: CompressedFrameCodec
): InflatedFrame | null {
  const compressed = readCompressedFrame(frame)
  if (!compressed) {
    return null
  }
  const { payloadKind, inflatedByteLength, gzipped } = compressed
  // Why: the host never sends a frame above its outbound cap, so a larger claim is a corrupt frame.
  const maxBytes =
    payloadKind === 'text'
      ? REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
      : REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES
  if (inflatedByteLength > maxBytes) {
    throw new Error(`Compressed frame claims ${inflatedByteLength} bytes`)
  }
  // One byte past the claim lets a member that inflates larger fail the length check, not overrun.
  const bytes = codec.gunzip(gzipped, inflatedByteLength + 1)
  if (bytes.byteLength !== inflatedByteLength) {
    throw new Error('Compressed frame inflated to an unexpected length')
  }
  return payloadKind === 'binary'
    ? { kind: 'binary', bytes }
    : { kind: 'text', text: codec.decodeUtf8(bytes) }
}
