import type { AgentSessionQueuedMessage } from '../../requests/agent-session-queued-message-wire'
import {
  queuePublicationField,
  type StructuredAgentSessionQueuePublication
} from '../../requests/structured-agent-session-queue-publication-field'
import { structuralValuesEqual } from '../../../collections/structural-value-equality'

export function queuePublicationRetainingMail(
  previous: AgentSessionQueuedMessage[] | null | undefined,
  ...claims: StructuredAgentSessionQueuePublication[]
): StructuredAgentSessionQueuePublication {
  const queue = queuePublicationField(...claims)
  const next = queue.queuedMessages
  if (!previous?.length || !next?.length || previous === next) {
    return queue
  }
  const blocksById = new Map<string, AgentSessionQueuedMessage['body']['blocks']>()
  for (const { messageId, body } of previous) {
    if (body.from?.orchestration?.message === 'mail-notice') {
      blocksById.set(messageId, body.blocks)
    }
  }
  if (blocksById.size === 0) {
    return queue
  }
  // Full queue publications carry fresh objects. Keep the display cache's key for unchanged mail.
  return {
    ...queue,
    queuedMessages: next.map((message) => {
      const blocks = blocksById.get(message.messageId)
      return blocks &&
        blocks !== message.body.blocks &&
        structuralValuesEqual(blocks, message.body.blocks)
        ? { ...message, body: { ...message.body, blocks } }
        : message
    })
  }
}
