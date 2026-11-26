/**
 * Binary channels: several binary streams on one connection, each as if on its own socket.
 *
 * A subscription that carries binary (terminal multiplex, screencast, download copy, tunnel) names
 * a channel number in its request. Each of its binary frames, both ways, then travels inside a
 * small header naming that channel, and the host gives the stream its own binary connection. The
 * frames inside are unchanged, so every stream's own protocol works as it does on a socket of its
 * own. Used only when the client advertises the capability and the host lists it.
 */
export const RUNTIME_BINARY_CHANNELS_CAPABILITY = 'rpc.binary-channels.v1' as const

/** The request field naming a subscription's channel; requests without it use the socket itself. */
export const RUNTIME_BINARY_CHANNEL_REQUEST_FIELD = 'binaryChannel' as const

// Clear of the leading bytes of compressed (0x7a), terminal (0x74), screencast (0x62) and download
// copy (0x64) frames.
const BINARY_CHANNEL_KIND = 0x6d
const BINARY_CHANNEL_VERSION = 1
export const BINARY_CHANNEL_HEADER_BYTES = 8
/** Channels open on one connection at once; a client releasing its channels never comes near it. */
export const MAX_OPEN_BINARY_CHANNELS = 256

export enum BinaryChannelOpcode {
  Data = 1,
  /** Client to host: the subscription ended, so the host releases the channel as on a socket close. */
  Close = 2
}

export type BinaryChannelFrame = {
  opcode: BinaryChannelOpcode
  channel: number
  payload: Uint8Array<ArrayBufferLike>
}

export function isBinaryChannelNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffffffff
}

export function encodeBinaryChannelFrame(frame: BinaryChannelFrame): Uint8Array {
  const out = new Uint8Array(BINARY_CHANNEL_HEADER_BYTES + frame.payload.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint8(0, BINARY_CHANNEL_KIND)
  view.setUint8(1, BINARY_CHANNEL_VERSION)
  view.setUint8(2, frame.opcode)
  view.setUint8(3, 0)
  view.setUint32(4, frame.channel, true)
  out.set(frame.payload, BINARY_CHANNEL_HEADER_BYTES)
  return out
}

/** Null for anything that isn't a well-formed channel frame. The payload is a view, not a copy. */
export function decodeBinaryChannelFrame(
  bytes: Uint8Array<ArrayBufferLike>
): BinaryChannelFrame | null {
  if (
    bytes.byteLength < BINARY_CHANNEL_HEADER_BYTES ||
    bytes[0] !== BINARY_CHANNEL_KIND ||
    bytes[1] !== BINARY_CHANNEL_VERSION
  ) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const opcode = view.getUint8(2)
  const channel = view.getUint32(4, true)
  if (
    (opcode !== BinaryChannelOpcode.Data && opcode !== BinaryChannelOpcode.Close) ||
    !isBinaryChannelNumber(channel)
  ) {
    return null
  }
  return { opcode, channel, payload: bytes.subarray(BINARY_CHANNEL_HEADER_BYTES) }
}
