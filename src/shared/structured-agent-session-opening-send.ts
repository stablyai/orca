// Hold subsequent sends while one opens a turn; clients draw held sends after live work.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'

/** Minimal fold shape lets the host read without rendering a snapshot. */
export type StructuredAgentSessionOpeningSendItem = {
  itemId: string
  sequence: number
  body: AgentJournalItemBody
  turnScope?: AgentJournalTurnScope
  agentId?: string
}

/** An unsettled handover outside a turn, with no later turn record (optionally child-fenced), is still opening.
 * Hold later sends until its turn exists or their handover would claim no turn despite joining it.
 * Echo/refusal/doubt/child-end/successful Stop journal commits settle it; failed/refused Stop leaves subsequent messages waiting. */
export function structuredAgentSessionSendOpeningTurn(
  submissions: readonly Pick<
    AgentJournalSubmission,
    'clientMessageId' | 'dispatchState' | 'handedOverAt' | 'fence'
  >[],
  visitItems: (visit: (item: StructuredAgentSessionOpeningSendItem) => void) => void,
  fence?: number
): boolean {
  return structuredAgentSessionOpeningSendItemId(submissions, visitItems, fence) !== null
}

/** Newest still-opening send’s item, or null; clients treat it as live while the turn opens. */
export function structuredAgentSessionOpeningSendItemId(
  submissions: readonly Pick<
    AgentJournalSubmission,
    'clientMessageId' | 'dispatchState' | 'handedOverAt' | 'fence'
  >[],
  visitItems: (visit: (item: StructuredAgentSessionOpeningSendItem) => void) => void,
  fence?: number
): string | null {
  const opening = new Set(
    submissions.flatMap((submission) =>
      submission.dispatchState === 'pending' &&
      submission.handedOverAt !== undefined &&
      (fence === undefined || submission.fence === fence)
        ? [agentJournalSubmissionKey(submission.clientMessageId)]
        : []
    )
  )
  if (opening.size === 0) {
    return null
  }
  const newest: { handover: string | null; handoverAt: number; settledAt: number } = {
    handover: null,
    handoverAt: -1,
    settledAt: -1
  }
  visitItems((item) => {
    if (
      opening.has(item.itemId) &&
      item.turnScope?.kind === 'thread' &&
      item.sequence > newest.handoverAt
    ) {
      newest.handover = item.itemId
      newest.handoverAt = item.sequence
    }
    if (readAgentJournalTurn(item.body) && isRootAgentJournalItem(item)) {
      newest.settledAt = Math.max(newest.settledAt, item.sequence)
    }
  })
  return newest.handoverAt > newest.settledAt ? newest.handover : null
}

export function structuredAgentSessionOpeningSendIn(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): string | null {
  return structuredAgentSessionOpeningSendItemId(submissions, (visit) => {
    for (const item of items) {
      visit(item)
    }
  })
}
