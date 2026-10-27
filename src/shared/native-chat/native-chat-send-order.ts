import type { AgentJournalSubmission } from '../agent-session-journal-types'

type SendTimes = Pick<AgentJournalSubmission, 'submittedSequence' | 'submittedAt'>

/** Use sequence when every entry has one, otherwise accept time; ties retain input order. */
export function inSendOrder<T>(entries: readonly T[], submissionOf: (entry: T) => SendTimes): T[] {
  const keyed = entries.map((entry) => {
    const { submittedSequence, submittedAt } = submissionOf(entry)
    return { entry, submittedSequence, submittedAt }
  })
  const sorted = allPositioned(keyed)
    ? [...keyed].sort((left, right) => left.submittedSequence - right.submittedSequence)
    : [...keyed].sort((left, right) => left.submittedAt - right.submittedAt)
  return sorted.map(({ entry }) => entry)
}

function allPositioned<T extends { submittedSequence?: number }>(
  entries: T[]
): entries is (T & { submittedSequence: number })[] {
  return entries.every((entry) => entry.submittedSequence !== undefined)
}
