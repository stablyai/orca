// Where rows sit in the journal, and which of them a reader can have missed.

import { compareAgentJournalPositions } from '../../../../../../shared/agent-session/journal/agent-session-journal-position'
import type { AgentJournalPosition } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'

/** Use journal positions for conversation rows, including folded-turn bars; terminal-backed rows have none and remain unmarked. */
export function rowPosition(slot: NativeChatTranscriptSlot): AgentJournalPosition | undefined {
  return slot.kind === 'message' && slot.depth === 0 && (slot.drawsMessage || slot.statusAbove)
    ? slot.message.journalPosition
    : undefined
}

/** Before every row the journal places: what the reader has read to when no row precedes. */
const BEFORE_EVERY_ROW: AgentJournalPosition = { sequence: -1, index: 0 }

/** A prompt the reader sent from this chat, as opposed to a message another agent sent through Orca. */
export function isReaderPrompt(
  slot: NativeChatTranscriptSlot
): slot is Extract<NativeChatTranscriptSlot, { kind: 'message' }> {
  return (
    slot.kind === 'message' &&
    slot.depth === 0 &&
    slot.message.role === 'user' &&
    slot.message.from === undefined
  )
}

export function newestRowPosition(
  slots: readonly NativeChatTranscriptSlot[],
  limit?: AgentJournalPosition
): AgentJournalPosition {
  let newest = BEFORE_EVERY_ROW
  for (const slot of slots) {
    const at = rowPosition(slot)
    if (
      at &&
      (!limit || compareAgentJournalPositions(at, limit) < 0) &&
      compareAgentJournalPositions(at, newest) > 0
    ) {
      newest = at
    }
  }
  return newest
}

/** Placed in the stretch the reader was away for, and not their own prompt. */
export function isMissedRow(
  slot: NativeChatTranscriptSlot,
  after: AgentJournalPosition,
  through: AgentJournalPosition
): boolean {
  const at = rowPosition(slot)
  return (
    at !== undefined &&
    compareAgentJournalPositions(at, after) > 0 &&
    compareAgentJournalPositions(at, through) <= 0 &&
    (slot.kind !== 'message' || slot.message.role !== 'user' || slot.message.from !== undefined)
  )
}
