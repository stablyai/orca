// Shared derivation for the in-flight "streaming" assistant bubble. While an
// agent works, its hook preview (lastAssistantMessage) is shown as a synthetic
// assistant message so the user sees the reply build in real time, before the
// completed turn is flushed to the transcript. Desktop and mobile both use this
// so the show/hide rule can't drift between platforms.

import type { NativeChatMessage } from './native-chat-types'

/** The synthetic streaming bubble's stable id (kept stable so the list keys it
 *  consistently across ticks and the real turn can replace it cleanly). */
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

/**
 * Decide the streaming text to show, or null to show nothing. Returns the
 * preview only while it leads the transcript — i.e. it's longer than (and not
 * already contained in) the last assistant turn. Once the real turn lands with
 * the same (or more) text, the preview is suppressed so the bubble doesn't
 * duplicate or flicker as the transcript catches up.
 *
 * `working` gates it: a stale preview from a finished turn never shows.
 *
 * `previewIsToolOutput` hard-gates it: several providers publish a tool's stdout or
 * error as `lastAssistantMessage` so status cards can preview it. That text is not the
 * reply, and it never appears in a transcript assistant block — so the catch-up rules
 * below can never retire it and it would sit in the chat until the turn ended.
 */
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
