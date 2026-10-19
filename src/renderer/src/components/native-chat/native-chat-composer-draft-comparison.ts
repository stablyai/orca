// How two copies of a composer draft compare, such as the draft now against the one that was sent.

import type { JSONContent } from '@tiptap/react'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage
} from './native-chat-composer-draft-storage'

/** Equal documents count as unchanged even as new objects: an editor applying the stored draft
 *  produces its own copy, which must not read as a change to save. */
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

/**
 * What a draft keeps once its send is accepted: anything added since, meaning text inserted into
 * the sent text (typing or a composition begun before the send settled) and images attached
 * meanwhile. Null when the draft was otherwise changed since (replaced, or edited inside the sent
 * text), which is then left as it is.
 */
export function nativeChatComposerDraftLeftAfterSend(
  current: NativeChatComposerDraft,
  sent: NativeChatComposerDraft
): NativeChatComposerDraft | null {
  let prefix = 0
  while (prefix < sent.text.length && sent.text[prefix] === current.text[prefix]) {
    prefix += 1
  }
  const rest = sent.text.slice(prefix)
  if (current.text.length < sent.text.length || !current.text.endsWith(rest)) {
    return null
  }
  return {
    text: current.text.slice(prefix, current.text.length - rest.length),
    images: current.images.filter((image) => !sent.images.some((held) => held.id === image.id))
  }
}
