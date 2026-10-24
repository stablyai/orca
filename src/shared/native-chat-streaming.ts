// Use status previews until transcript replies catch up; share desktop/mobile visibility to avoid duplicate bubbles.

import type { NativeChatMessage } from './native-chat-types'

/** Stable preview id across ticks lets the real turn replace it without key churn. */
export const NATIVE_CHAT_STREAMING_ID = 'streaming'

/** Concatenated text of an assistant message's text blocks, trimmed. */
function assistantText(message: NativeChatMessage | undefined): string {
  if (!message || message.role !== 'assistant') {
    return ''
  }
  return message.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim()
}

/** The newest assistant words after row `after`: read back past the tool calls and thoughts that
 *  landed after them, but never past the user's message, which starts a different reply. */
export function latestNativeChatReplyText(
  messages: readonly NativeChatMessage[],
  after = -1
): string {
  for (let index = messages.length - 1; index > after; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user') {
      return ''
    }
    const text = assistantText(message)
    if (text) {
      return text
    }
  }
  return ''
}

/** Show previews only while working and ahead of transcript text; suppress caught-up duplicates.
 * Always reject previewIsToolOutput: status stdout/errors never become assistant blocks and cannot retire through transcript catch-up. */
export function deriveNativeChatStreamingText(args: {
  messages: readonly NativeChatMessage[]
  previewText: string | null | undefined
  working: boolean
  previewIsToolOutput?: boolean
}): string | null {
  const { messages, previewText, working, previewIsToolOutput } = args
  if (!working || previewIsToolOutput) {
    return null
  }
  const text = previewText?.trim()
  if (!text) {
    return null
  }
  const lastText = assistantText(messages.at(-1))
  if (lastText.includes(text) || text.length <= lastText.length) {
    return null
  }
  // A tool call or thought after the sentence leaves the last row wordless. Hide only that same
  // sentence: a new, shorter reply after the tool is not the earlier, longer commentary.
  if (!lastText && latestNativeChatReplyText(messages).includes(text)) {
    return null
  }
  return text
}

/** Build the synthetic streaming assistant message for the given text. */
export function nativeChatStreamingMessage(text: string): NativeChatMessage {
  return {
    id: NATIVE_CHAT_STREAMING_ID,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'hook'
  }
}
