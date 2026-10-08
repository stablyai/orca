// What each of the structured chat's own messages says under it about its delivery. Derived from
// the sender's in-memory sends and the host's rows on every render, never stored. A rejection whose
// own start's row states the same failure says only that it was not sent: the row already says why.

import {
  readAgentSessionFailureFact,
  readWholeAgentSessionFailureFact,
  sameAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentSessionWriteNotDoneParts } from '../../../../shared/agent-session-refusal-notice'
import {
  isStructuredAgentSessionCommandStartFailureRow,
  isStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRowIdentity
} from '../../../../shared/structured-agent-session-start-failure-row-key'
import { structuredAgentSessionRejectionParts } from '../../../../shared/structured-agent-session-rejection-words'
import { structuredAgentSessionRejectedShownInPlace } from '../../../../shared/structured-agent-session-message-projection'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

/** One shared value, so a rebuilt map re-renders no row still sending. */
const STRUCTURED_AGENT_SESSION_DELIVERY_SENDING: NativeChatDeliveryNotice = { sending: true }
const NO_COMMANDS: ReadonlySet<string> = new Set()

/** A loaded start-failure row: its item id, the failure it states, and whether a command's start
 *  wrote it (its words name the command's next step, so it speaks for no message). */
export type StatedStartFailure = {
  itemId: string
  fact: AgentSessionFailureFact
  ofCommand: boolean
}

/** What the chat's loaded start-failure rows state. */
export function structuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[]
): StatedStartFailure[] {
  const stated: StatedStartFailure[] = []
  let bodies: Map<string, AgentJournalRenderItem['body']> | undefined
  const bodyOf = (id: string) =>
    (bodies ??= new Map(items.map((entry) => [entry.itemId, entry.body]))).get(id)
  for (const item of items) {
    if (item.body.kind === 'status' && isStructuredAgentSessionStartFailureRow(item.itemId)) {
      const fact = readAgentSessionFailureFact(item.body.failure)
      if (fact) {
        stated.push({
          itemId: item.itemId,
          fact,
          ofCommand: isStructuredAgentSessionCommandStartFailureRow(item.itemId, bodyOf)
        })
      }
    }
  }
  return stated
}

/** Whether one of these start-failure rows already states this failure. Matching is identity, not
 *  wording: what this build can read is enough. */
export function agentSessionFailureStatedByStartRow(
  failure: unknown,
  startFailures: readonly StatedStartFailure[]
): boolean {
  const fact = readAgentSessionFailureFact(failure)
  return (
    fact !== undefined &&
    startFailures.some((stated) => sameAgentSessionFailureFact(stated.fact, fact))
  )
}

/** Whether the row of the start that rejected this message already says why. A row keyed by the
 *  message is its own start's and speaks for it alone, so its failure decides. With none — a run
 *  left one row for it, or an exit wrote one keyed by its start — any loaded row with the same
 *  failure does, but a command's. */
function rejectionStatedByItsStartRow(
  recorded: AgentJournalSubmission,
  startFailures: readonly StatedStartFailure[]
): boolean {
  const ownRow = agentJournalItemKey(
    structuredAgentSessionStartFailureRowIdentity(recorded.clientMessageId)
  )
  const own = startFailures.filter(({ itemId }) => itemId === ownRow)
  return agentSessionFailureStatedByStartRow(
    recorded.rejection,
    own.length > 0 ? own : startFailures.filter(({ ofCommand }) => !ofCommand)
  )
}

function hostRejectionNoticeText(
  submission: AgentJournalSubmission,
  agentName: string,
  startFailures: readonly StatedStartFailure[]
): string {
  if (rejectionStatedByItsStartRow(submission, startFailures)) {
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
  startFailures: readonly StatedStartFailure[]
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
