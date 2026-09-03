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
