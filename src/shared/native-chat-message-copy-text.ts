import type { NativeChatMessage } from './native-chat-types'
import { deriveNativeChatRowContent } from './native-chat-row-content'
import { nativeChatBlocksInOwnWords } from './native-chat/native-chat-stopped-before-start'
import { withoutNativeChatVisualDirectiveLines } from './native-chat/native-chat-visual-directive'
import { withoutSentImagePromptMarkers } from './native-chat/transcript/native-chat-image-transcript-markers'

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
