import { translate } from '@/i18n/i18n'
import type { NativeChatImageRefBlock } from '../../../../shared/native-chat-types'
import {
  nativeChatImageLabel as sharedNativeChatImageLabel,
  type NativeChatImageLabelCopy
} from '../../../../shared/native-chat-image-label'

export function nativeChatImageLabelCopy(): NativeChatImageLabelCopy {
  return {
    pastedImage: translate('components.native-chat.composer.pastedImageLabel', 'Pasted image'),
    imageCount: (count) =>
      translate('components.native-chat.queuedMessages.imageCount', '{{count}} images', { count })
  }
}

export function nativeChatImageLabel(block: NativeChatImageRefBlock): string {
  return sharedNativeChatImageLabel(block, nativeChatImageLabelCopy())
}
