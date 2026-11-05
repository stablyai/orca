import type { AgentJournalSubmission } from '../agent-session/journal/agent-session-journal-types'
import {
  finishAgentSessionSteps,
  mapAgentSessionSteps,
  sortAgentSessionSteps
} from '../agent-session/agent-session-projection-steps'
type SendTimes = Pick<AgentJournalSubmission, 'submittedSequence' | 'submittedAt'>
/** Use sequence when every entry has one, otherwise accept time; ties retain input order. */
export function inSendOrder<T>(entries: readonly T[], submissionOf: (entry: T) => SendTimes): T[] {
  return finishAgentSessionSteps(inSendOrderSteps(entries, submissionOf))
}
export function* inSendOrderSteps<T>(
  entries: readonly T[],
  submissionOf: (entry: T) => SendTimes
): Generator<void, T[]> {
  let positioned = true
  const keyed = yield* mapAgentSessionSteps(entries, (entry) => {
    const { submittedSequence, submittedAt } = submissionOf(entry)
    positioned &&= submittedSequence !== undefined
    return { entry, submittedSequence, submittedAt }
  })
  const sorted = yield* sortAgentSessionSteps(keyed, (a, b) =>
    positioned ? a.submittedSequence! - b.submittedSequence! : a.submittedAt - b.submittedAt
  )
  return yield* mapAgentSessionSteps(sorted, ({ entry }) => entry)
}
