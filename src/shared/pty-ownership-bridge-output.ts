import {
  PTY_OWNERSHIP_BRIDGE_MAX_REPLAY_BYTES,
  type PtyOwnershipBridgeOutputFrame
} from './pty-ownership-bridge-contract'
import { PtyOwnershipBridgeError } from './pty-ownership-bridge-errors'
import type { PtyOwnershipBridgeRole } from './pty-ownership-bridge-role'
import {
  retainPtyOwnershipBridgeFrame,
  type PtyOwnershipBridgeState
} from './pty-ownership-bridge-state'

export function appendPtyOwnershipBridgeOutput(
  state: PtyOwnershipBridgeState,
  role: PtyOwnershipBridgeRole,
  data: string
): PtyOwnershipBridgeOutputFrame {
  if (role !== 'source') {
    throw new PtyOwnershipBridgeError('identity-mismatch', 'only the source can append output')
  }
  if (state.phase !== 'idle' && state.phase !== 'prepared' && state.phase !== 'aborted') {
    throw new PtyOwnershipBridgeError('invalid-phase', `cannot append output in ${state.phase}`)
  }
  if (typeof data !== 'string' || data.length === 0) {
    throw new PtyOwnershipBridgeError('output-conflict', 'PTY output must be a non-empty string')
  }
  const frame = Object.freeze({ seq: state.nextOutputSeq++, data })
  retainPtyOwnershipBridgeFrame(state, frame)
  return frame
}

export function replayPtyOwnershipBridgeOutput(
  state: PtyOwnershipBridgeState,
  role: PtyOwnershipBridgeRole,
  afterSeq: number
): readonly PtyOwnershipBridgeOutputFrame[] {
  if (role !== 'source') {
    throw new PtyOwnershipBridgeError('identity-mismatch', 'only the source can export replay')
  }
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new PtyOwnershipBridgeError('replay-unavailable', 'replay checkpoint is invalid')
  }
  const firstSeq = state.retainedFrames[0]?.seq ?? state.nextOutputSeq
  if (afterSeq < firstSeq - 1) {
    throw new PtyOwnershipBridgeError(
      'replay-unavailable',
      `replay before sequence ${firstSeq} is no longer retained`
    )
  }
  const frames = state.retainedFrames.filter((frame) => frame.seq > afterSeq)
  if (frames.some((frame) => frame.truncated)) {
    throw new PtyOwnershipBridgeError(
      'replay-unavailable',
      'replay window clipped a frame; destination must reconnect from an earlier checkpoint'
    )
  }
  return frames.map(({ bytes: _bytes, ...frame }) => Object.freeze(frame))
}

export function acceptPtyOwnershipBridgeOutput(
  state: PtyOwnershipBridgeState,
  role: PtyOwnershipBridgeRole,
  frame: PtyOwnershipBridgeOutputFrame
): void {
  if (role !== 'destination' || state.phase !== 'prepared') {
    throw new PtyOwnershipBridgeError(
      'invalid-phase',
      'destination output is only accepted while prepared'
    )
  }
  if (!Number.isSafeInteger(frame.seq) || frame.seq <= 0 || frame.data.length === 0) {
    throw new PtyOwnershipBridgeError('output-conflict', 'output frame is malformed')
  }
  if (frame.seq <= state.destinationOutputEndSeq) {
    const existing = state.stagedOutput.find((candidate) => candidate.seq === frame.seq)
    if (existing && existing.data !== frame.data) {
      throw new PtyOwnershipBridgeError('output-conflict', `output sequence ${frame.seq} changed`)
    }
    return
  }
  if (frame.seq !== state.destinationOutputEndSeq + 1) {
    throw new PtyOwnershipBridgeError(
      'output-gap',
      `expected output sequence ${state.destinationOutputEndSeq + 1}, received ${frame.seq}`
    )
  }
  const frameBytes = Buffer.byteLength(frame.data, 'utf8')
  if (state.stagedOutputBytes + frameBytes > PTY_OWNERSHIP_BRIDGE_MAX_REPLAY_BYTES) {
    throw new PtyOwnershipBridgeError(
      'output-conflict',
      'staged bridge output exceeded its bounded transfer window'
    )
  }
  state.destinationOutputEndSeq = frame.seq
  state.stagedOutput.push(Object.freeze({ ...frame }))
  state.stagedOutputBytes += frameBytes
}
