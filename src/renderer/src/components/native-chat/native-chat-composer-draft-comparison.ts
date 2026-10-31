import { textLeftAfterSubmission } from '../../../../shared/submitted-draft-text'
import type { JSONContent } from '@tiptap/react'
import { slicePromptDocument } from './native-chat-prompt-document-text'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage
} from './native-chat-composer-draft-storage'

/** Compare document values so adopting an equal editor copy cannot create a new unsaved change. */
export function sameNativeChatComposerDraftDocument(
  left: JSONContent | undefined,
  right: JSONContent | undefined
): boolean {
  return (
    left === right ||
    (left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right))
  )
}

export function sameNativeChatComposerDraftImages(
  left: readonly NativeChatComposerDraftImage[],
  right: readonly NativeChatComposerDraftImage[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (image, index) =>
        image.id === right[index].id &&
        image.path === right[index].path &&
        image.connectionId === right[index].connectionId &&
        image.unavailableName === right[index].unavailableName
    )
  )
}

/** After acceptance, keep inserted text and newly attached images; return null for other edits so the current draft stays intact. */
export function nativeChatComposerDraftLeftAfterSend(
  current: NativeChatComposerDraft,
  sent: NativeChatComposerDraft
): NativeChatComposerDraft | null {
  const left = textLeftAfterSubmission(current.text, sent.text)
  if (!left) {
    return null
  }
  return {
    text: left.text,
    ...(current.document
      ? { document: slicePromptDocument(current.document, left.from, left.to) }
      : {}),
    ...(current.pastedTextFiles ? { pastedTextFiles: current.pastedTextFiles } : {}),
    images: current.images.filter((image) => !sent.images.some((held) => held.id === image.id))
  }
}
