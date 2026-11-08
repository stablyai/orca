import type WebSocket from 'ws'
import type {
  PairedE2EEClientHandshake,
  PairedE2EEReadyVerdict
} from './e2ee/paired-e2ee-client-handshake'
import { inflateCompressedFrame, type InflatedFrame } from './e2ee/paired-e2ee-compressed-frame'
import { NODE_COMPRESSED_FRAME_CODEC } from './e2ee/node/paired-e2ee-node-compressed-frame'

/** A frame as the host sealed it: text, or binary that may carry compressed text. */
export type RemoteRuntimeSealedFrame = string | Uint8Array<ArrayBufferLike>

export function readSealedFrame(
  data: WebSocket.RawData,
  isBinary: boolean
): RemoteRuntimeSealedFrame {
  if (!isBinary) {
    return data.toString()
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data
}

/** The E2EE ready is always a plain text frame. */
export function acceptSealedReady(
  handshake: PairedE2EEClientHandshake,
  frame: RemoteRuntimeSealedFrame
): PairedE2EEReadyVerdict {
  return typeof frame === 'string' ? handshake.acceptReadyText(frame) : 'invalid'
}

/** A frame's plaintext, compressed frames as what they carry; null when it fails to open or inflate. */
export function openSealedFrame(
  handshake: PairedE2EEClientHandshake,
  frame: RemoteRuntimeSealedFrame
): InflatedFrame | null {
  if (typeof frame === 'string') {
    const text = handshake.channel.openText(frame)
    return text === null ? null : { kind: 'text', text }
  }
  const bytes = handshake.channel.openBinary(frame)
  // Why v2 only: hosts compress v2 frames alone, so legacy binary keeps whatever leading byte it has.
  if (!bytes || handshake.framing !== 'v2') {
    return bytes && { kind: 'binary', bytes }
  }
  try {
    return inflateCompressedFrame(bytes, NODE_COMPRESSED_FRAME_CODEC) ?? { kind: 'binary', bytes }
  } catch {
    return null
  }
}

/** The text a frame carries; null when it fails to open or carries binary. */
export function openSealedText(
  handshake: PairedE2EEClientHandshake,
  frame: RemoteRuntimeSealedFrame
): string | null {
  const opened = openSealedFrame(handshake, frame)
  return opened?.kind === 'text' ? opened.text : null
}
