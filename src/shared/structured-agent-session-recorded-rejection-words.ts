// What a send the host recorded and then did not deliver says on its own row, on every client.
// A rejection that is a failed start's, the fact its loaded row states, says only that it was not
// sent: the row already says why.

import {
  readAgentSessionFailureFact,
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from './agent-session-failure'
import type { AgentSessionFailureWordsContext } from './agent-session-failure-words'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentSessionWriteNotDoneParts } from './agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from './agent-session-write-notice-copy'
import { structuredAgentSessionRejectedFailure } from './structured-agent-session-outbox'
import { structuredAgentSessionAttemptFailureParts } from './structured-agent-session-send-disposition'
import { isStructuredAgentSessionStartFailureRow } from './structured-agent-session-start-failure-row-key'

/** The facts the chat's loaded start-failure rows state. */
export function structuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[]
): AgentSessionFailureFact[] {
  const facts: AgentSessionFailureFact[] = []
  for (const item of items) {
    if (item.body.kind === 'status' && isStructuredAgentSessionStartFailureRow(item.itemId)) {
      const fact = readAgentSessionFailureFact(item.body.failure)
      if (fact) {
        facts.push(fact)
      }
    }
  }
  return facts
}

/** Whether two facts are one failure: a start's row and the messages it rejected share one. */
export function sameAgentSessionFailureFact(
  a: AgentSessionFailureFact,
  b: AgentSessionFailureFact
): boolean {
  return (
    a.kind === b.kind &&
    a.detail?.text === b.detail?.text &&
    a.detail?.audience === b.detail?.audience &&
    a.refusal?.code === b.refusal?.code &&
    a.refusal?.details?.reason === b.refusal?.details?.reason &&
    a.attachment?.reason === b.attachment?.reason &&
    a.attachment?.limit === b.attachment?.limit &&
    a.retry?.error === b.retry?.error &&
    a.retry?.status === b.retry?.status
  )
}

/** Whether a loaded start-failure row already states this failure. Matching is identity, not
 *  wording: what this build can read is enough. */
export function agentSessionFailureStatedByStartRow(
  failure: unknown,
  startFailures: readonly AgentSessionFailureFact[]
): boolean {
  const fact = readAgentSessionFailureFact(failure)
  return (
    fact !== undefined && startFailures.some((stated) => sameAgentSessionFailureFact(stated, fact))
  )
}

/** The words for a recorded rejection that no outbox entry on this client carries. */
export function structuredAgentSessionRecordedRejectionParts(
  submission: AgentJournalSubmission,
  context: AgentSessionFailureWordsContext,
  startFailures: readonly AgentSessionFailureFact[]
): AgentSessionWriteNoticePart[] {
  if (agentSessionFailureStatedByStartRow(submission.rejection, startFailures)) {
    return agentSessionWriteNotDoneParts('send')
  }
  return structuredAgentSessionAttemptFailureParts(
    structuredAgentSessionRejectedFailure(submission),
    context,
    readWholeAgentSessionFailureFact(submission.rejection)
  )
}
