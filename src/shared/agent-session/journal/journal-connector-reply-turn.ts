import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentJournalConnectorDelivery } from './agent-journal-bot-message-fields'
import { journalTurnAnsweredMessages } from './journal-turn-answered-messages'
import { addressedBotWords, isQuietBotResult } from '../../bot-quiet-result'
import type { JournalConnectorReplyOutcome } from './journal-connector-reply'

// The turn end's mapping to a reply outbox outcome (design item 125 §3), shared by the live fill and
// the boot scan so both say the same for the same turn.

/** A delivery a turn answered, as its journal proves it. `ownerAsked`: the bot's owner sent the
 *  message that carried it (its asker): an older build's row in their own DM keeps its words. */
export type ConnectorReplyStamp = AgentJournalConnectorDelivery & { ownerAsked?: true }

/** A bot's final words for a request: none when its quiet marker silences them. A reply that is
 *  nothing but the marker is a deliberate silence; otherwise only the trailing marker goes
 *  (addressedBotWords), unless `silencedWhole`: a row admitted under the older rule, where the
 *  marker silenced the whole reply. */
export function connectorReplyWords(
  prose: string,
  { bot, silencedWhole }: { bot: boolean; silencedWhole?: boolean }
): string | null {
  if (!bot || !isQuietBotResult(prose)) {
    return prose
  }
  return silencedWhole ? null : addressedBotWords(prose)
}

/** The outcome a turn's end gives one request it answered. prose: its own root prose (empty when
 *  it wrote none). A success that wrote nothing is done without an answer, never a failure. */
export function connectorReplyTurnOutcome(turn: {
  outcome: 'success' | 'failure' | 'cancellation' | 'superseded' | 'interruption'
  prose: string
  bot: boolean
  silencedWhole?: boolean
}): { outcome: JournalConnectorReplyOutcome; prose?: string } {
  switch (turn.outcome) {
    case 'success': {
      if (!turn.prose.trim()) {
        return { outcome: 'no_answer' }
      }
      const words = connectorReplyWords(turn.prose, {
        bot: turn.bot,
        silencedWhole: turn.silencedWhole
      })
      return words === null ? { outcome: 'quiet' } : { outcome: 'answered', prose: words }
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
 *  into the turn (journalTurnAnsweredMessages). Each joined conversation gets the turn's whole
 *  answer (#850). `turnItemId`: the turn row's journal item key. */
export function connectorReplyTurnStamps(
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  },
  opener: AgentJournalRenderItem | null | undefined,
  turnItemId: string
): ConnectorReplyStamp[] {
  return connectorReplyStampsOf(opener, journalTurnAnsweredMessages(journal, opener, turnItemId))
}

/** connectorReplyTurnStamps from the turn's already-read journalTurnAnsweredMessages. */
export function connectorReplyStampsOf(
  opener: AgentJournalRenderItem | null | undefined,
  answered: readonly AgentJournalRenderItem[]
): ConnectorReplyStamp[] {
  const stamps: ConnectorReplyStamp[] = []
  const seen = new Map<string, ConnectorReplyStamp>()
  // Copies, never the journal's own objects; the same delivery seen again keeps any owner proof.
  const addStamp = (stamp: ConnectorReplyStamp | undefined) => {
    const key = stamp && `${stamp.account}\0${stamp.deliveryId}`
    const known = key === undefined ? undefined : seen.get(key)
    if (stamp && key !== undefined && !known) {
      const copy = { ...stamp }
      seen.set(key, copy)
      stamps.push(copy)
    } else if (known && stamp?.ownerAsked) {
      known.ownerAsked = true
    }
  }
  // A continuation answers the deliveries of the cut it claimed, ahead of anything steered in.
  if (opener?.body.kind === 'message') {
    opener.body.connectorClaim?.origin.forEach(addStamp)
  }
  for (const item of answered) {
    const body = item.body.kind === 'message' ? item.body : null
    if (body?.connectorDelivery) {
      const ownerAsked = body.asker?.role === 'owner'
      addStamp({ ...body.connectorDelivery, ...(ownerAsked ? { ownerAsked: true as const } : {}) })
    }
  }
  return stamps
}
