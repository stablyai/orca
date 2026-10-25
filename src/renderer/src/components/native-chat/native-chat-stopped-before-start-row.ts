import { translate } from '@/i18n/i18n'
import { isStoppedBeforeStartBlock } from '../../../../shared/native-chat-stopped-before-start'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'

export function nativeChatBlocksInOwnWords(blocks: NativeChatBlock[]): NativeChatBlock[] {
  return blocks.some(isStoppedBeforeStartBlock)
    ? blocks.map((block) =>
        isStoppedBeforeStartBlock(block)
          ? {
              type: 'text',
              text: translate(
                'components.native-chat.notices.stoppedBeforeStart',
                'Stopped manually'
              )
            }
          : block
      )
    : blocks
}
