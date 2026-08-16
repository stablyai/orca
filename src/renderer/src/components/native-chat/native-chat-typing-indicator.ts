// When the trailing "…" row is allowed to render. The rule is pure so the two
// transports can't drift: the PTY path grows a synthetic streaming bubble while
// the structured path appends real journal items, but both mean the same thing —
// the turn's own assistant row is on screen, so a second placeholder below it is
// just an extra row that reflows the list when it later disappears.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'

export function shouldShowNativeChatTypingIndicator(args: {
  messages: readonly NativeChatMessage[]
  isWorking: boolean
}): boolean {
  if (!args.isWorking) {
    return false
  }
  const { messages } = args
  // Scan back only to the turn boundary: an assistant row from an EARLIER turn
  // must not suppress the indicator for the send the user just made.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role === 'user') {
      return true
    }
    // Status/system rows interleave mid-turn; they neither suppress nor unsuppress,
    // otherwise the dots would flicker back on between assistant chunks.
    if (message.role === 'assistant' || message.id === NATIVE_CHAT_STREAMING_ID) {
      return false
    }
  }
  return true
}
