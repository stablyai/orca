import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { ANCHORED_PENDING_ID_PREFIX, type NativeChatPendingSend } from './native-chat-pending'

/** Places the echo strictly after its anchor without reaching the next row: the
 *  list re-sorts by timestamp, and transcript rows carry whole milliseconds. */
const ANCHOR_NUDGE_MS = 0.5

/**
 * Render an optimistic echo after the row it was sent against, not at the tail.
 *
 * Claude consumes a mid-turn send through a `queued_command` attachment and
 * writes no `type:"user"` row for it, so that echo has no row to match — ever.
 * Held at the tail it re-reads below every turn of the reply it triggered, which
 * is what makes the conversation look re-ordered. Mobile anchors for the same
 * reason (`baselineTailMessageId`); desktop already records the boundary as
 * `afterMessageId` and only ever used it for matching.
 *
 * Position has to survive `orderNativeChatMessages`, which sorts by rank before
 * timestamp and pins every tail echo to rank 2 — array order alone never reaches
 * the DOM. So an anchored echo is re-minted under `pending-at:`, which the
 * assembler ranks as content, and takes its anchor's timestamp plus a nudge.
 *
 * An echo still at the tail keeps `pending:` and rank 2, so the streaming preview
 * stays ahead of it — the tier `messageSortRank` exists to hold. Only an echo the
 * transcript has moved past is repositioned. A boundary that is absent, or that
 * carries no timestamp to sort against, falls back to the tail rather than guess.
 */
export function anchorPendingMessagesToSendBoundary(
  messages: readonly NativeChatMessage[],
  pending: readonly NativeChatPendingSend[],
  pendingMessages: readonly NativeChatMessage[]
): { messages: readonly NativeChatMessage[]; trailing: readonly NativeChatMessage[] } {
  if (pendingMessages.length === 0) {
    return { messages, trailing: pendingMessages }
  }
  const boundaryByMessageId = new Map(
    pending.map((entry) => [`pending:${entry.id}`, entry.afterMessageId ?? null])
  )
  const tailId = messages.at(-1)?.id ?? null
  const anchorById = new Map(messages.map((message) => [message.id, message]))
  const anchored = new Map<string, NativeChatMessage[]>()
  const trailing: NativeChatMessage[] = []
  for (const message of pendingMessages) {
    const boundaryId = boundaryByMessageId.get(message.id) ?? null
    const anchor =
      boundaryId === null || boundaryId === tailId ? undefined : anchorById.get(boundaryId)
    if (!anchor || anchor.timestamp === null) {
      trailing.push(message)
      continue
    }
    const sharing = anchored.get(anchor.id) ?? []
    sharing.push({
      ...message,
      id: `${ANCHORED_PENDING_ID_PREFIX}${message.id.slice('pending:'.length)}`,
      timestamp: anchor.timestamp + ANCHOR_NUDGE_MS * (sharing.length + 1)
    })
    anchored.set(anchor.id, sharing)
  }
  if (anchored.size === 0) {
    return { messages, trailing }
  }
  const placed: NativeChatMessage[] = []
  for (const message of messages) {
    placed.push(message)
    const sharing = anchored.get(message.id)
    if (sharing) {
      placed.push(...sharing)
    }
  }
  return { messages: placed, trailing }
}

/** Transcript, then anything the view renders after it, then the echoes that
 *  still belong at the tail. */
export function nativeChatMessagesWithPending(
  messages: readonly NativeChatMessage[],
  pending: readonly NativeChatPendingSend[],
  pendingMessages: readonly NativeChatMessage[],
  markers: readonly NativeChatMessage[],
  streaming: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const anchored = anchorPendingMessagesToSendBoundary(messages, pending, pendingMessages)
  return [...anchored.messages, ...markers, ...streaming, ...anchored.trailing]
}
