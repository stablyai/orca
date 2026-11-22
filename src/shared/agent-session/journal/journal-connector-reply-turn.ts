import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentJournalConnectorDelivery } from './agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isQuietBotResult } from '../../bot-quiet-result'
import type { JournalConnectorReplyOutcome } from './journal-connector-reply'

// The turn end's mapping to a reply outbox outcome (design item 125 §3), shared by the live fill and
// the boot scan so both say the same for the same turn.

/** A delivery a turn answered, as its journal proves it. */
export type ConnectorReplyStamp = AgentJournalConnectorDelivery

/** The outcome a turn's end gives one request it answered. prose: its own root prose (empty when
 *  it wrote none). A bot's quiet marker silences it wherever it was asked. A success that wrote
 *  nothing is done without an answer, never a failure. */
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
      return turn.bot && isQuietBotResult(turn.prose)
        ? { outcome: 'quiet' }
        : { outcome: 'answered', prose: turn.prose }
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
): ConnectorReplyStamp[] {
  const stamps: ConnectorReplyStamp[] = []
  const seen = new Set<string>()
  // Copies, never the journal's own objects; each delivery once.
  const addStamp = (stamp: ConnectorReplyStamp | undefined) => {
    const key = stamp && `${stamp.account}\0${stamp.deliveryId}`
    if (stamp && key !== undefined && !seen.has(key)) {
      seen.add(key)
      stamps.push({ ...stamp })
    }
  }
  const add = (item: AgentJournalRenderItem | null | undefined) => {
    const body = item?.body.kind === 'message' ? item.body : null
    if (body?.connectorDelivery) {
      addStamp(body.connectorDelivery)
    }
  }
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
