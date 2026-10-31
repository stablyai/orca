import { getRuntimePathBasename } from './cross-platform-path'
import type { NativeChatImageRefBlock } from './native-chat-types'

export type NativeChatImageLabelCopy = {
  pastedImage: string
  imageCount: (count: number) => string
}

export const NATIVE_CHAT_IMAGE_LABEL_ENGLISH: NativeChatImageLabelCopy = {
  pastedImage: 'Pasted image',
  imageCount: (count) => `${count} images`
}

/** Use friendly UI labels for Orca clipboard-image temp filenames. */
export function isNativeChatPastedImagePath(path: string): boolean {
  const base = path.split(/[\\/]/).findLast(Boolean) ?? path
  return /^orca-paste-.+\.png$/i.test(base)
}

/** What a chat image is called where it is not drawn: its alt text, else its file's name. */
export function nativeChatImageLabel(
  block: NativeChatImageRefBlock,
  copy: NativeChatImageLabelCopy
): string {
  return (
    block.alt?.trim() ||
    (block.path && isNativeChatPastedImagePath(block.path)
      ? copy.pastedImage
      : block.path
        ? getRuntimePathBasename(block.path)
        : 'Image')
  )
}
