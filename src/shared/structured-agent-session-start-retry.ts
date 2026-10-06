// When a message whose agent start was refused before any process ran is tried again. Such a
// refusal usually has an end — an account switch, a lease being settled — so the message is owed a
// few more tries before it is the person's to act on.

import type { AgentJournalSubmission } from './agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'

/** The wait after the first, second and third failed start; a fourth is terminal. */
export const STRUCTURED_AGENT_SESSION_START_RETRY_DELAYS_MS: readonly number[] = [
  15_000, 60_000, 300_000
]

/** When the next start is due after `attempts` failed ones; null when the message is done trying. */
export function structuredAgentSessionStartRetryAt(
  attempts: number,
  failedAt: number
): number | null {
  const delay = STRUCTURED_AGENT_SESSION_START_RETRY_DELAYS_MS[attempts - 1]
  return delay === undefined ? null : failedAt + delay
}

/** A queued message waiting out a refused start: nothing runs for it until its next try. */
export function isRetryingStructuredAgentSessionStart(
  submission: Pick<
    AgentJournalSubmission,
    'handoverRecorded' | 'dispatchState' | 'handedOverAt' | 'startRetry'
  >
): boolean {
  return submission.startRetry !== undefined && isQueuedAgentJournalSubmission(submission)
}
