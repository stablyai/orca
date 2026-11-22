import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from './agent-session-queued-message-wire'

export type StructuredAgentSessionQueuePublication = {
  queuedMessages?: AgentSessionQueuedMessage[] | null
  queuePause?: AgentSessionQueuePause | null
  nextQueuedMessageId?: string | null
}

/** First list-bearing claim owns accompanying queue fields; no list leaves fields absent for older hosts. */
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
