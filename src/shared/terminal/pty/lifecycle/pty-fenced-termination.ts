export type PtyFencedTerminationRequest = {
  id: string
  expectedIncarnationId: string
  requireNoAgentOwner: boolean
  requireUnattached: boolean
  requireIdle?: true
  idleCheckSinceMs?: number
  switchCondition?: {
    token: string
    remainingMs: number
    ownedSpawn?: true
    claimGeneration?: string
  }
}

export type PtyFencedTerminationOutcome =
  | { outcome: 'ended' | 'already_exited' }
  | {
      outcome: 'refused'
      reason: 'replaced' | 'claimed' | 'attached' | 'unsupported' | 'unverifiable' | 'running_work'
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
      value.reason === 'running_work' ||
      value.reason === 'unverifiable')
  )
}
