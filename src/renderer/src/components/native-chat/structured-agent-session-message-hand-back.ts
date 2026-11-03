import { agentSessionAttachmentUploadIdOfPath } from '../../../../shared/agent-session/agent-session-attachments'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatComposerDraftImage } from './native-chat-composer-draft-storage'
import {
  structuredAgentSessionDraftScopeKey,
  unavailableNativeChatComposerDraftImage
} from './native-chat-composer-draft-store'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { promptMarkersToImageReferences } from '../../../../shared/native-chat/transcript/native-chat-image-transcript-markers'

export function structuredAgentSessionMessageText(body: AgentJournalMessageItem): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** Append text and images without replacing existing input; return true once durable. */
export function returnMessageToComposer(
  composerScopeKey: string,
  /** Unique to this message, so its images never collide with ones already attached. */
  attachmentIdPrefix: string,
  blocks: AgentJournalMessageItem['blocks'],
  /** Each image's SSH connection, in block order. */
  imageConnectionIds?: readonly (string | null)[],
  /** Uploads the host no longer stores: their chips come back asking to be attached again. */
  expiredUploadIds?: ReadonlySet<string>
): boolean {
  // Its `[Image #k]` markers become chips for its k-th image, by the ids its images get below.
  const imageIds = blocks.flatMap((block, index) =>
    block.type === 'image-ref' ? [`${attachmentIdPrefix}-${index}`] : []
  )
  let image = 0
  // Not the attachment hook's helper: its imports reach the store, whose teardown imports this.
  const images = blocks.flatMap((block, index): NativeChatComposerDraftImage[] => {
    if (block.type !== 'image-ref') {
      return []
    }
    const connectionId = imageConnectionIds?.[image++]
    if (!block.path) {
      return []
    }
    const id = `${attachmentIdPrefix}-${index}`
    const uploadId = agentSessionAttachmentUploadIdOfPath(block.path)
    return uploadId && expiredUploadIds?.has(uploadId)
      ? [unavailableNativeChatComposerDraftImage({ id, path: block.path })]
      : [{ id, path: block.path, ...(connectionId ? { connectionId } : {}) }]
  })
  // Atomically append text/images; stable image ids make repeated hand-back idempotent despite later typing.
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

/** Return unaccepted text/images to the conversation-scoped draft even when unmounted; true means durable. */
export function handBackStructuredAgentSessionMessage(
  sessionId: string,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  imageConnectionIds?: readonly (string | null)[],
  expiredUploadIds?: ReadonlySet<string>
): boolean {
  return returnMessageToComposer(
    structuredAgentSessionDraftScopeKey(sessionId),
    `returned-${clientMessageId}`,
    body.blocks,
    imageConnectionIds,
    expiredUploadIds
  )
}
