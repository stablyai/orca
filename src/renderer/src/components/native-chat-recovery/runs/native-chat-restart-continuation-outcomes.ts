import type { ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'

export type RestartContinuationOutcome = {
  sessionId: string
  outcome: 'continued' | 'pending' | 'unknown' | 'refused'
}

/** Reconcile once with the action's confirmed list; later dismissals are not successes. */
export function restartContinuationHistory(
  requested: readonly string[],
  reported: readonly RestartContinuationOutcome[] | undefined,
  failed: readonly Pick<ResumeFailure, 'sessionId'>[] | undefined
): readonly RestartContinuationOutcome[] {
  const results = Array.isArray(reported)
    ? reported
    : requested.map((sessionId) => ({ sessionId, outcome: 'unknown' as const }))
  const failedIds = new Set(failed?.map((entry) => entry.sessionId))
  return results.map((entry) =>
    failed !== undefined &&
    !failedIds.has(entry.sessionId) &&
    (entry.outcome === 'unknown' || entry.outcome === 'pending')
      ? { ...entry, outcome: 'continued' as const }
      : entry
  )
}
