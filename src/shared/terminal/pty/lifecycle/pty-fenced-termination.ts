export type PtyFencedTerminationRequest = {
  id: string
  expectedIncarnationId: string
  requireNoAgentOwner: boolean
  requireUnattached: boolean
  switchCondition?: {
    token: string
    remainingMs: number
    ownedSpawn?: true
    claimGeneration?: string
  }
}

/** Main-local hooks for a fenced stop; never sent to the daemon. */
export type PtyFencedTerminationLocalOptions = {
  beforeRequest?: () => boolean
}

export type PtyFencedTerminationOutcome =
  /** `writersExited`: the teardown also proved every captured descendant gone (or ended the owned job tree). */
  | { outcome: 'ended'; writersExited?: true }
  | { outcome: 'already_exited' }
  | {
      outcome: 'refused'
      reason: 'replaced' | 'claimed' | 'attached' | 'unsupported' | 'unverifiable'
    }

export function isPtyFencedTerminationOutcome(
  value: unknown
): value is PtyFencedTerminationOutcome {
  if (!value || typeof value !== 'object' || !('outcome' in value)) {
    return false
  }
  if (value.outcome === 'ended' || value.outcome === 'already_exited') {
    return true
  }
  return (
    value.outcome === 'refused' &&
    'reason' in value &&
    (value.reason === 'replaced' ||
      value.reason === 'claimed' ||
      value.reason === 'attached' ||
      value.reason === 'unsupported' ||
      value.reason === 'unverifiable')
  )
}
