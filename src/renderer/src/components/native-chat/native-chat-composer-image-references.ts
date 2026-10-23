// The prompt's image chips, added and removed by image id in the draft that holds the image: the
// editor when it shows that draft (`input`), else the stored draft.

import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import {
  nativeChatImageRow,
  nativeChatPendingAttachmentSnapshot,
  takeNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'
import {
  imageReferenceInsertion,
  imageReferenceToken
} from '../../../../shared/native-chat-image-reference'
import { withoutImageReferenceNodes } from './native-chat-prompt-document-text'

/** A chip for each image at the caret, or after the draft when the editor takes no input. */
export function insertImageReferences(
  scopeKey: string,
  input: NativeChatComposerInput | null,
  ids: readonly string[]
): void {
  if (ids.length === 0) {
    return
  }
  const tokens = ids.map(imageReferenceToken).join(' ')
  if (!input?.insertText || input.disabled) {
    appendNativeChatDraftCache(scopeKey, tokens)
    return
  }
  const before = input.value.slice(0, input.selectionStart)
  const after = input.value.slice(input.selectionEnd)
  input.insertText(imageReferenceInsertion(before, after, ids))
}

/** Every chip of an image that left the row; ids are unique, so no other draft holds one. */
export function removeImageReferences(
  scopeKey: string,
  input: NativeChatComposerInput | null,
  attachmentId: string
): void {
  if (input?.removeImageReferences) {
    input.removeImageReferences(attachmentId)
    return
  }
  const { text, document } = readNativeChatComposerDraft(scopeKey)
  const token = imageReferenceToken(attachmentId)
  const kept = text.replaceAll(`${token} `, '').replaceAll(token, '')
  if (kept === text) {
    return
  }
  // A draft left with only the space around its chips is empty, so it is deleted.
  const change =
    kept.trim() === ''
      ? { text: '', document: undefined }
      : { text: kept, document: document && withoutImageReferenceNodes(document, attachmentId) }
  updateNativeChatComposerDraft(scopeKey, change, 'immediate')
}

/** The thumbnail row's ids. */
export function nativeChatImageRowIds(scopeKey: string): string[] {
  return nativeChatImageRow(
    readNativeChatComposerDraft(scopeKey).images,
    nativeChatPendingAttachmentSnapshot(scopeKey)
  ).map(({ id }) => id)
}

/** Runs a change to the scope's pending images. One that leaves the queue without joining the row
 *  (removed, failed, turned into a file reference, or placed over an unavailable image whose id it
 *  takes) loses its chips. */
export function settlePendingImageReferences<T>(
  scopeKey: string,
  input: NativeChatComposerInput | null,
  run: () => T
): T {
  const waiting = nativeChatPendingAttachmentSnapshot(scopeKey)
  const result = run()
  const row = nativeChatImageRowIds(scopeKey)
  for (const { id } of waiting.filter((chip) => !row.includes(chip.id))) {
    removeImageReferences(scopeKey, input, id)
  }
  return result
}

/** Takes an image still on its way, and its chips with it; undefined when it already went. */
export function takePendingImageWithReferences(
  scopeKey: string,
  input: NativeChatComposerInput | null,
  id: string
): ReturnType<typeof takeNativeChatPendingAttachment> {
  return settlePendingImageReferences(scopeKey, input, () =>
    takeNativeChatPendingAttachment(scopeKey, id)
  )
}

/** Removes an image and every chip of it, whether it is on its way or in the draft. */
export function removeImageWithReferences(
  scopeKey: string,
  input: NativeChatComposerInput | null,
  id: string
): void {
  // A chip still on its way is removed before it settles, so its file never joins the message.
  if (takePendingImageWithReferences(scopeKey, input, id)) {
    return
  }
  removeImageReferences(scopeKey, input, id)
  const images = readNativeChatComposerDraft(scopeKey).images
  updateNativeChatComposerDraft(
    scopeKey,
    { images: images.filter((image) => image.id !== id) },
    'immediate'
  )
}
