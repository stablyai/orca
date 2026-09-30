// The journal's own order: the sequence of the row that created an item, then the
// item's place among that row's writes. Time never enters it — a row recovered
// after a crash carries the provider's earlier clock at a later sequence.

import type { AgentJournalPosition, AgentJournalRenderItem } from './agent-session-journal-types'
import type { NativeChatMessage } from './native-chat-types'

type PositionedItem = Pick<AgentJournalRenderItem, 'sequence' | 'sequenceIndex'>

/** What every transcript row projected from a journal item carries, so a row
 *  that changes shape (a question once answered) keeps its identity and place. */
export function agentJournalItemRowOrigin(
  item: AgentJournalRenderItem
): Pick<NativeChatMessage, 'id' | 'timestamp' | 'source' | 'journalPosition'> {
  return {
    id: item.itemId,
    timestamp: item.observedAt,
    source: 'transcript',
    journalPosition: agentJournalItemPosition(item)
  }
}

export function agentJournalItemPosition(item: PositionedItem): AgentJournalPosition {
  return { sequence: item.sequence, index: item.sequenceIndex ?? 0 }
}

export function compareAgentJournalPositions(
  a: AgentJournalPosition,
  b: AgentJournalPosition
): number {
  return a.sequence - b.sequence || a.index - b.index
}

export function compareAgentJournalItems(a: PositionedItem, b: PositionedItem): number {
  return a.sequence - b.sequence || (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0)
}
