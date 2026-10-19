import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'

// A resume request that failed before the host reserved anything leaves it nothing to record, so
// its chats are shown failed from here: by id, when it failed. Each host answer re-derives it.

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

/** The host's answer with each unsent resume's chat moved from its offers to its failures. A chat
 *  the host no longer offers drops its mark, so a host failure row is never shown beside it. */
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
