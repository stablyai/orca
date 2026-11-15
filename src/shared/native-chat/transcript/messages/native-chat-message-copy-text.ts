import type { NativeChatMessage } from '../../native-chat-types'
import { deriveNativeChatRowContent } from '../row-content/native-chat-row-content'
import { withoutSentImagePromptMarkers } from '../images/native-chat-sent-image-prompt-markers'
import { nativeChatBlocksInOwnWords } from '../../native-chat-stopped-before-start'
import { withoutNativeChatVisualDirectiveLines } from '../../native-chat-visual-directive'

/** What a message's Copy action copies: its words, less any agent visual lines. */
export function nativeChatMessageCopyText(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>,
  stoppedLabel?: string
): string {
  const { markdown } = deriveNativeChatRowContent(
    nativeChatBlocksInOwnWords(withoutSentImagePromptMarkers(message), stoppedLabel)
  )
  return message.role === 'user' ? markdown : withoutNativeChatVisualDirectiveLines(markdown)
}
