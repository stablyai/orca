import type { TerminalSnapshotUnavailableReason } from '../../../../../shared/terminal/replay/terminal-snapshot-unavailability'

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
  lastTitle?: string
  /** `data` starts on the normal buffer and enters alt itself. */
  carriesNormalBuffer?: boolean
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

export type RemoteRuntimeSnapshotInfo = {
  cols?: number
  rows?: number
  seq?: number
  source?: 'headless' | 'renderer'
  kittyKeyboardFlags?: number
  alternateScreen?: boolean
  terminalOwner?: 'shell'
  lastTitle?: string
  requestId?: number
  truncated?: boolean
  unavailable?: TerminalSnapshotUnavailableReason
  /** History rows above the screen; absent from hosts that predate the field. */
  scrollbackRows?: number
  // Replay reset precedes the unserializable mid-escape tail so live output completes it instead of printing it literally (#7329).
  pendingEscapeTailAnsi?: string
}

export type RemoteRuntimeSnapshotRequestOptions = {
  scrollbackRows?: number
  /** Client-only: the pane repaints from this image, so live output resumes after its seq. */
  repaintsPane?: boolean
}

export type RemoteRuntimeSnapshotRequest = {
  requestId: number
  repaintsPane?: boolean
  resolve: (outcome: RemoteRuntimeSnapshotOutcome) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
