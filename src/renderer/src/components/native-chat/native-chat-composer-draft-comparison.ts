import type { JSONContent } from '@tiptap/react'
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
