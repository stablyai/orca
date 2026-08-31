// When the trailing "…" row is allowed to render.
//
// The rule suppresses the dots once the turn's own assistant ANSWER is on screen,
// because a placeholder below streamed text reflows the list when it disappears.
// It must not suppress on a row that only reports tool work: a shell command can
// run for a minute with nothing else arriving, and that is precisely when the
// user needs to see that the turn is still alive.
//
// Both transports have to agree, and matching on `role` alone does not get there:
// the PTY path emits synthetic `command:` marker rows, while the structured path
// projects a journal tool-call item as `role: 'assistant'` with tool blocks. Same
// meaning, different shape — so the predicate is about the row's CONTENT.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'
import { isCommandMarkerId } from './native-chat-command-marker'

/** A row carrying only tool activity — no prose. It is progress, not an answer. */
function isToolActivityOnlyRow(message: NativeChatMessage): boolean {
  const blocks = message.blocks
  if (!blocks || blocks.length === 0) {
    return false
  }
  return blocks.every((block) => block.type === 'tool-call' || block.type === 'tool-result')
}

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
    if (!message || message.role === 'user' || isCommandMarkerId(message.id)) {
      return true
    }
    // Tool work is the strongest reason to KEEP the dots, so it decides here
    // rather than falling through to the assistant-role check below.
    if (isToolActivityOnlyRow(message)) {
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
