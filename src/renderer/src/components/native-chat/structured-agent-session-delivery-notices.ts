// What each of the structured chat's own messages says under it about its delivery. Derived from
// the sender's in-memory sends and the host's rows on every render, never stored.

import {
  readAgentSessionFailureFact,
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentSessionWriteNotDoneParts } from '../../../../shared/agent-session-refusal-notice'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { structuredAgentSessionRejectionParts } from '../../../../shared/structured-agent-session-rejection-words'
import { structuredAgentSessionRejectedShownInPlace } from '../../../../shared/structured-agent-session-message-projection'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

/** One shared value, so a rebuilt map re-renders no row still sending. */
const STRUCTURED_AGENT_SESSION_DELIVERY_SENDING: NativeChatDeliveryNotice = { sending: true }
const NO_COMMANDS: ReadonlySet<string> = new Set()

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

function hostRejectionNoticeText(
  submission: AgentJournalSubmission,
  agentName: string,
  startFailures: readonly AgentSessionFailureFact[]
): string {
  if (agentSessionFailureStatedByStartRow(submission.rejection, startFailures)) {
    return agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('send'))
  }
  return agentSessionWriteNoticeText(
    structuredAgentSessionRejectionParts(
      submission.reason,
      'send',
      readWholeAgentSessionFailureFact(submission.rejection),
      { agentName }
    )
  )
}

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
        text: hostRejectionNoticeText(submission, agentName, args.startFailures)
      })
    }
  }
  return notices
}
