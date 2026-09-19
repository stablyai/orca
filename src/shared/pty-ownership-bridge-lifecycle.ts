import type {
  PtyOwnershipBridgeOutputFrame,
  PtyOwnershipBridgeSnapshot
} from './pty-ownership-bridge-contract'
import { PtyOwnershipBridgeError } from './pty-ownership-bridge-errors'
import type { PtyOwnershipBridgeRole } from './pty-ownership-bridge-role'
import type { PtyOwnershipBridgeState } from './pty-ownership-bridge-state'

export function commitPtyOwnershipBridge(
  state: PtyOwnershipBridgeState,
  role: PtyOwnershipBridgeRole
): readonly PtyOwnershipBridgeOutputFrame[] {
  if (role !== 'destination') {
    throw new PtyOwnershipBridgeError('identity-mismatch', 'only the destination can commit')
  }
  if (state.phase === 'committed') {
    return state.committedOutput.map((frame) => Object.freeze({ ...frame }))
  }
  if (state.phase !== 'prepared') {
    throw new PtyOwnershipBridgeError('invalid-phase', 'only the prepared destination can commit')
  }
  if (state.destinationOutputEndSeq !== state.nextOutputSeq - 1) {
    throw new PtyOwnershipBridgeError(
      'destination-not-caught-up',
      `destination ends at ${state.destinationOutputEndSeq}, source ends at ${state.nextOutputSeq - 1}`
    )
  }
  state.phase = 'committed'
  const output = state.stagedOutput.map((frame) => Object.freeze({ ...frame }))
  state.committedOutput = output
  state.stagedOutput = []
  state.stagedOutputBytes = 0
  return output
}

export function abortPtyOwnershipBridge(
  state: PtyOwnershipBridgeState,
  role: PtyOwnershipBridgeRole
): void {
  if (role !== 'source' && role !== 'destination') {
    throw new PtyOwnershipBridgeError('identity-mismatch', 'unknown bridge role')
  }
  if (state.phase === 'aborted') {
    return
  }
  if (state.phase !== 'prepared') {
    throw new PtyOwnershipBridgeError('invalid-phase', `cannot abort from ${state.phase}`)
  }
  state.phase = 'aborted'
  state.stagedOutput = []
  state.stagedOutputBytes = 0
  state.destinationOutputEndSeq = 0
}

export function snapshotPtyOwnershipBridge(
  state: PtyOwnershipBridgeState,
  terminalId: string,
  incarnationId: string,
  ownerLease: string
): PtyOwnershipBridgeSnapshot {
  return Object.freeze({
    phase: state.phase,
    terminalId,
    incarnationId,
    ownerLease,
    sourceOutputEndSeq: state.nextOutputSeq - 1,
    destinationOutputEndSeq: state.destinationOutputEndSeq,
    stagedOutputFrames: state.stagedOutput.length,
    retainedReplayBytes: state.retainedReplayBytes,
    acceptedInputIds: state.acceptedInputIds.size
  })
}
