export type RestartContinuationOutcome = {
  sessionId: string
  outcome: 'continued' | 'pending' | 'unknown' | 'refused'
}

/** Only the host's own outcome settles a chat; a missing failure record is no proof it continued. */
export function restartContinuationHistory(
  requested: readonly string[],
  reported: readonly RestartContinuationOutcome[] | undefined
): readonly RestartContinuationOutcome[] {
  const outcomes = new Map(
    (Array.isArray(reported) ? reported : []).map((entry) => [entry.sessionId, entry.outcome])
  )
  // A requested chat the reply leaves out is as unproven as one with no reply at all.
  return requested.map((sessionId) => ({
    sessionId,
    outcome: outcomes.get(sessionId) ?? ('unknown' as const)
  }))
}
