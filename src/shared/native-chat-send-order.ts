// The order a client's sends were made in, as the host published it.

import type { AgentJournalSubmission } from './agent-session-journal-types'

type SendTimes = Pick<AgentJournalSubmission, 'submittedSequence' | 'submittedAt'>

/** Entries in the order their sends were made: by the published `submittedSequence` when every one
 *  carries it, else by accept time. Stable, so ties keep the order given. */
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
