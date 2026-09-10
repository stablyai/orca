// Shared derivation for the in-flight "streaming" assistant bubble. While an
// agent works, its hook preview (lastAssistantMessage) is shown as a synthetic
// assistant message so the user sees the reply build in real time, before the
// completed turn is flushed to the transcript. Desktop and mobile both use this
// so the show/hide rule can't drift between platforms.

import type { NativeChatMessage } from './native-chat-types'

/** The synthetic streaming bubble's stable id (kept stable so the list keys it
 *  consistently across ticks and the real turn can replace it cleanly). */
export const NATIVE_CHAT_STREAMING_ID = 'streaming'

/** Every row of the OMP RPC turn overlay (omp-rpc-turn-overlay.ts) carries this
 *  prefix. The overlay is that pane's live tail — it renders at the streaming
 *  bubble's position — so the list comparator needs one cheap test to place the
 *  whole overlay in that tier. Deliberately narrower than `omp-rpc-`, which
 *  hydrated history ids (`omp-rpc-history-N`) also start with: those ARE real
 *  conversation records and must sort on their own clocks. */
export const OMP_RPC_OVERLAY_ID_PREFIX = 'omp-rpc-overlay-'

export function isOmpRpcOverlayMessageId(id: string): boolean {
  return id.startsWith(OMP_RPC_OVERLAY_ID_PREFIX)
}

/** Concatenated text of a message's text blocks, trimmed. */
function messageText(message: NativeChatMessage): string {
  return message.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim()
}

/** Concatenated text of an assistant message's text blocks, trimmed. */
export function nativeChatAssistantText(message: NativeChatMessage | undefined): string {
  if (!message || message.role !== 'assistant') {
    return ''
  }
  return messageText(message)
}

/** Text of the most recent transcript row with the given role, scanning
 *  from the end and stopping at the first `role: 'user'` row (the boundary
 *  of the current turn) — so a stale row of that role from an earlier turn
 *  is never matched once the current turn's optimistic user echo has
 *  landed. Unlike `nativeChatAssistantText(messages.at(-1))`, which only
 *  ever checks the literal last message (correct for assistant prose, which
 *  is always the final row of a settled turn), a transcript's `reasoning`
 *  row (wave-7 decoder output) is followed by that turn's assistant reply,
 *  so it is never the last message once fully flushed — it needs a scan. */
function lastTurnMessageText(
  messages: readonly NativeChatMessage[],
  role: NativeChatMessage['role']
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === role) {
      return messageText(message)
    }
    if (message.role === 'user') {
      return ''
    }
  }
  return ''
}

/**
 * Content-only leads comparison: whether the overlay text is longer than
 * (and not already contained in) the last assistant turn's text. No
 * liveness gate — pure content coverage. For a caller whose overlay must
 * keep rendering past a lifecycle boundary (e.g. a just-completed RPC turn)
 * until the transcript demonstrably catches up, not merely until the turn
 * ends — see native-chat/omp-rpc-turn-reducer.ts, which uses this directly
 * instead of `nativeChatOverlayLeadsTranscript`.
 */
export function nativeChatOverlayLeadsTranscriptContent(args: {
  messages: readonly NativeChatMessage[]
  overlayText: string
}): boolean {
  const { messages, overlayText } = args
  const text = overlayText.trim()
  if (!text) {
    return false
  }
  const lastText = lastTurnMessageText(messages, 'assistant')
  return !(lastText.includes(text) || text.length <= lastText.length)
}

/**
 * Content-only leads comparison for the reasoning overlay: whether the
 * overlay's reasoning text is longer than (and not already contained in)
 * the transcript's own `role: 'reasoning'` row (wave-7 decoder output) for
 * the current turn. Deliberately never compares against the transcript's
 * assistant prose — thinking prose never matches an assistant reply, so
 * that compare left the reasoning overlay leading (and thus rendering)
 * forever, even long after the transcript settled the turn. See
 * `lastTurnMessageText` for the turn-boundary scan.
 */
export function nativeChatOverlayLeadsTranscriptReasoning(args: {
  messages: readonly NativeChatMessage[]
  overlayText: string
}): boolean {
  const { messages, overlayText } = args
  const text = overlayText.trim()
  if (!text) {
    return false
  }
  const lastText = lastTurnMessageText(messages, 'reasoning')
  return !(lastText.includes(text) || text.length <= lastText.length)
}

/**
 * Decide the streaming text to show, or null to show nothing: gated on
 * `working` outright (a stale preview from a finished turn never shows),
 * then on `nativeChatOverlayLeadsTranscriptContent`'s content comparison.
 * The RPC turn-stream overlay (native-chat/omp-rpc-turn-reducer.ts) calls
 * `nativeChatOverlayLeadsTranscriptContent` directly instead, since its
 * overlay must persist past `working` flipping false until the transcript
 * catches up.
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
  const text = previewText?.trim() ?? ''
  return nativeChatOverlayLeadsTranscriptContent({ messages, overlayText: text }) ? text : null
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
