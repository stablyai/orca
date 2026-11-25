import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'

type ImageRef = Extract<NativeChatBlock, { type: 'image-ref' }>

const sourceOf = (block: ImageRef): string => block.path ?? block.url ?? ''

/** Where an image captured earlier (by the chat's image set) is among a message's images now: the same
 *  block, or else the one image with its source. -1 when it is gone, or when several images share its
 *  source so the captured one can't be told apart. */
export function nativeChatCapturedImageIndex(images: readonly ImageRef[], block: ImageRef): number {
  const same = images.indexOf(block)
  if (same !== -1) {
    return same
  }
  const source = sourceOf(block)
  const matches = source
    ? images.flatMap((image, index) => (sourceOf(image) === source ? [index] : []))
    : []
  return matches.length === 1 ? matches[0] : -1
}
