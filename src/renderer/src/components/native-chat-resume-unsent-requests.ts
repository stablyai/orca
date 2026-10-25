import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'

// Record requests lost before host reservation locally; reconcile their failure marks with each authoritative host answer.

const unsentResumes = new Map<string, number>()
const UNSENT_RESUME_REASON = 'agent_session_restart_request_failed'

type HostAnswer = { candidates: readonly ResumeCandidate[]; failed: readonly ResumeFailure[] }

export function markUnsentResumes(sessionIds: readonly string[], failedAt: number): void {
  sessionIds.forEach((sessionId) => unsentResumes.set(sessionId, failedAt))
}

/** Retry, Dismiss and a launch's own resume each settle the chats they name afresh. */
export function forgetUnsentResumes(sessionIds: readonly string[] | undefined): void {
  if (sessionIds === undefined) {
    unsentResumes.clear()
    return
  }
  sessionIds.forEach((sessionId) => unsentResumes.delete(sessionId))
}

/** Move locally unsent offers into failures; drop local marks when the host no longer offers the chat. */
export function withUnsentResumes<T extends HostAnswer>(answer: T): T {
  const offered = new Set(answer.candidates.map((candidate) => candidate.sessionId))
  for (const sessionId of unsentResumes.keys()) {
    if (!offered.has(sessionId)) {
      unsentResumes.delete(sessionId)
    }
  }
  if (unsentResumes.size === 0) {
    return answer
  }
  const unsent = answer.candidates.flatMap((candidate): ResumeFailure[] => {
    const failedAt = unsentResumes.get(candidate.sessionId)
    return failedAt === undefined
      ? []
      : [
          {
            ...candidate,
            failedAt,
            outcome: 'refused',
            reason: UNSENT_RESUME_REASON,
            retryable: true
          }
        ]
  })
  return {
    ...answer,
    candidates: answer.candidates.filter((candidate) => !unsentResumes.has(candidate.sessionId)),
    failed: [...answer.failed, ...unsent]
  }
}
