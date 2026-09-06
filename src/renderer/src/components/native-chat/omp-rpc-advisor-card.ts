// The advisor card carried by an RPC `message_start`/`message_end` frame.
//
// OMP emits both boundaries for a finished advisor card and never streams one
// through `message_update` (agent-session.ts routes the pair through
// `trackCardEvent`), so the frame's own `message` is the only live carrier of
// the note. Kept apart from the reducer so the frame-shape knowledge sits with
// the advisor protocol rather than the state machine.

import {
  ompAdvisorTurnId,
  readOmpAdvisorNotes,
  type OmpAdvisorNote
} from '../../../../shared/omp-advisor-notes'
import { capAdvisorCards, capAdvisorTurnIds } from './omp-rpc-overlay-retention'

/** The turn state's advisor slice: the live cards and the identities already
 *  retired by transcript coverage. */
export type OmpRpcAdvisorCardState = {
  advisorCards: OmpRpcAdvisorCard[]
  retiredAdvisorTurnIds: string[]
}

export type OmpRpcAdvisorCard = {
  /** Shared with the transcript copy of the same card (omp-advisor-notes.ts). */
  turnId: string
  notes: OmpAdvisorNote[]
  timestamp: number | null
}

/** Null for any message that is not a displayable advisor card. `display` is
 *  absent-tolerant here — a wire message need not carry the field a persisted
 *  `CustomMessageEntry` requires — but an explicit `false` is honored, since
 *  that is OMP's own "hidden entirely" flag. */
export function readOmpRpcAdvisorCard(message: unknown): OmpRpcAdvisorCard | null {
  if (typeof message !== 'object' || message === null) {
    return null
  }
  const record = message as { display?: unknown; timestamp?: unknown }
  if (record.display === false) {
    return null
  }
  const notes = readOmpAdvisorNotes(message)
  const timestamp = typeof record.timestamp === 'number' ? record.timestamp : null
  const turnId = ompAdvisorTurnId(notes, timestamp)
  if (!turnId) {
    return null
  }
  return { turnId, notes, timestamp }
}

/**
 * The card list after this frame, or the SAME array when the frame adds
 * nothing — an identity the reducer turns into a no-op state. Both boundaries
 * carry the finished card, hence the turnId-keyed re-add check, and the
 * retention budget applies here because cards outlive their turn.
 *
 * The retirement ledger refuses a card the transcript already surfaced:
 * drops the card from the list, so without the ledger the second boundary
 * frame would re-admit it with no coverage left to hide it.
 */
export function appendOmpRpcAdvisorCard(
  state: OmpRpcAdvisorCardState,
  message: unknown
): OmpRpcAdvisorCard[] {
  const cards = state.advisorCards
  const card = readOmpRpcAdvisorCard(message)
  if (
    !card ||
    state.retiredAdvisorTurnIds.includes(card.turnId) ||
    cards.some((known) => known.turnId === card.turnId)
  ) {
    return cards
  }
  return capAdvisorCards([...cards, card])
}

/**
 * Retires the cards the transcript now carries: they leave the list for good
 * and their identities join the ledger. Hiding them per render is not enough —
 * the transcript is a bounded window (native-chat-pagination.ts), so the row
 * that proved coverage eventually scrolls out and a merely-hidden card would
 * reappear at the tail as fresh advice.
 */
export function retireOmpRpcAdvisorCards(
  state: OmpRpcAdvisorCardState,
  coveredTurnIds: readonly string[]
): OmpRpcAdvisorCardState | null {
  const added = coveredTurnIds.filter(
    (turnId, index) =>
      !state.retiredAdvisorTurnIds.includes(turnId) && coveredTurnIds.indexOf(turnId) === index
  )
  if (added.length === 0) {
    return null
  }
  return {
    advisorCards: state.advisorCards.filter((card) => !added.includes(card.turnId)),
    retiredAdvisorTurnIds: capAdvisorTurnIds([...state.retiredAdvisorTurnIds, ...added])
  }
}
