import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentJournalConnectorDelivery } from './agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isQuietBotResult } from '../../bot-quiet-result'
import type { JournalConnectorReplyOutcome } from './journal-connector-reply'

// The turn end's mapping to a reply outbox outcome (design item 125 §3), shared by the live fill and
// the boot scan so both say the same for the same turn.

/** The outcome a turn's end gives every request it answered. prose: its own root prose (empty when
 *  it wrote none). A bot's quiet marker is a deliberate silence; a success that wrote nothing is
 *  done without an answer, never a failure. */
export function connectorReplyTurnOutcome(turn: {
  outcome: 'success' | 'failure' | 'cancellation' | 'superseded' | 'interruption'
  prose: string
  bot: boolean
}): { outcome: JournalConnectorReplyOutcome; prose?: string } {
  switch (turn.outcome) {
    case 'success': {
      if (!turn.prose.trim()) {
        return { outcome: 'no_answer' }
      }
      if (turn.bot && isQuietBotResult(turn.prose)) {
        return { outcome: 'quiet' }
      }
      return { outcome: 'answered', prose: turn.prose }
    }
    case 'failure':
      return { outcome: 'failed' }
    case 'cancellation':
      return { outcome: 'cancelled' }
    case 'superseded':
    case 'interruption':
      return { outcome: 'interrupted' }
  }
}

/** The deliveries a turn answered, by the provider's own evidence: its opener's stamp (a
 *  continuation's: the cut's deliveries it claimed), and each send the provider proved it steered
 *  into the turn. A message's turn scope alone is not evidence: the
 *  host assigns it at handover, before the provider takes the input. Each joined conversation gets
 *  the turn's whole answer (#850). `turnItemId`: the turn row's journal item key. */
export function connectorReplyTurnStamps(
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  },
  opener: AgentJournalRenderItem | null | undefined,
  turnItemId: string
): AgentJournalConnectorDelivery[] {
  const stamps: AgentJournalConnectorDelivery[] = []
  const seen = new Set<string>()
  const addStamp = (stamp: AgentJournalConnectorDelivery | undefined) => {
    if (stamp && !seen.has(`${stamp.account}\0${stamp.deliveryId}`)) {
      seen.add(`${stamp.account}\0${stamp.deliveryId}`)
      stamps.push(stamp)
    }
  }
  const add = (item: AgentJournalRenderItem | null | undefined) =>
    addStamp(item?.body.kind === 'message' ? item.body.connectorDelivery : undefined)
  // A continuation answers the deliveries of the cut it claimed, ahead of anything steered in.
  if (opener?.body.kind === 'message') {
    opener.body.connectorClaim?.origin.forEach(addStamp)
  }
  add(opener)
  for (const submission of journal.submissions) {
    if (
      submission.answeredInTurn?.via === 'steer' &&
      submission.answeredInTurn.turnItemId === turnItemId
    ) {
      const key = agentJournalSubmissionKey(submission.clientMessageId)
      add(journal.items.find((item) => item.itemId === key))
    }
  }
  return stamps
}
