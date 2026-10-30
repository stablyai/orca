import type { AgentSessionQueuedMessage } from './agent-session-wire'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from './structured-agent-session-send-mutation'

/** React container identity is not a new host publication. */
export function queuedEditPublicationKey(
  view: {
    messages: readonly AgentSessionQueuedMessage[] | null
    cards: readonly { messageId: string }[]
    submissions?: readonly AgentJournalSubmission[]
  },
  sessionId: string,
  messageId: string | undefined
): string {
  if (messageId === undefined) {
    return '[]'
  }
  const listed = view.messages?.find((entry) => entry.messageId === messageId)
  return JSON.stringify([
    view.messages === null,
    listed ? agentSessionSendBodyFingerprint(sessionId, listed.body) : null,
    view.cards.some((entry) => entry.messageId === messageId),
    view.submissions
      ?.filter((entry) => entry.queuedMessageId === messageId)
      .map((entry) => entry.payloadFingerprint)
  ])
}
