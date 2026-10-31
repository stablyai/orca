import { nativeChatContinuationSendText } from './native-chat-continuation-send'
import type { NativeChatMessage } from './native-chat-types'
import {
  advancedNativeChatUserContentCounts,
  advancedNativeChatUserRows,
  matchingNativeChatUserContentCounts,
  matchingNativeChatUserRows,
  nativeChatPendingContentKey,
  nativeChatPendingMatchKey,
  nativeChatPendingMatchingAfter,
  nativeChatPendingOccurrence,
  selectPendingIndicesRepresentedByUserRows,
  type NativeChatGluedUserRow,
  type NativeChatUserRow
} from './native-chat-pending-occurrence'

// Bounds reconciliation cost; each open send rescans the transcript.
export const NATIVE_CHAT_PENDING_SEND_LIMIT = 8

export type NativeChatPendingSend = {
  id: string
  /** Definite send outcome; absent while the send is simply awaiting its transcript row. */
  delivery?: 'unconfirmed' | 'rejected'
  recovery?: true
  /** When a write's acknowledgment was lost, so a remount keeps the original hold deadline. */
  writeUnconfirmedAt?: number
  text: string
  imagePaths?: string[]
  /** Epoch ms when the send was issued, so the queued bubble sorts to the end. */
  sentAt: number
  /** Match only after the last authoritative row at send time so repeated prompts cannot bind older turns. */
  afterMessageId?: string | null
  /** Timestamp of that boundary in the transcript host's clock domain. */
  afterMessageTimestamp?: number | null
  /** An authoritative empty read proves all session rows are newer; loading or absent sessions cannot claim this. */
  afterEmptyTranscriptSessionId?: string
  /** 1-based occurrence among identical sends sharing the same boundary. */
  matchingOccurrence?: number
  /** Shared time boundary when that message boundary is unavailable. */
  matchingAfterTimestamp?: number
}

function messagesAfterPendingBoundary(
  messages: readonly NativeChatMessage[],
  pending: NativeChatPendingSend
): readonly NativeChatMessage[] {
  if (pending.afterMessageId === undefined) {
    return messages
  }
  if (pending.afterMessageId === null) {
    // Why: the send time is this client's clock and row timestamps are the host's (#11519).
    return pending.afterEmptyTranscriptSessionId
      ? messages
      : messages.filter((message) => messageIsAfterPendingTimestamp(message, pending))
  }
  const boundaryIndex = messages.findIndex((message) => message.id === pending.afterMessageId)
  if (boundaryIndex !== -1) {
    return messages.slice(boundaryIndex + 1)
  }
  // If paging drops the boundary, use send time rather than binding arbitrary older identical prompts.
  return messages.filter((message) => messageIsAfterPendingTimestamp(message, pending))
}

/** Release claims from other provider sessions so resumed history cannot retire a newer identical send. */
export function releaseEmptyTranscriptClaims(
  pending: NativeChatPendingSend[],
  sessionId: string | null
): NativeChatPendingSend[] {
  if (
    !pending.some(
      (entry) =>
        entry.afterEmptyTranscriptSessionId !== undefined &&
        entry.afterEmptyTranscriptSessionId !== sessionId
    )
  ) {
    return pending
  }
  return pending.map((entry) => {
    if (
      entry.afterEmptyTranscriptSessionId === undefined ||
      entry.afterEmptyTranscriptSessionId === sessionId
    ) {
      return entry
    }
    const { afterEmptyTranscriptSessionId: _released, ...rest } = entry
    return rest
  })
}

function messageIsAfterPendingTimestamp(
  message: NativeChatMessage,
  pending: NativeChatPendingSend
): boolean {
  // Timestampless transcripts must still retire echoes or queued bubbles remain pinned forever.
  if (message.timestamp === null) {
    return true
  }
  const boundary = nativeChatPendingMatchingAfter(pending)
  // Exclude ties to existing transcript-clock boundaries; local send-time boundaries stay inclusive.
  return pending.afterMessageTimestamp == null
    ? message.timestamp >= boundary
    : message.timestamp > boundary
}

