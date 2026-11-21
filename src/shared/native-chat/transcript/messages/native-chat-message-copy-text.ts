import type { NativeChatMessage } from '../../native-chat-types'
import { deriveNativeChatRowContent } from '../row-content/native-chat-row-content'
import { nativeChatVisibleMessageBlocks } from './native-chat-sent-prompt-references'
import { nativeChatBlocksInOwnWords } from '../pending-sends/native-chat-stopped-before-start'
import { withoutNativeChatVisualDirectiveLines } from '../../visuals/native-chat-visual-directive'

/** What a message's Copy action copies: its words, less any agent visual lines. */
export function nativeChatMessageCopyText(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>,
  stoppedLabel?: string
): string {
  const { markdown } = deriveNativeChatRowContent(
    nativeChatBlocksInOwnWords(nativeChatVisibleMessageBlocks(message), stoppedLabel)
  )
  return message.role === 'user' ? markdown : withoutNativeChatVisualDirectiveLines(markdown)
}
