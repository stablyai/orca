import type { TerminalSnapshotUnavailableReason } from '../../../shared/terminal-snapshot-unavailability'
import type { TerminalStreamEndVerdict } from '../../../shared/terminal-stream-end-verdict'
import type { RemoteTerminalStreamWatchdog } from './remote-terminal-stream-watchdog'

export type RuntimeEnvironmentSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export type TerminalMultiplexEvent =
  | { type: 'ready' }
  | {
      type: 'subscribed'
      streamId: number
      streamGeneration?: string
      capabilities?: { ackOutputSourceRanges?: 1; outputPause?: 1 }
    }
  | { type: 'end'; streamId: number; verdict?: TerminalStreamEndVerdict }
  | { type: 'error'; streamId: number; message?: string }
  | {
      type: 'fit-override-changed'
      streamId: number
      mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
      cols: number
      rows: number
    }
  | {
      type: 'driver-changed'
      streamId: number
      driver: { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string }
    }
  | { type: string; streamId?: number; [key: string]: unknown }

export type RemoteRuntimeMultiplexedTerminalCallbacks = {
  onData: (data: string, meta?: { seq?: number; rawLength?: number; transformed?: boolean }) => void
  onSnapshot: (
    data: string,
    meta?: {
      pendingEscapeTailAnsi?: string
      seq?: number
      kittyKeyboardFlags?: number
      alternateScreen?: boolean
      terminalOwner?: 'shell'
      /** Grid the host serialized this image at. Absent from hosts that omit
       *  it, which must read as unknown so replay keeps the pane's own grid. */
      cols?: number
      rows?: number
    }
  ) => void
  onSubscribed?: () => void
  onOutputPauseCapability?: () => void
  onEnd?: (verdict: TerminalStreamEndVerdict) => void
  onError?: (message: string) => void
  onFitOverrideChanged?: (event: {
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
    cols: number
    rows: number
  }) => void
  onDriverChanged?: (
    driver: { kind: 'idle' } | { kind: 'desktop' } | { kind: 'mobile'; clientId: string }
  ) => void
  onWriteUnavailable?: () => void
  onTransportClose?: (event: { recoverable: boolean; retryWithBackoff?: boolean }) => void
}

export type RemoteRuntimeSnapshotImage = {
  data: string
  cols: number
  rows: number
  seq?: number
  source?: 'headless' | 'renderer'
  pendingEscapeTailAnsi?: string
  /** Effective kitty flags the HOST proved at this image's own `seq`. Absent
   *  from any host that predates the field — the pane tracker then stays
   *  unproven and commits raw text instead of guessing zero. */
  kittyKeyboardFlags?: number
  alternateScreen?: boolean
  terminalOwner?: 'shell'
}

/** Transient causes the host itself reported: a request reached it and it declined to serialize now. */
export type RemoteRuntimeSnapshotHostRetryCause =
  | 'host-pending-output-overflowed'
  | 'host-no-serializable-buffer'

/** Transient causes decided entirely client-side: no request frame ever reached the host, so it answered nothing. */
export type RemoteRuntimeSnapshotLocalRetryCause =
  | 'resync-in-flight'
  | 'stream-detached'
  | 'connection-not-ready'
  | 'request-already-in-flight'
  | 'request-frame-not-sent'

/** Transient causes: the same request may succeed later, so an absent buffer proves nothing about the pane. */
export type RemoteRuntimeSnapshotRetryCause =
  | RemoteRuntimeSnapshotHostRetryCause
  | RemoteRuntimeSnapshotLocalRetryCause

const HOST_ANSWERED_SNAPSHOT_RETRY_CAUSES = new Set<RemoteRuntimeSnapshotRetryCause>([
  'host-pending-output-overflowed',
  'host-no-serializable-buffer'
])

/** Callers budget host answers separately from local gates; only the former cost the host a request. */
export function isHostAnsweredSnapshotRetryCause(
  cause: RemoteRuntimeSnapshotRetryCause
): cause is RemoteRuntimeSnapshotHostRetryCause {
  return HOST_ANSWERED_SNAPSHOT_RETRY_CAUSES.has(cause)
}

/** Final causes: the host answered and repeating this exact request cannot produce the buffer. */
export type RemoteRuntimeSnapshotPermanentReason = 'exceeds-client-replay-limit'

export type RemoteRuntimeSnapshotAvailability =
  | { kind: 'snapshot' }
  | { kind: 'permanently-unavailable'; reason: RemoteRuntimeSnapshotPermanentReason }
  | { kind: 'retry-worthy'; cause: RemoteRuntimeSnapshotRetryCause }
  // Why: a pre-`unavailable` host sent an empty reply with no reason; the caller must fall back to its own heuristic.
  | { kind: 'unknown-legacy-host' }

/**
 * `availability` is what the reply proves; `snapshot` is the buffer image the host actually sent.
 * They are orthogonal so legacy callers can keep reading `snapshot` alone while new callers read the reason.
 */
export type RemoteRuntimeSnapshotOutcome = {
  availability: RemoteRuntimeSnapshotAvailability
  snapshot: RemoteRuntimeSnapshotImage | null
}

export type RemoteRuntimeMultiplexedTerminal = {
  streamId: number
  sendInput: (text: string) => boolean
  resize: (cols: number, rows: number) => boolean
  claimViewport: (cols: number, rows: number) => boolean
  setOutputPaused: (paused: boolean) => boolean
  serializeBuffer: (opts?: { scrollbackRows?: number }) => Promise<{
    data: string
    cols: number
    rows: number
    seq?: number
    source?: 'headless' | 'renderer'
  } | null>
  // Why: same request as serializeBuffer, but keeps the host's reason for an absent buffer instead of collapsing it to null.
  serializeBufferOutcome: (opts?: {
    scrollbackRows?: number
  }) => Promise<RemoteRuntimeSnapshotOutcome>
  close: () => void
}

export type RemoteRuntimeMultiplexedTerminalState = {
  streamId: number
  terminal: string
  callbacks: RemoteRuntimeMultiplexedTerminalCallbacks
  subscriptionRequested: boolean
  acknowledgeOutput: boolean
  acknowledgeOutputSourceRanges: boolean
  supportsOutputPause: boolean
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
  // Why: Output frames carry a UTF-16 offset high-water `seq`; a jump past the
  // expected next offset means the server dropped frames under backpressure.
  // Track it so a gap triggers a self-healing snapshot resync instead of
  // silently rendering corrupt/missing output (frame-drop resync).
  expectedSeq: number | undefined
  // Why: compare command probes when initial/live frames supplied no high-water.
  commandProbeBaselineSeq: number | undefined
  recoverySnapshotSeq: number | undefined
  resyncInFlight: boolean
  resyncPendingSend: boolean
  resyncTimer: ReturnType<typeof setTimeout> | null
  resyncAttempts: number
  capacityRejected: boolean
  watchdog: RemoteTerminalStreamWatchdog
}

export type RemoteRuntimeSnapshotInfo = {
  cols?: number
  rows?: number
  seq?: number
  source?: 'headless' | 'renderer'
  kittyKeyboardFlags?: number
  alternateScreen?: boolean
  terminalOwner?: 'shell'
  requestId?: number
  truncated?: boolean
  unavailable?: TerminalSnapshotUnavailableReason
  // Why: a mid-escape tail the emulator could not serialize; the transport
  // must write it AFTER the replay reset so the next live chunk completes it
  // instead of rendering literally (#7329).
  pendingEscapeTailAnsi?: string
}

export type RemoteRuntimeSnapshotRequest = {
  requestId: number
  resolve: (outcome: RemoteRuntimeSnapshotOutcome) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
