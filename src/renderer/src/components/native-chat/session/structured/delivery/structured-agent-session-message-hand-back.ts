import { agentSessionAttachmentUploadIdOfPath } from '../../../../../../../shared/agent-session/agent-session-attachments'
import { formatNativeChatFileReference } from '../../../../../../../shared/native-chat/input/composer/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import { restoreNativeChatExpiredUploads } from '../../../drafts/native-chat-staged-input'
import { noteNativeChatUnrestoredExpiredUploads } from '../../../drafts/native-chat-expired-upload-repair'
import type { AgentJournalMessageItem } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatComposerDraftImage } from '../../../drafts/native-chat-composer-draft-storage'
import { appendToNativeChatComposerDraft } from '../../../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../../../drafts/native-chat-draft-scope'
import { unavailableNativeChatComposerDraftImage } from '../../../drafts/native-chat-composer-draft-persistence'
import { promptMarkersToImageReferences } from '../../../../../../../shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import {
  promptTextContent,
  seedPromptSkillReferences
} from '../../../composer/editor/native-chat-prompt-document-text'

export function structuredAgentSessionMessageText(body: AgentJournalMessageItem): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** Append returned input without replacing later typing; return true once durable. */
export function returnMessageToComposer(
  composerScopeKey: string,
  /** Unique to this message, so its images never collide with ones already attached. */
  attachmentIdPrefix: string,
  blocks: AgentJournalMessageItem['blocks'],
  /** Each image's SSH connection, in block order. */
  imageConnectionIds?: readonly (string | null)[],
  /** Uploads the host no longer stores: their chips come back asking to be attached again. */
  expiredUploadIds?: ReadonlySet<string>,
  skills?: AgentJournalMessageItem['skills']
): boolean {
  // Its `[Image #k]` markers become chips for its k-th image, by the ids its images get below.
  const imageIds = blocks.flatMap((block, index) =>
    block.type === 'image-ref' ? [`${attachmentIdPrefix}-${index}`] : []
  )
  let image = 0
  const expired = (path: string): boolean => {
    const uploadId = agentSessionAttachmentUploadIdOfPath(path)
    return !!uploadId && !!expiredUploadIds?.has(uploadId)
  }
  const messageText = structuredAgentSessionMessageText({ kind: 'message', role: 'user', blocks })
  // An expired upload whose staged original this draft still holds comes back as that original, so
  // Send uploads it afresh; only one the draft never held asks to be attached again.
  const restored = restoreNativeChatExpiredUploads(composerScopeKey, [
    ...blocks.flatMap((block) =>
      block.type === 'image-ref' && block.path && expired(block.path) ? [block.path] : []
    ),
    ...nativeChatTextAttachmentParts(messageText, true, expired).flatMap((part) =>
      part.path ? [part.path] : []
    )
  ])
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
    const original = restored.get(block.path)
    if (original) {
      return [{ id, path: original }]
    }
    return expired(block.path)
      ? [unavailableNativeChatComposerDraftImage({ id, path: block.path })]
      : [{ id, path: block.path, ...(connectionId ? { connectionId } : {}) }]
  })
  const text = promptMarkersToImageReferences(
    nativeChatTextAttachmentParts(messageText, true, (path) => restored.has(path))
      .map((part) =>
        part.path ? formatNativeChatFileReference(restored.get(part.path)!) : part.text
      )
      .join(''),
    imageIds
  )
  // Not this draft's yet (a first send refused before its draft moved in): repaired when they arrive.
  noteNativeChatUnrestoredExpiredUploads(
    composerScopeKey,
    blocks.flatMap((block, index) =>
      block.type === 'image-ref' && block.path && expired(block.path) && !restored.has(block.path)
        ? [[`${attachmentIdPrefix}-${index}`, block.path] as const]
        : []
    ),
    nativeChatTextAttachmentParts(messageText, true, expired).flatMap((part) =>
      part.path && !restored.has(part.path) ? [part.path] : []
    )
  )
  if (text === '' && images.length === 0) {
    return true
  }
  // Stable image ids make repeated hand-back idempotent despite later typing.
  return appendToNativeChatComposerDraft(composerScopeKey, {
    text,
    images,
    ...(skills?.length
      ? { document: seedPromptSkillReferences(promptTextContent(text), skills) }
      : {})
  })
}

/** Return unaccepted input to its conversation draft even when unmounted; true means durable. */
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
    expiredUploadIds,
    body.skills
  )
}
