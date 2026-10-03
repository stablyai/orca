/**
 * Stable ask result classification for external engines (#13184).
 * Derived from existing fields — does not invent new wait semantics.
 */
export type OrchestrationAskOutcome =
  | 'answered'
  | 'timed_out_pending'
  | 'connection_lost_pending'
  | 'cancelled'
  | 'resume_required'

export type OrchestrationAskOutcomeFields = {
  outcome: OrchestrationAskOutcome
  /** True when the question remains open and `--resume <messageId>` is the right next step. */
  pending: boolean
}

export type OrchestrationAskResultShape = {
  answer: string | null
  timedOut: boolean
  cancelled?: boolean
  connectionLost?: boolean
  legacyCompatibility?: { resumeRequired?: boolean } | null
}

export function classifyOrchestrationAskOutcome(
  result: OrchestrationAskResultShape
): OrchestrationAskOutcomeFields {
  if (result.legacyCompatibility?.resumeRequired) {
    return { outcome: 'resume_required', pending: true }
  }
  if (result.answer !== null) {
    return { outcome: 'answered', pending: false }
  }
  if (result.timedOut) {
    return { outcome: 'timed_out_pending', pending: true }
  }
  if (result.cancelled && result.connectionLost) {
    return { outcome: 'connection_lost_pending', pending: true }
  }
  if (result.cancelled) {
    return { outcome: 'cancelled', pending: false }
  }
  // Why: null answer without timeout/cancel is unexpected; engines should not resume blindly.
  return { outcome: 'cancelled', pending: false }
}

export function withOrchestrationAskOutcome<T extends OrchestrationAskResultShape>(
  result: T
): T & OrchestrationAskOutcomeFields {
  return { ...result, ...classifyOrchestrationAskOutcome(result) }
}
