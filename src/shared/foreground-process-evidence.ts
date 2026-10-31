/** Metadata attached to a host process-table observation. */
export type ForegroundEvidenceObservation = {
  authorityGeneration: string
  observationEpoch: number
  /** Worst-case capture age on the observing host’s clock, including TTL-shared snapshot staleness.
   * Receivers add elapsed time since response arrival on their monotonic clock. Overestimating age safely prevents destructive use of stale evidence. */
  capturedAgeMs: number
}

export type ForegroundProcessEvidence =
  | ({
      verdict: 'live'
      processName: string | null
      /** True only when all PTY terminal groups contain solely the unstopped shell AND its process group has no other member anywhere on the host.
       * Foreground-only checks miss background/suspended jobs; tty-only checks miss set +m jobs or detached children still reached by killpg.
       * Retain the shipped wire name; stricter values make old clients skip more. False means busy; absent from old hosts is unknown.
       * Destructive idle decisions must require explicit true. */
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
  // SSH Windows lacks POSIX tpgid/pgid and local Windows’s native process-table descendant walk.
  // Relay uses POSIX probes and stock node-pty, with no ConPTY association. A descendant name without creation-time/session fences is unverifiable;
  // support requires a Windows table plus measured identity fences.
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
