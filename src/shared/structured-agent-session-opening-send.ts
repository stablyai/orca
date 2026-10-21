// Whether a send ahead is still opening its own turn: the host holds the next message for it, and
// every client draws a message held that way after the live turn, never above it.

import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'

/** What the read needs of each journal item; the host visits its fold without a snapshot. */
export type StructuredAgentSessionOpeningSendItem = {
  itemId: string
  sequence: number
  body: AgentJournalItemBody
  turnScope?: AgentJournalTurnScope
  agentId?: string
}

/**
 * A send handed over while no turn ran, still unsettled, with no turn record written since its
 * handover (`fence`, when given: handed over by that child). A message handed over now would join
 * the turn that send is opening (Codex steers it in once the turn opens, Claude folds it into the
 * running cycle), yet its handover row would be written before that turn exists, and so read as
 * belonging to none. So the host holds it until the turn opens, and a client draws it after the
 * live turn meanwhile. Every way the send stops opening — its turn record, its echo, its refusal, a
 * lost answer's doubt, its child's end, a Stop that took — is a journal commit that settles it or
 * records its turn. A Stop that failed or was refused leaves the turn opening, so the next message
 * still waits.
 */
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

/** The item of the newest send still opening its turn (`structuredAgentSessionSendOpeningTurn`),
 *  or null: the turn a client reads as live while it opens. */
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

/** The same read over a client's journal items: the item of the send still opening, or null. */
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
