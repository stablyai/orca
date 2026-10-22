import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { promptMarkersToImageReferences } from '../../../../shared/native-chat-image-transcript-markers'

/** The text a message body carries, as the composer shows it. */
export function structuredAgentSessionMessageText(body: AgentJournalMessageItem): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** Puts a message's text and images into a composer, after whatever is there. True once the text
 *  is durable. */
export function returnMessageToComposer(
  composerScopeKey: string,
  /** Unique to this message, so its images never collide with ones already attached. */
  attachmentIdPrefix: string,
  blocks: AgentJournalMessageItem['blocks'],
  /** Each image's SSH connection, in block order. */
  imageConnectionIds?: readonly (string | null)[]
): boolean {
  // Its `[Image #k]` markers become chips for its k-th image, by the ids its images get below.
  const imageIds = blocks.flatMap((block, index) =>
    block.type === 'image-ref' ? [`${attachmentIdPrefix}-${index}`] : []
  )
  let image = 0
  // Not the attachment hook's helper: its imports reach the store, whose teardown imports this.
  const images = blocks.flatMap((block, index) => {
    if (block.type !== 'image-ref') {
      return []
    }
    const connectionId = imageConnectionIds?.[image++]
    return block.path
      ? [
          {
            id: `${attachmentIdPrefix}-${index}`,
            path: block.path,
            ...(connectionId ? { connectionId } : {})
          }
        ]
      : []
  })
  // One step, so a crash never leaves chips without their images, and a second return of the
  // message is skipped by its image ids whatever was typed since.
  return appendNativeChatDraftCache(
    composerScopeKey,
    promptMarkersToImageReferences(
      structuredAgentSessionMessageText({ kind: 'message', role: 'user', blocks }),
      imageIds
    ),
    undefined,
    images
  )
}

/**
 * Puts a message that did not reach the host back in its chat's composer, after whatever is
 * there: the chat's draft is keyed by its conversation, so this works with or without its view
 * mounted. True once the text is durable.
 */
export function handBackStructuredAgentSessionMessage(
  sessionId: string,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  imageConnectionIds?: readonly (string | null)[]
): boolean {
  return returnMessageToComposer(
    structuredAgentSessionDraftScopeKey(sessionId),
    `returned-${clientMessageId}`,
    body.blocks,
    imageConnectionIds
  )
}
