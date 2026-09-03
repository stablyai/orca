/** Metadata attached to a host process-table observation. */
export type ForegroundEvidenceObservation = {
  authorityGeneration: string
  observationEpoch: number
  /** How old the underlying process-table capture was when this record was serialized, measured on
   *  the OBSERVING host's clock so no clock skew enters it. Receivers rebase it onto their own
   *  monotonic clock by adding the time since the carrying response arrived.
   *
   *  It is an upper bound, not an estimate: the capture is TTL-shared, so a reader may be served
   *  one up to `PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS` older than its own await, and the
   *  producer stamps for that worst case. Erring old is the safe direction for every consumer —
   *  the only one that acts destructively refuses stale evidence. */
  capturedAgeMs: number
}

export type ForegroundProcessEvidence =
  | ({
      verdict: 'live'
      processName: string | null
      /** True only when the host observed every process group attached to this PTY's terminal to be
       *  the shell's own, with none of them stopped — i.e. nothing is running in the pane, in the
       *  foreground OR the background, and nothing sits suspended.
       *
       *  Deliberately not `tpgid === pgid`: a job the user backgrounded with `&` and a job the user
       *  suspended with Ctrl-Z both hand the terminal back to the shell, so a foreground-only
       *  predicate reads them as idle. This one is measured against the same set of process groups
       *  a forced stop would SIGKILL.
       *
       *  False means something IS running, named or not. Absent from a host that predates the
       *  field, which is neither: a reader deciding whether the pane is idle must require `true`
       *  and defer on anything else. */
      shellOwnsEveryTtyProcessGroup?: boolean
    } & ForegroundEvidenceObservation)
  | ({ verdict: 'unverifiable'; reason: string } & ForegroundEvidenceObservation)

/** Host-owned identity fences returned by the inspect-process RPC. */
export type HostObservation = ForegroundEvidenceObservation & {
  /** Host PTY key echoed from the request. */
  ptyId: string
  /** Incarnation of the managed PTY on the execution host. */
  ptyIncarnationId: string
}

export type PosixFence = {
  platform: 'posix'
  shellPid: number
  shellStartTime: string
  tty: string
  foregroundPgid: number
  process?: { pid: number; startTime: string }
}

export type WindowsFence = {
  platform: 'windows'
  // Why SSH-to-Windows is always unverifiable: POSIX has a real foreground primitive
  // (the controlling terminal's foreground process group, tpgid/pgid), so the host can
  // read which process is in front. Windows has no equivalent. Local Windows approximates
  // it by reading the native process table and walking descendants of the PTY root pid
  // (windows-foreground-process-rows.ts), but the relay has neither piece: it does not
  // import windows-process-table, its getForegroundProcessName is POSIX-shaped
  // (/proc, pgrep, lsof), and relay hosts run stock node-pty, so no ConPTY job/console
  // association is available. Returning a descendant name without a creation-time and
  // session fence would be a guess. Lifting this requires teaching the relay the Windows
  // process table plus a measured creation-time/session fence - a separate change.
  rootProcessId: number
  rootCreationTime: string
  sessionId: string
  process?: { pid: number; creationTime: string }
}

export type RemoteForegroundEvidence =
  | ({
      verdict: 'live'
      processName: string | null
      fence: PosixFence | WindowsFence
    } & HostObservation)
  | ({ verdict: 'unverifiable'; reason: string } & HostObservation)
  | ({ verdict: 'exited'; reason: string } & HostObservation)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256

function isHostObservation(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.authorityGeneration) &&
    Number.isSafeInteger(value.observationEpoch) &&
    Number(value.observationEpoch) >= 0 &&
    Number.isSafeInteger(value.capturedAgeMs) &&
    Number(value.capturedAgeMs) >= 0 &&
    Number(value.capturedAgeMs) <= 86_400_000 &&
    isNonEmptyString(value.ptyId) &&
    isNonEmptyString(value.ptyIncarnationId)
  )
}

function isPosixFence(value: unknown): value is PosixFence {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const input = value as Record<string, unknown>
  if (
    input.platform !== 'posix' ||
    !Number.isSafeInteger(input.shellPid) ||
    Number(input.shellPid) <= 0 ||
    !isNonEmptyString(input.shellStartTime) ||
    !isNonEmptyString(input.tty) ||
    !Number.isSafeInteger(input.foregroundPgid) ||
    Number(input.foregroundPgid) <= 0
  ) {
    return false
  }
  if (input.process === undefined) {
    return true
  }
  if (typeof input.process !== 'object' || input.process === null) {
    return false
  }
  const process = input.process as Record<string, unknown>
  return (
    Number.isSafeInteger(process.pid) &&
    Number(process.pid) > 0 &&
    isNonEmptyString(process.startTime)
  )
}

function isWindowsFence(value: unknown): value is WindowsFence {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const input = value as Record<string, unknown>
  if (
    input.platform !== 'windows' ||
    !Number.isSafeInteger(input.rootProcessId) ||
    Number(input.rootProcessId) <= 0 ||
    !isNonEmptyString(input.rootCreationTime) ||
    !isNonEmptyString(input.sessionId)
  ) {
    return false
  }
  if (input.process === undefined) {
    return true
  }
  if (typeof input.process !== 'object' || input.process === null) {
    return false
  }
  const process = input.process as Record<string, unknown>
  return (
    Number.isSafeInteger(process.pid) &&
    Number(process.pid) > 0 &&
    isNonEmptyString(process.creationTime)
  )
}

/** Runtime validator for the additive inspect-process evidence field. */
export function isRemoteForegroundEvidence(value: unknown): value is RemoteForegroundEvidence {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const input = value as Record<string, unknown>
  if (!isHostObservation(input)) {
    return false
  }
  if (input.verdict === 'live') {
    return (
      (input.processName === null || typeof input.processName === 'string') &&
      (isPosixFence(input.fence) || isWindowsFence(input.fence))
    )
  }
  return (
    (input.verdict === 'unverifiable' || input.verdict === 'exited') &&
    typeof input.reason === 'string' &&
    input.reason.length > 0 &&
    input.reason.length <= 256
  )
}

/** Alias used by provider-facing callers. */
export const isRemoteForegroundProcessEvidence = isRemoteForegroundEvidence

export function isForegroundProcessEvidence(value: unknown): value is ForegroundProcessEvidence {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const input = value as Record<string, unknown>
  if (
    typeof input.authorityGeneration !== 'string' ||
    input.authorityGeneration.length === 0 ||
    input.authorityGeneration.length > 256 ||
    typeof input.observationEpoch !== 'number' ||
    !Number.isSafeInteger(input.observationEpoch) ||
    input.observationEpoch < 0 ||
    typeof input.capturedAgeMs !== 'number' ||
    !Number.isSafeInteger(input.capturedAgeMs) ||
    input.capturedAgeMs < 0 ||
    input.capturedAgeMs > 86_400_000
  ) {
    return false
  }
  if (input.verdict === 'live') {
    if (
      input.shellOwnsEveryTtyProcessGroup !== undefined &&
      typeof input.shellOwnsEveryTtyProcessGroup !== 'boolean'
    ) {
      return false
    }
    return input.processName === null || typeof input.processName === 'string'
  }
  return (
    input.verdict === 'unverifiable' && typeof input.reason === 'string' && input.reason.length > 0
  )
}

export function cloneForegroundProcessEvidence(
  evidence: ForegroundProcessEvidence
): ForegroundProcessEvidence {
  return { ...evidence }
}
