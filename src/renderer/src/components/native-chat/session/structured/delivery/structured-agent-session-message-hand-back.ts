import { agentSessionAttachmentUploadIdOfPath } from '../../../../../../../shared/agent-session/agent-session-attachments'
import { formatNativeChatFileReference } from '../../../../../../../shared/native-chat/input/composer/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import { restoreNativeChatExpiredUploads } from '../../../drafts/native-chat-staged-input'
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
  skills?: AgentJournalMessageItem['skills'],
  /** The conversation the refused message was sent in: only its own uploads may be restored. */
  uploadSessionId?: string
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
  // An expired upload this conversation made, whose original is still staged anywhere (here, or still
  // at a pending worktree's source), comes back as that original and becomes this draft's: Send uploads
  // it afresh. This is the only restore: the returned content is Orca's own here, so nothing rewrites
  // the person's draft later. Any other expired upload asks to be attached again.
  const restored = uploadSessionId
    ? restoreNativeChatExpiredUploads(composerScopeKey, uploadSessionId, [
        ...blocks.flatMap((block) =>
          block.type === 'image-ref' && block.path && expired(block.path) ? [block.path] : []
        ),
        ...nativeChatTextAttachmentParts(messageText, true, expired).flatMap((part) =>
          part.path ? [part.path] : []
        )
      ])
    : new Map<string, string>()
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
    body.skills,
    sessionId
  )
}
