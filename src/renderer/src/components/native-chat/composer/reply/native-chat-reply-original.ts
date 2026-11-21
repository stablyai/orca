import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { withoutNativeChatVisualDirectiveLines } from '../../../../../../shared/native-chat/visuals/native-chat-visual-directive'
import { NATIVE_CHAT_REPLY_EXCERPT_MAX, nativeChatReplyOwnWords } from './native-chat-reply-quote'

const collapsed = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Whether `text` is the message an excerpt was taken from, judged by the message's own words only. */
function excerptMatches(excerpt: string, text: string): boolean {
  const words = nativeChatReplyOwnWords(text)
  const own = collapsed(words)
  const quoted = collapsed(excerpt)
  if (!quoted) {
    return false
  }
  if (own === quoted) {
    return true
  }
  // Only a message too long to quote whole was cut to "…"; then it has to start with what was kept.
  return (
    words.length > NATIVE_CHAT_REPLY_EXCERPT_MAX &&
    quoted.endsWith('…') &&
    own.startsWith(quoted.slice(0, -1).trimEnd())
  )
}

/** A reply restored from sent text names no message: the latest one (`messages` oldest first) by its
 *  author whose own words, not a quote it carries, are the excerpt. */
export function nativeChatReplyOriginalId(
  messages: readonly Pick<NativeChatMessage, 'id' | 'role' | 'blocks'>[],
  { author, excerpt }: { author: 'agent' | 'user'; excerpt: string }
): string | null {
  const role = author === 'agent' ? 'assistant' : 'user'
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== role) {
      continue
    }
    const words = message.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    // An agent's Reply quotes its words without visual directive lines.
    if (
      excerptMatches(
        excerpt,
        author === 'agent' ? withoutNativeChatVisualDirectiveLines(words) : words
      )
    ) {
      return message.id
    }
  }
  return null
}
