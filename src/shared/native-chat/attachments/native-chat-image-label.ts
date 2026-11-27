import { AGENT_SESSION_PASTED_IMAGE_SUFFIX_SOURCE } from '../../agent-session/agent-session-attachments'
import { getRuntimePathBasename } from '../../file-access/cross-platform-path'
import type { NativeChatImageRefBlock } from '../native-chat-types'

export type NativeChatImageLabelCopy = {
  pastedImage: string
  imageCount: (count: number) => string
}

export const NATIVE_CHAT_IMAGE_LABEL_ENGLISH: NativeChatImageLabelCopy = {
  pastedImage: 'Pasted image',
  imageCount: (count) => `${count} images`
}

// Older terminal pastes used only a millisecond timestamp and could still appear in chat history.
const PASTED_IMAGE_NAME = new RegExp(
  `^orca-paste-(?:\\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}${AGENT_SESSION_PASTED_IMAGE_SUFFIX_SOURCE}|\\d{13}\\.png)$`,
  'i'
)

/** Use friendly UI labels for Orca clipboard-image temp filenames. */
export function isNativeChatPastedImagePath(path: string): boolean {
  return PASTED_IMAGE_NAME.test(getRuntimePathBasename(path))
}

/** True for a long text paste Orca saved as a file (`orca-paste-<ts>-<uuid>.txt`). */
export function isNativeChatPastedTextPath(path: string): boolean {
  const base = path.split(/[\\/]/).findLast(Boolean) ?? path
  return /^orca-paste-.+\.txt$/i.test(base)
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
