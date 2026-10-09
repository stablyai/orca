// What each of the structured chat's own messages says under it about its delivery. Derived from
// the sender's in-memory sends and the host's rows on every render, never stored.

import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionRecordedRejectionParts } from '../../../../shared/structured-agent-session-rejection-words'
import { structuredAgentSessionRejectedShownInPlace } from '../../../../shared/structured-agent-session-message-projection'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

/** One shared value, so a rebuilt map re-renders no row still sending. */
const STRUCTURED_AGENT_SESSION_DELIVERY_SENDING: NativeChatDeliveryNotice = { sending: true }
const NO_COMMANDS: ReadonlySet<string> = new Set()

export {
  agentSessionVisibleFailureFacts as structuredAgentSessionStartFailureFacts,
  agentSessionFailureStatedByRow as agentSessionFailureStatedByStartRow,
  sameAgentSessionFailureFact
} from '../../../../shared/agent-session-visible-failures'
/**
 * Keyed by the message id the transcript renders each message under; `agentName` is the chat's
 * agent, for the words. A message on its way says so quietly, and one the host rejected is worded
 * from the host's fact. A message whose delivery nobody can confirm says nothing on its row, as in
 * the common pattern: one this window could not confirm went back to its composer with the reason.
 */
export function structuredAgentSessionDeliveryNotices(args: {
  pending: readonly StructuredAgentSessionPendingSend[]
  submissions: readonly AgentJournalSubmission[]
  agentName: string
  /** What the loaded start-failure rows state, from `structuredAgentSessionStartFailureFacts`. */
  startFailures: readonly AgentSessionFailureFact[]
  /** The loaded commands, from `structuredAgentSessionCommandItemIds`: they report their own. */
  commandItemIds?: ReadonlySet<string>
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentName, submissions } = args
  const notices = new Map<string, NativeChatDeliveryNotice>()
  // A row under the id is the host's to describe, before the sender settles from it.
  const recorded = new Set(submissions.map((submission) => submission.clientMessageId))
  for (const entry of args.pending) {
    if (entry.phase === 'sending' && !recorded.has(entry.clientMessageId)) {
      notices.set(
        agentJournalSubmissionKey(entry.clientMessageId),
        STRUCTURED_AGENT_SESSION_DELIVERY_SENDING
      )
    }
  }
  const shown = structuredAgentSessionRejectedShownInPlace(
    submissions,
    args.commandItemIds ?? NO_COMMANDS
  )
  for (const submission of submissions) {
    const id = agentJournalSubmissionKey(submission.clientMessageId)
    if (submission.dispatchState === 'rejected' && shown.has(id)) {
      notices.set(id, {
        text: agentSessionWriteNoticeText(
          structuredAgentSessionRecordedRejectionParts(
            submission,
            { agentName },
            args.startFailures
          )
        )
      })
    }
  }
  return notices
}
