// The queue's publication as the client reducer keeps it: the draft list and what rides with it.

import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from './agent-session-queued-message-wire'

export type StructuredAgentSessionQueuePublication = {
  queuedMessages?: AgentSessionQueuedMessage[] | null
  queuePause?: AgentSessionQueuePause | null
  nextQueuedMessageId?: string | null
}

/** First claim with a list wins, and what rides with it comes from that claim; no claim at all
 *  leaves all absent (older host). */
export function queuePublicationField(
  ...claims: StructuredAgentSessionQueuePublication[]
): StructuredAgentSessionQueuePublication {
  for (const claim of claims) {
    if (claim.queuedMessages !== undefined) {
      return {
        queuedMessages: claim.queuedMessages,
        queuePause: claim.queuePause ?? null,
        nextQueuedMessageId: claim.nextQueuedMessageId ?? null
      }
    }
  }
  return {}
}