/** Require each glued send’s own boundary; missing row boundaries fall back to send time, as exact matching does (#14663). */
function gluedCandidateRows(
  messages: readonly NativeChatMessage[],
  open: readonly NativeChatPendingSend[],
  rowsOf: (messages: readonly NativeChatMessage[]) => readonly NativeChatUserRow[]
): readonly NativeChatGluedUserRow[] {
  const [oldest, ...newer] = open.map((entry) =>
    entry.afterMessageId === undefined ? { ...entry, afterMessageId: null } : entry
  )
  // Ordinary lone sends need no glue scan; continuations may finish outside this queue.
  if (!oldest || (newer.length === 0 && nativeChatContinuationSendText(oldest.text) === null)) {
    return []
  }
  const newerRowIds = newer.map(
    (entry) => new Set(rowsOf(messagesAfterPendingBoundary(messages, entry)).map((row) => row.id))
  )
  // Every candidate follows the oldest send, which always starts the run.
  return rowsOf(messagesAfterPendingBoundary(messages, oldest)).map((row) => {
    const representablePendingIndices = new Set([0])
    newerRowIds.forEach((ids, index) => {
      if (ids.has(row.id)) {
        representablePendingIndices.add(index + 1)
      }
    })
    return { text: row.text, representablePendingIndices }
  })
}

/** Keep echoes until a later non-user turn to avoid first-turn flashes during transient empty reads. */
export function prunePendingSends<T extends NativeChatPendingSend>(
  pending: T[],
  messages: readonly NativeChatMessage[]
): T[] {
  if (pending.length === 0) {
    return pending
  }
  const consumed = new Map<string, number>()
  const exactKeep = pending.map((entry) => {
    const contentKey = nativeChatPendingContentKey(entry)
    const key = nativeChatPendingMatchKey(entry)
    const available =
      advancedNativeChatUserContentCounts(
        messagesAfterPendingBoundary(messages, entry),
        entry.imagePaths
      ).get(contentKey) ?? 0
    const used = consumed.get(key) ?? 0
    const occurrence = nativeChatPendingOccurrence(entry, used)
    consumed.set(key, Math.max(used, occurrence))
    return occurrence > available
  })
  // Lost Enter can glue sends into one transcript row; retire them after the assistant advances.
  const stillOpen = pending.filter((_, index) => exactKeep[index])
  const gluedRepresented = selectPendingIndicesRepresentedByUserRows(
    stillOpen,
    gluedCandidateRows(messages, stillOpen, advancedNativeChatUserRows)
  )
  const next = pending.filter((entry, index) => {
    if (!exactKeep[index]) {
      return false
    }
    const openIndex = stillOpen.indexOf(entry)
    return openIndex === -1 || !gluedRepresented.has(openIndex)
  })
  return next.length === pending.length ? pending : next
}

/** Sends whose transcript row has not landed yet; exact and glued matches both hide an echo. */
export function visibleNativeChatPendingSends<T extends NativeChatPendingSend>(
  pending: T[],
  existingMessages: readonly NativeChatMessage[]
): T[] {
  if (pending.length === 0) {
    return pending
  }
  const consumed = new Map<string, number>()
  const exactVisible = pending.map((entry) => {
    const contentKey = nativeChatPendingContentKey(entry)
    const key = nativeChatPendingMatchKey(entry)
    const represented =
      matchingNativeChatUserContentCounts(
        messagesAfterPendingBoundary(existingMessages, entry),
        entry.imagePaths
      ).get(contentKey) ?? 0
    const used = consumed.get(key) ?? 0
    const occurrence = nativeChatPendingOccurrence(entry, used)
    consumed.set(key, Math.max(used, occurrence))
    return occurrence > represented
  })
  // Hide glued echoes once their user row exists, before assistant advancement permits pruning.
  const stillVisible = pending.filter((_, index) => exactVisible[index])
  const gluedRepresented = selectPendingIndicesRepresentedByUserRows(
    stillVisible,
    gluedCandidateRows(existingMessages, stillVisible, matchingNativeChatUserRows)
  )
  return pending.filter((entry, index) => {
    if (!exactVisible[index]) {
      return false
    }
    const openIndex = stillVisible.indexOf(entry)
    return openIndex === -1 || !gluedRepresented.has(openIndex)
  })
}

/** Scrape-source echoes yield to real transcript rows; send timestamps keep queued bubbles at the end. */
export function pendingSendsAsMessages(
  pending: NativeChatPendingSend[],
  existingMessages: readonly NativeChatMessage[] = []
): NativeChatMessage[] {
  return visibleNativeChatPendingSends(pending, existingMessages).map((entry) => ({
    id: `pending:${entry.id}`,
    role: 'user' as const,
    blocks: [
      ...(entry.imagePaths ?? []).map((path) => ({ type: 'image-ref' as const, path })),
      ...(entry.text.trim().length > 0 ? [{ type: 'text' as const, text: entry.text }] : [])
    ],
    timestamp: entry.sentAt,
    source: 'scrape' as const
  }))
}

export function isPendingMessageId(id: string): boolean {
  return id.startsWith('pending:')
}
