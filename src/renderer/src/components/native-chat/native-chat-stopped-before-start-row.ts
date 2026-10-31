import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { isStoppedBeforeStartBlock } from '../../../../shared/native-chat/native-chat-stopped-before-start'
import { translate } from '@/i18n/i18n'
import { NATIVE_CHAT_STOPPED_BEFORE_START_TEXT } from '../../../../shared/native-chat/native-chat-stopped-before-start'

/** The row after a send a Stop took back, in this client's words, drawn as any other status line. */
export function nativeChatBlocksInOwnWords(blocks: NativeChatBlock[]): NativeChatBlock[] {
  return blocks.some(isStoppedBeforeStartBlock)
    ? blocks.map((block) =>
        isStoppedBeforeStartBlock(block)
          ? {
              type: 'text',
              text: translate('components.native-chat.notices.stoppedBeforeStart', 'Interrupted')
            }
          : block
      )
    : blocks
}

export function nativeChatStoppedBeforeStartLabel(): string {
  return translate(
    'components.native-chat.notices.stoppedBeforeStart',
    NATIVE_CHAT_STOPPED_BEFORE_START_TEXT
  )
}
