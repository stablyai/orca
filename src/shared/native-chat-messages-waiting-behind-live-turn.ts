// Which rows wait at the tail, after the live turn's activity line, rather than in the transcript.

import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'
import type { NativeChatRole } from './native-chat-types'
import { isStructuredAgentSessionCommandTurn } from './structured-agent-session-command-entry'
import { liveStructuredAgentSessionTurnScope } from './structured-agent-session-live-turn'
import { structuredAgentSessionOpeningSendIn } from './structured-agent-session-opening-send'

/**
 * The rows accepted but not yet handed over while a conversation command's turn runs, as a message
 * sent during `/compact` is: the host hands nothing over until the command ends, so they draw after
 * that turn's live activity. Any other running turn takes a send within moments, so it stays put,
 * unless a person's Stop is ending it (`stopping`): the host holds a send made then until it ends,
 * so those, and this client's own sends made then that it has not recorded yet, draw after the
 * live activity too. A send made before the Stop stays where it is. While a send ahead is still
 * opening its turn (`submissions`), the rows sent after it wait too, queued or not recorded yet:
 * the host takes none of them into that turn until it opens, and a queued row's place, the row that
 * accepted it, is above the handover that moved that send.
 */
export function nativeChatMessagesWaitingBehindLiveTurn(
  messages: readonly {
    id: string
    role?: NativeChatRole
    queued?: true
    unsent?: true
    sentWhileStopping?: true
    awaitsRetry?: true
    journalPosition?: unknown
  }[],
  items: readonly AgentJournalRenderItem[] | null | undefined,
  stopping = false,
  submissions?: readonly AgentJournalSubmission[]
): ReadonlySet<string> {
  const waits = (message: (typeof messages)[number]): boolean =>
    message.queued === true || (stopping && message.sentWhileStopping === true)
  // Behind a turn still opening: queued, or a send of this client's the host has not recorded and
  // is not waiting on the user's Retry.
  const unrecorded = (message: (typeof messages)[number]): boolean =>
    message.role === 'user' &&
    message.journalPosition === undefined &&
    message.unsent !== true &&
    message.awaitsRetry !== true
  const candidates = messages.filter((message) => waits(message) || unrecorded(message))
  if (candidates.length === 0 || !items) {
    return new Set()
  }
  const behindHold = stopping || commandTurnRunning(items)
  const behindOpening =
    submissions !== undefined && structuredAgentSessionOpeningSendIn(items, submissions) !== null
  return new Set(
    candidates
      .filter(
        (message) =>
          (behindHold && waits(message)) ||
          (behindOpening && (message.queued === true || unrecorded(message)))
      )
      .map((message) => message.id)
  )
}

function commandTurnRunning(items: readonly AgentJournalRenderItem[]): boolean {
  const running = liveStructuredAgentSessionTurnScope(items)
  const bodyOf = (itemId: string) => items.find((item) => item.itemId === itemId)?.body
  return (
    running.kind === 'turn' &&
    isStructuredAgentSessionCommandTurn(readAgentJournalTurn(bodyOf(running.turnItemId)), bodyOf)
  )
}

/** While a send is still opening its turn, that send's turn is the live one, not a message sent
 *  after it that waits behind it (`nativeChatMessagesWaitingBehindLiveTurn`). */
export function nativeChatOpeningTurnKey(
  messages: readonly { id: string }[],
  turnKeys: readonly (string | undefined)[],
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  }
): string | undefined {
  const opening = structuredAgentSessionOpeningSendIn(journal.items, journal.submissions)
  const index = opening === null ? -1 : messages.findIndex((message) => message.id === opening)
  return index === -1 ? undefined : turnKeys[index]
}
