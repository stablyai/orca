import type { NativeChatMessage } from './native-chat-types'
import { deriveNativeChatRowContent } from './native-chat-row-content'
import { nativeChatBlocksInOwnWords } from './native-chat/native-chat-stopped-before-start'
import { withoutNativeChatVisualDirectiveLines } from './native-chat/native-chat-visual-directive'

/** What a message's Copy action copies: its words, less any agent visual lines. */
export function nativeChatMessageCopyText(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>,
  stoppedLabel?: string
): string {
  const { markdown } = deriveNativeChatRowContent(
    nativeChatBlocksInOwnWords(message.blocks, stoppedLabel)
  )
  return message.role === 'user' ? markdown : withoutNativeChatVisualDirectiveLines(markdown)
}
