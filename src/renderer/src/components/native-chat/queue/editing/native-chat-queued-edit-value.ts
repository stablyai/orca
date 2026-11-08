import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage
} from '../../drafts/native-chat-composer-draft-storage'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { nativeChatPendingAttachmentSnapshot } from '../../attachments/chips/native-chat-pending-attachment-cache'
import { promptTextContent } from '../../composer/editor/native-chat-prompt-document-text'
import { nativeChatPastedTextToken } from '../../paste/native-chat-pasted-text-reference'
import { resolveNativeChatPastedText } from '../../paste/native-chat-composer-pasted-text-references'

export function sameQueuedEditImage(
  left: NativeChatComposerDraftImage,
  right: NativeChatComposerDraftImage
): boolean {
  return (
    left.id === right.id &&
    left.path === right.path &&
    left.connectionId === right.connectionId &&
    left.unavailableName === right.unavailableName
  )
}

/** Compare complete local intent independently of host capability omissions. */
export function nativeChatQueuedEditValueKey(
  scope: string,
  draft: NativeChatComposerDraft = readNativeChatComposerDraft(scope),
  pending = nativeChatPendingAttachmentSnapshot(scope)
): string {
  return JSON.stringify([
    draft.text,
    draft.document ?? promptTextContent(draft.text),
    draft.images,
    Object.entries(draft.pastedTextFiles ?? {})
      .filter(([id]) => draft.text.includes(nativeChatPastedTextToken(id)))
      .sort(([a], [b]) => a.localeCompare(b)),
    resolveNativeChatPastedText(scope, draft.text),
    pending
  ])
}
