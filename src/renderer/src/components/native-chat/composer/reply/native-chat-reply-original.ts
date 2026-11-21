import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import { withoutNativeChatVisualDirectiveLines } from '../../../../../../shared/native-chat/visuals/native-chat-visual-directive'
import { nativeChatMessageRowBlocks } from '../../messages/rows/native-chat-message-row-words'
import { nativeChatReplyExcerpt } from './native-chat-reply-quote'

const collapsed = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Each message's excerpt, collapsed, by its blocks: a transcript update rescans only changed messages. */
const excerpts = new WeakMap<readonly NativeChatBlock[], string>()

/** The excerpt Reply takes from a message today: the words its row draws (no sent-image markers or
 *  empty blocks), and for an agent without visual directive lines. */
function excerptOf(message: Pick<NativeChatMessage, 'role' | 'blocks'>): string {
  const cached = excerpts.get(message.blocks)
  if (cached !== undefined) {
    return cached
  }
  const words = deriveNativeChatRowContent(nativeChatMessageRowBlocks(message)).markdown
  const excerpt = collapsed(
    nativeChatReplyExcerpt(
      message.role === 'assistant' ? withoutNativeChatVisualDirectiveLines(words) : words
    )
  )
  excerpts.set(message.blocks, excerpt)
  return excerpt
}

/** A reply restored from sent text that this client did not send names no message: the one message
 *  by its author whose own words, not a quote it carries, are the excerpt. With two such messages the
 *  original can't be told apart, so it counts as unavailable rather than risking the wrong one. */
export function nativeChatReplyOriginalId(
  messages: readonly Pick<NativeChatMessage, 'id' | 'role' | 'blocks'>[],
  { author, excerpt }: { author: 'agent' | 'user'; excerpt: string }
): string | null {
  const role = author === 'agent' ? 'assistant' : 'user'
  // The same excerpt the message would give today: a literal "…" or a cut both have to agree.
  const quoted = collapsed(excerpt)
  if (quoted === '') {
    return null
  }
  let found: string | null = null
  for (const message of messages) {
    if (message.role !== role || excerptOf(message) !== quoted) {
      continue
    }
    if (found !== null) {
      return null
    }
    found = message.id
  }
  return found
}

/** The message a reply's strip shows: a known original only while it is loaded, never another
 *  message with the same words; a reply that names none is found by its words. */
export function nativeChatReplyRevealId(
  target: { messageId: string; author: 'agent' | 'user'; excerpt: string },
  isLoaded: (messageId: string) => boolean,
  loadedMessages: () => readonly Pick<NativeChatMessage, 'id' | 'role' | 'blocks'>[]
): string | null {
  if (target.messageId) {
    return isLoaded(target.messageId) ? target.messageId : null
  }
  return nativeChatReplyOriginalId(loadedMessages(), target)
}
