import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { NATIVE_CHAT_STOPPED_BEFORE_START_TEXT } from '../../../../../../shared/native-chat/native-chat-stopped-before-start'

export function nativeChatStoppedBeforeStartLabel(t: Translate = translate): string {
  return t(
    'components.native-chat.notices.stoppedBeforeStart',
    NATIVE_CHAT_STOPPED_BEFORE_START_TEXT
  )
}
