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

/** Why a frame could not be read; text-only sockets also refuse a binary payload. */
export type SealedFrameFailure = 'undecryptable' | 'corrupt_compressed' | 'unexpected_binary'

export const SEALED_FRAME_FAILURE_MESSAGES: Record<SealedFrameFailure, string> = {
  undecryptable: 'Remote Orca runtime returned an undecryptable frame.',
  corrupt_compressed: 'Remote Orca runtime returned a corrupt compressed frame.',
  unexpected_binary: 'Remote Orca runtime returned an unexpected binary frame.'
}

type FailedFrame = { kind: 'failed'; failure: SealedFrameFailure }

/** A frame's plaintext, compressed frames as what they carry. */
export function openSealedFrame(
  handshake: PairedE2EEClientHandshake,
  frame: RemoteRuntimeSealedFrame
): InflatedFrame | FailedFrame {
  if (typeof frame === 'string') {
    const text = handshake.channel.openText(frame)
    return text === null ? failed('undecryptable') : { kind: 'text', text }
  }
  const bytes = handshake.channel.openBinary(frame)
  if (!bytes) {
    return failed('undecryptable')
  }
  // Why v2 only: hosts compress v2 frames alone, so legacy binary keeps whatever leading byte it has.
  if (handshake.framing !== 'v2') {
    return { kind: 'binary', bytes }
  }
  try {
    return inflateCompressedFrame(bytes, NODE_COMPRESSED_FRAME_CODEC) ?? { kind: 'binary', bytes }
  } catch {
    return failed('corrupt_compressed')
  }
}

/** The text a frame carries, or why a text-only socket cannot read it. */
export function openSealedText(
  handshake: PairedE2EEClientHandshake,
  frame: RemoteRuntimeSealedFrame
): { kind: 'text'; text: string } | { kind: 'failed'; message: string } {
  const opened = openSealedFrame(handshake, frame)
  if (opened.kind === 'text') {
    return opened
  }
  const failure = opened.kind === 'binary' ? 'unexpected_binary' : opened.failure
  return { kind: 'failed', message: SEALED_FRAME_FAILURE_MESSAGES[failure] }
}

function failed(failure: SealedFrameFailure): FailedFrame {
  return { kind: 'failed', failure }
}
