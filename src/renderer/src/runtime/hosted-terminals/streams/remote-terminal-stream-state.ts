import type { RemoteTerminalStreamWatchdog } from './recovery/remote-terminal-stream-watchdog'
import type { RemoteRuntimeMultiplexedTerminalCallbacks } from './remote-terminal-stream-contracts'
import type {
  RemoteRuntimeSnapshotInfo,
  RemoteRuntimeSnapshotRequest
} from '../snapshots/remote-terminal-snapshot-contracts'

export type RemoteRuntimeMultiplexedTerminalState = {
  streamId: number
  terminal: string
  callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  subscriptionRequested: boolean
  acknowledgeOutput: boolean
  acknowledgeOutputSourceRanges: boolean
  supportsOutputPause: boolean
  supportsPausedOutputDropNotice: boolean
  // Why: the host announced the seq jump the pane's own restore covers, so it must not also trigger a resync.
  pausedOutputGapExpected: boolean
  supportsInputAck: boolean
  inputLedgerId: string | null
  outputPaused: boolean
  streamGeneration: string | null
  sourceAckedEndByte: number
  heldAckBytes: number
  pendingAckBytes: number
  ackFlushTimer: ReturnType<typeof setTimeout> | null
  snapshotChunks: Uint8Array<ArrayBufferLike>[]
  snapshotBytes: number
  snapshotOverflowed: boolean
  snapshotTarget: 'initial' | 'request' | 'recovery'
  snapshotInfo: RemoteRuntimeSnapshotInfo | null
  initialSnapshotReceived: boolean
  pendingSnapshotRequest: RemoteRuntimeSnapshotRequest | null
  // Output seq is the UTF-16 high-water; offset gaps expose backpressure drops and trigger snapshot recovery instead of corrupt paint.
  expectedSeq: number | undefined
  // Why: compare command probes when initial/live frames supplied no high-water.
  commandProbeBaselineSeq: number | undefined
  recoverySnapshotSeq: number | undefined
  resyncInFlight: boolean
  resyncPendingSend: boolean
  resyncTimer: ReturnType<typeof setTimeout> | null
  resyncAttempts: number
  /** Consecutive resync timeouts with no recovery frame at all. */
  resyncUnansweredTimeouts: number
  capacityRejected: boolean
  watchdog: RemoteTerminalStreamWatchdog
}
