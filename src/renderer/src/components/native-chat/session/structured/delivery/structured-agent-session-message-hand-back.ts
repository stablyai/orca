import { agentSessionAttachmentUploadIdOfPath } from '../../../../../../../shared/agent-session/agent-session-attachments'
import { formatNativeChatFileReference } from '../../../../../../../shared/native-chat/input/composer/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import {
  commitNativeChatExpiredUploadRestore,
  planNativeChatExpiredUploadRestore
} from '../../../drafts/native-chat-expired-upload-restore'
import type { AgentJournalMessageItem } from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatComposerDraftImage } from '../../../drafts/native-chat-composer-draft-storage'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from '../../../drafts/native-chat-composer-draft-store'
import { currentDraftScope } from '../../../drafts/native-chat-launch-draft-source'
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
  uploadSessionId?: string,
  /** Receives the expired upload ids that came back as their originals. */
  restoredUploadIds?: Set<string>
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
  // An expired upload this conversation made, whose original is still staged and readable anywhere
  // (here, or still at a pending worktree's source), comes back as that original. It becomes this
  // draft's only once the installed draft holds it, so a draft that took nothing takes no ownership.
  // This is the only restore: nothing rewrites the person's draft later. Any other expired upload asks
  // to be attached again.
  const plan = uploadSessionId
    ? planNativeChatExpiredUploadRestore(uploadSessionId, [
        ...blocks.flatMap((block) =>
          block.type === 'image-ref' && block.path && expired(block.path) ? [block.path] : []
        ),
        ...nativeChatTextAttachmentParts(messageText, true, expired).flatMap((part) =>
          part.path ? [part.path] : []
        )
      ])
    : undefined
  const restored = new Map([...(plan ?? [])].map(([host, { origin }]) => [host, origin.source]))
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
  const durable = appendToNativeChatComposerDraft(composerScopeKey, {
    text,
    images,
    ...(skills?.length
      ? { document: seedPromptSkillReferences(promptTextContent(text), skills) }
      : {})
  })
  if (plan?.size) {
    const installed = readNativeChatComposerDraft(composerScopeKey)
    const held = (original: string): boolean =>
      installed.images.some(({ path }) => path === original) ||
      nativeChatTextAttachmentParts(installed.text, true, (path) => path === original).some(
        (part) => part.path
      )
    const committed = commitNativeChatExpiredUploadRestore(
      currentDraftScope(composerScopeKey),
      plan,
      held
    )
    for (const host of committed) {
      const uploadId = agentSessionAttachmentUploadIdOfPath(host)
      if (uploadId) {
        restoredUploadIds?.add(uploadId)
      }
    }
  }
  return durable
}

/** Return unaccepted input to its conversation draft even when unmounted; true means durable. */
export function handBackStructuredAgentSessionMessage(
  sessionId: string,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  imageConnectionIds?: readonly (string | null)[],
  expiredUploadIds?: ReadonlySet<string>,
  restoredUploadIds?: Set<string>
): boolean {
  return returnMessageToComposer(
    structuredAgentSessionDraftScopeKey(sessionId),
    `returned-${clientMessageId}`,
    body.blocks,
    imageConnectionIds,
    expiredUploadIds,
    body.skills,
    sessionId,
    restoredUploadIds
  )
}
