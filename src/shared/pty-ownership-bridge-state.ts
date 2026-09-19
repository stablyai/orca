import type {
  PtyOwnershipBridgeGrant,
  PtyOwnershipBridgeOutputFrame,
  PtyOwnershipBridgePhase
} from './pty-ownership-bridge-contract'

export type { PtyOwnershipBridgeRole } from './pty-ownership-bridge-role'

export type RetainedFrame = PtyOwnershipBridgeOutputFrame & Readonly<{ bytes: number }>

export type BridgeOptions = Readonly<{
  replayBytes?: number
  inputIds?: number
  createBridgeId?: () => string
}>

export type PtyOwnershipBridgeState = {
  phase: PtyOwnershipBridgePhase
  nextOutputSeq: number
  destinationOutputEndSeq: number
  retainedReplayBytes: number
  retainedFrames: RetainedFrame[]
  stagedOutput: PtyOwnershipBridgeOutputFrame[]
  committedOutput: PtyOwnershipBridgeOutputFrame[]
  stagedOutputBytes: number
  acceptedInputIds: Map<string, string>
  replayBytes: number
  inputIds: number
}

export function createPtyOwnershipBridgeState(
  grant: PtyOwnershipBridgeGrant,
  options: BridgeOptions
): PtyOwnershipBridgeState {
  return {
    phase: 'idle',
    nextOutputSeq: 1,
    destinationOutputEndSeq: 0,
    retainedReplayBytes: 0,
    retainedFrames: [],
    stagedOutput: [],
    committedOutput: [],
    stagedOutputBytes: 0,
    acceptedInputIds: new Map(),
    replayBytes: options.replayBytes ?? grant.replayBytes,
    inputIds: options.inputIds ?? grant.inputIds
  }
}

export function retainPtyOwnershipBridgeFrame(
  state: PtyOwnershipBridgeState,
  frame: PtyOwnershipBridgeOutputFrame
): void {
  const bytes = Buffer.byteLength(frame.data, 'utf8')
  if (bytes >= state.replayBytes) {
    const suffix = trimUtf8Suffix(frame.data, state.replayBytes)
    state.retainedFrames = [
      Object.freeze({ ...frame, data: suffix.data, truncated: true, bytes: suffix.bytes })
    ]
    state.retainedReplayBytes = suffix.bytes
    return
  }
  state.retainedFrames.push(Object.freeze({ ...frame, bytes }))
  state.retainedReplayBytes += bytes
  while (state.retainedReplayBytes > state.replayBytes && state.retainedFrames.length > 0) {
    const removed = state.retainedFrames.shift()
    if (!removed) {
      break
    }
    state.retainedReplayBytes -= removed.bytes
  }
}

function trimUtf8Suffix(data: string, maxBytes: number): { data: string; bytes: number } {
  let suffix = data
  while (suffix.length > 0 && Buffer.byteLength(suffix, 'utf8') > maxBytes) {
    const first = Array.from(suffix)[0]
    if (!first) {
      break
    }
    suffix = suffix.slice(first.length)
  }
  return { data: suffix, bytes: Buffer.byteLength(suffix, 'utf8') }
}
