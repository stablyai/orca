// Pure logic for desktop optimistic "queued" composer sends (mobile parity).
// A sent prompt is echoed immediately as a queued entry and pruned once its real
// user turn lands in the transcript. Kept separate from the view so the prune
// rule (match on normalized user-message text) is unit-testable without React.

import { isTextBlock, type NativeChatMessage } from '../../../../shared/native-chat-types'

/** An optimistic, not-yet-confirmed composer send. */
export type NativeChatPendingSend = {
  /** Renderer-minted id, unique per send, used as the list key. */
  id: string
  /** The exact draft text the user submitted. */
  text: string
  /** Epoch ms when the send was issued, so the queued bubble sorts to the end. */
  sentAt: number
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** The prose of a user message, normalized for matching against a pending send. */
function userMessageText(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  const text = message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join(' ')
  return normalize(text)
}

/**
 * Drop any pending send whose text now appears as a real user turn in the
 * transcript. Returns the same array reference when nothing changed so callers
 * can skip a state update (avoids a needless re-render).
 */
export function prunePendingSends(
  pending: NativeChatPendingSend[],
  messages: NativeChatMessage[]
): NativeChatPendingSend[] {
  if (pending.length === 0) {
    return pending
  }
  const landed = new Set<string>()
  for (const message of messages) {
    const text = userMessageText(message)
    if (text) {
      landed.add(text)
    }
  }
  const next = pending.filter((entry) => !landed.has(normalize(entry.text)))
  return next.length === pending.length ? pending : next
}

/**
 * Turn pending sends into chat messages so they render in the list as queued
 * user bubbles. They carry the `scrape` source (lowest priority) so the real
 * transcript turn always supersedes them if both are briefly present, and the
 * send time as the timestamp so they sort to the end (most recent) of the list.
 */
export function pendingSendsAsMessages(pending: NativeChatPendingSend[]): NativeChatMessage[] {
  return pending.map((entry) => ({
    id: `pending:${entry.id}`,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: entry.text }],
    timestamp: entry.sentAt,
    source: 'scrape' as const
  }))
}

/** True when a message id was minted for an optimistic pending send. */
export function isPendingMessageId(id: string): boolean {
  return id.startsWith('pending:')
}

/** A locally-recorded slash command (e.g. `/clear`). Slash commands dispatch to
 *  the agent's TUI and are not chat turns, so we surface a small system line as
 *  feedback that the command ran rather than echoing a user bubble. */
export type NativeChatCommandMarker = {
  id: string
  /** The command as typed, e.g. `/clear`. */
  command: string
  sentAt: number
}

/** Render command markers as compact `system` messages. The `system` role draws
 *  as a muted aside (not a user bubble); the text avoids the harness noise
 *  prefixes so stripNoiseMessages keeps it. */
export function commandMarkersAsMessages(
  markers: readonly NativeChatCommandMarker[]
): NativeChatMessage[] {
  return markers.map((marker) => ({
    id: `command:${marker.id}`,
    role: 'system' as const,
    blocks: [{ type: 'text' as const, text: `Ran ${marker.command}` }],
    timestamp: marker.sentAt,
    source: 'scrape' as const
  }))
}

/** True when a message id was minted for a slash-command marker. */
export function isCommandMarkerId(id: string): boolean {
  return id.startsWith('command:')
}
