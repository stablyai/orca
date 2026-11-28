import { useLayoutEffect, useState } from 'react'
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

/** Where the image open in a message's viewer is now, so its viewer follows it when the message's
 *  images reorder: the same block, or the image with its source at its last place, or the one image
 *  with its source. -1 once it is gone or can't be told apart. */
export function nativeChatFollowedImageIndex(
  images: readonly ImageRef[],
  block: ImageRef,
  lastIndex: number
): number {
  const last = images[lastIndex]
  if (!images.includes(block) && last && sourceOf(last) === sourceOf(block)) {
    return lastIndex
  }
  return nativeChatCapturedImageIndex(images, block)
}

/** The message's viewer state: which image is open, followed by identity as the images change, and
 *  what opens one by its place among `from` (the images as they are now, by default). */
export function useNativeChatFollowedImage(
  images: readonly ImageRef[]
): [number | null, (index: number | null, from?: readonly ImageRef[]) => void] {
  const [viewed, setViewed] = useState<{ block: ImageRef; index: number } | null>(null)
  const followed = viewed ? nativeChatFollowedImageIndex(images, viewed.block, viewed.index) : -1
  // Where it moved is where it is from now on: the next change is followed from there.
  const moved = viewed !== null && (followed !== viewed.index || images[followed] !== viewed.block)
  useLayoutEffect(() => {
    if (moved) {
      const block = followed === -1 ? undefined : images[followed]
      setViewed(block ? { block, index: followed } : null)
    }
  }, [followed, images, moved])
  const setViewing = (index: number | null, from: readonly ImageRef[] = images): void => {
    const block = index === null ? undefined : from[index]
    setViewed(block && index !== null ? { block, index } : null)
  }
  return [followed === -1 ? null : followed, setViewing]
}
