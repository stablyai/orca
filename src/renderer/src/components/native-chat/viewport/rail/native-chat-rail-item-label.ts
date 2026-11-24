import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { NativeChatRailItem } from './native-chat-message-rail-items'

export function nativeChatRailItemLabel(
  item: NativeChatRailItem,
  t: Translate = translate
): string {
  if (item.text.length > 0) {
    return item.text
  }
  return item.hasImages
    ? t('components.native-chat.railImageMessage', 'Image attachment')
    : t('components.native-chat.railEmptyMessage', 'Message')
}
