import { translate } from '@/i18n/i18n'
import { NATIVE_CHAT_STOPPED_BEFORE_START_TEXT } from '../../../../shared/native-chat-stopped-before-start'

export function nativeChatStoppedBeforeStartLabel(): string {
  return translate(
    'components.native-chat.notices.stoppedBeforeStart',
    NATIVE_CHAT_STOPPED_BEFORE_START_TEXT
  )
}
