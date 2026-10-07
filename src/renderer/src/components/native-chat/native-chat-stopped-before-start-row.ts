import { translate } from '@/i18n/i18n'
import { isStoppedBeforeStartBlock } from '../../../../shared/native-chat-stopped-before-start'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'

/** The row after a send a Stop took back, in this client's words, drawn as any other status line. */
export function nativeChatBlocksInOwnWords(blocks: NativeChatBlock[]): NativeChatBlock[] {
  return blocks.some(isStoppedBeforeStartBlock)
    ? blocks.map((block) =>
        isStoppedBeforeStartBlock(block)
          ? {
              type: 'text',
              text: translate(
                'components.native-chat.notices.stoppedBeforeStart',
                'Stopped before the agent started'
              )
            }
          : block
      )
    : blocks
}
