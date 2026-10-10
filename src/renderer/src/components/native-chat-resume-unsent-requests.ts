import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import type { RestartMachineKey } from './native-chat-restart-machines'

// A resume request that failed before the host reserved anything leaves it nothing to record, so
// its chats are shown failed from here: by machine and id, when it failed. Session ids are each
// host's own, so a mark only ever applies to the machine it was made for. Each host answer from
// that machine re-derives it.

const unsentResumes = new Map<RestartMachineKey, Map<string, number>>()
const UNSENT_RESUME_REASON = 'agent_session_restart_request_failed'

type HostAnswer = { candidates: readonly ResumeCandidate[]; failed: readonly ResumeFailure[] }

export function markUnsentResumes(
  machine: RestartMachineKey,
  sessionIds: readonly string[],
  failedAt: number
): void {
  const marks = unsentResumes.get(machine) ?? new Map<string, number>()
  sessionIds.forEach((sessionId) => marks.set(sessionId, failedAt))
  unsentResumes.set(machine, marks)
}

/** Retry, Dismiss and a launch's own resume each settle the chats they name afresh; unnamed, the
 *  machine's every mark ends (its offer was dismissed whole, or it was re-paired or forgotten). */
export function forgetUnsentResumes(
  machine: RestartMachineKey,
  sessionIds: readonly string[] | undefined
): void {
  const marks = unsentResumes.get(machine)
  if (!marks) {
    return
  }
  if (sessionIds === undefined) {
    unsentResumes.delete(machine)
    return
  }
  sessionIds.forEach((sessionId) => marks.delete(sessionId))
  if (marks.size === 0) {
    unsentResumes.delete(machine)
  }
}

/** @internal - tests need a clean module between cases. */
export function _resetUnsentResumes(): void {
  unsentResumes.clear()
}

/** The machine's answer with each unsent resume's chat moved from its offers to its failures. A
 *  chat the host no longer offers drops its mark, so a host failure row is never shown beside it. */
export function withUnsentResumes<T extends HostAnswer>(machine: RestartMachineKey, answer: T): T {
  const marks = unsentResumes.get(machine)
  if (!marks) {
    return answer
  }
  const offered = new Set(answer.candidates.map((candidate) => candidate.sessionId))
  for (const sessionId of marks.keys()) {
    if (!offered.has(sessionId)) {
      marks.delete(sessionId)
    }
  }
  if (marks.size === 0) {
    unsentResumes.delete(machine)
    return answer
  }
  const unsent = answer.candidates.flatMap((candidate): ResumeFailure[] => {
    const failedAt = marks.get(candidate.sessionId)
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
    candidates: answer.candidates.filter((candidate) => !marks.has(candidate.sessionId)),
    failed: [...answer.failed, ...unsent]
  }
}
