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

/** Assistant prose already landed for the newest turn: scan back from the tail
 *  and stop at the newest user turn, so a previous turn's reply is never mistaken
 *  for this one's. Empty when this turn has produced nothing yet. */
function landedAssistantText(messages: readonly NativeChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') {
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
 * already contained in) the reply already landed for this turn. Once the real
 * turn lands with the same (or more) text, the preview is suppressed so the
 * bubble doesn't duplicate or flicker as the transcript catches up.
 *
 * `working` gates it: a stale preview from a finished turn never shows.
 *
 * Pass only authoritative turns in `messages` — optimistic echoes are described
 * by `hasOpenOptimisticSend` instead. Threading them in as tail messages hid the
 * landed reply behind a user bubble, which kept a stale preview alive as a
 * duplicate of the turn it came from.
 */
export function deriveNativeChatStreamingText(args: {
  messages: readonly NativeChatMessage[]
  previewText: string | null | undefined
  working: boolean
  /** True while an optimistic echo is still open — its prompt has not reached the
   *  transcript, so any landed reply belongs to an earlier turn. */
  hasOpenOptimisticSend?: boolean
}): string | null {
  const { messages, previewText, working, hasOpenOptimisticSend = false } = args
  if (!working) {
    return null
  }
  const text = previewText?.trim()
  if (!text) {
    return null
  }
  const landed = landedAssistantText(messages)
  // Already in the transcript: suppress whatever the turn boundaries look like,
  // so a preview can never duplicate the turn that produced it.
  if (landed.includes(text)) {
    return null
  }
  // Length is only a "preview still leads" heuristic within one turn. An open
  // echo means `landed` is a previous turn's reply and must not gate this one.
  if (!hasOpenOptimisticSend && text.length <= landed.length) {
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
