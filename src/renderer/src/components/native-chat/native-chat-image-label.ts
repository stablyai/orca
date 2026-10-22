import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import type { NativeChatImageRefBlock } from '../../../../shared/native-chat-types'
import { isNativeChatPastedImagePath } from './native-chat-image-paste'

/** What a chat image is called where it is not drawn: its alt text, else its file's name. */
export function nativeChatImageLabel(block: NativeChatImageRefBlock): string {
  return (
    block.alt?.trim() ||
    (block.path && isNativeChatPastedImagePath(block.path)
      ? translate('components.native-chat.composer.pastedImageLabel', 'Pasted image')
      : block.path
        ? basename(block.path)
        : 'Image')
  )
}
