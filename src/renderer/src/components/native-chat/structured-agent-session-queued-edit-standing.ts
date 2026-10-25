// Compare published queue state with the desired edit body, including Saves whose reply was lost.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'

/** Sent means handed off with this body; holds/differs describe the current card, gone its removal; null queue proves nothing. */
export type QueuedEditStanding = 'sent' | 'gone' | 'holds' | 'differs'

export function queuedEditStanding(
  view: {
    messages: readonly AgentSessionQueuedMessage[] | null
    cards: readonly QueuedMessageCard[]
    submissions: readonly AgentJournalSubmission[]
  },
  sessionId: string,
  messageId: string,
  /** The fingerprint of the body the edit would save; null when it saves none. */
  desired: string | null
): QueuedEditStanding | null {
  if (view.messages === null) {
    return null
  }
  const listed = view.messages.find((entry) => entry.messageId === messageId)
  if (!listed || !queuedCardOnScreen(view.cards, messageId)) {
    const sent = view.submissions.some(
      (entry) => entry.queuedMessageId === messageId && entry.payloadFingerprint === desired
    )
    return desired !== null && sent ? 'sent' : 'gone'
  }
  return agentSessionSendBodyFingerprint(sessionId, listed.body) === desired ? 'holds' : 'differs'
}

export function queuedCardOnScreen(
  cards: readonly QueuedMessageCard[],
  messageId: string
): boolean {
  return cards.some((card) => card.messageId === messageId)
}
