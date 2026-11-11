import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { NativeChatImageRefBlock } from '../../../../../../shared/native-chat/native-chat-types'
import {
  nativeChatImageLabel as sharedNativeChatImageLabel,
  type NativeChatImageLabelCopy
} from '../../../../../../shared/native-chat/native-chat-image-label'

export function nativeChatImageLabelCopy(t: Translate = translate): NativeChatImageLabelCopy {
  return {
    pastedImage: t('components.native-chat.composer.pastedImageLabel', 'Pasted image'),
    imageCount: (count) =>
      t('components.native-chat.queuedMessages.imageCount', '{{count}} images', {
        count,
        defaultValue_one: '{{count}} image'
      })
  }
}

export function nativeChatImageLabel(block: NativeChatImageRefBlock): string {
  return sharedNativeChatImageLabel(block, nativeChatImageLabelCopy())
}
