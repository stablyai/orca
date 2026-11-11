import { nativeChatContinuationSendText } from './native-chat-continuation-send'
import { isImageRefBlock, type NativeChatMessage } from '../native-chat-types'
import { normalizedNativeChatUserMessageText } from './native-chat-image-transcript-markers'
import {
  advancedNativeChatUserContentCounts,
  advancedNativeChatUserRows,
  matchingNativeChatUserContentCounts,
  matchingNativeChatUserRows,
  nativeChatPendingContentKey,
  nativeChatPendingMatchKey,
  nativeChatPendingMatchingAfter,
  nativeChatPendingOccurrence,
  normalizeNativeChatPendingText,
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
  /** Client clock at send time; display placement never compares it with the host clock. */
  sentAt: number
  /** Host working epoch observed at send time; absent for an idle send, null for an unknown epoch. */
  queuedDuringWorkingEpoch?: number | null
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
  /** Pathless image rows already claimed by pruned sends, so this send cannot reclaim them. */
  claimedImageRowIds?: readonly string[]
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

// Pathless image rows (Claude queued prompts) cannot name their send, so each is claimed once, oldest send first.
// Failed or uncertain writes never claim one, so another send's image cannot hide them.
function claimPathlessImageRow(
  entry: NativeChatPendingSend,
  allMessages: readonly NativeChatMessage[],
  claimed: Set<string>,
  advancedOnly: boolean
): boolean {
  const count = entry.imagePaths?.filter(Boolean).length ?? 0
  if (
    count === 0 ||
    // Only a real row boundary or a proven-empty session; client-clock boundaries could bind old images.
    (typeof entry.afterMessageId !== 'string' && !entry.afterEmptyTranscriptSessionId) ||
    entry.delivery !== undefined ||
    entry.writeUnconfirmedAt !== undefined ||
    normalizeNativeChatPendingText(entry.text)
  ) {
    return false
  }
  const messages = messagesAfterPendingBoundary(allMessages, entry)
  const lastNonUser = messages.findLastIndex((message) => message.role !== 'user')
  const row = messages.find((message, index) => {
    if (
      message.role !== 'user' ||
      claimed.has(message.id) ||
      (advancedOnly && index > lastNonUser)
    ) {
      return false
    }
    const images = message.blocks.filter(isImageRefBlock)
    return (
      images.length === count &&
      images.every((image) => !image.path) &&
      !normalizedNativeChatUserMessageText(message)
    )
  })
  if (row) {
    claimed.add(row.id)
  }
  return Boolean(row)
}

function carriedImageRowClaims(pending: readonly NativeChatPendingSend[]): Set<string> {
  return new Set(pending.flatMap((entry) => entry.claimedImageRowIds ?? []))
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
  const claimedImageRows = carriedImageRowClaims(pending)
  const carriedClaimCount = claimedImageRows.size
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
    return occurrence > available && !claimPathlessImageRow(entry, messages, claimedImageRows, true)
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
  if (next.length === pending.length) {
    return pending
  }
  // Claims here retire their sends; hand them to the remaining image sends so none reuses the row.
  return claimedImageRows.size === carriedClaimCount
    ? next
    : next.map((entry) =>
        entry.imagePaths?.length ? { ...entry, claimedImageRowIds: [...claimedImageRows] } : entry
      )
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
  const claimedImageRows = carriedImageRowClaims(pending)
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
    return (
      occurrence > represented &&
      !claimPathlessImageRow(entry, existingMessages, claimedImageRows, false)
    )
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

export function nativeChatPendingSendPlacement(
  entry: Pick<NativeChatPendingSend, 'queuedDuringWorkingEpoch'>,
  workingEpoch?: number | null
): 'active' | 'queued' {
  return entry.queuedDuringWorkingEpoch !== undefined &&
    workingEpoch !== undefined &&
    (entry.queuedDuringWorkingEpoch === null ||
      workingEpoch === null ||
      entry.queuedDuringWorkingEpoch === workingEpoch)
    ? 'queued'
    : 'active'
}

/** Scrape-source echoes yield to real transcript rows. */
export function pendingSendsAsMessages(
  pending: NativeChatPendingSend[],
  existingMessages: readonly NativeChatMessage[] = [],
  workingEpoch?: number | null
): NativeChatMessage[] {
  return visibleNativeChatPendingSends(pending, existingMessages).map((entry) => ({
    id: `pending:${entry.id}`,
    role: 'user' as const,
    blocks: [
      ...(entry.imagePaths ?? []).map((path) => ({ type: 'image-ref' as const, path })),
      ...(entry.text.trim().length > 0 ? [{ type: 'text' as const, text: entry.text }] : [])
    ],
    timestamp: entry.sentAt,
    pendingSend: nativeChatPendingSendPlacement(entry, workingEpoch),
    source: 'scrape' as const
  }))
}

export function isPendingMessageId(id: string): boolean {
  return id.startsWith('pending:')
}

export function isLaunchPromptMessageId(id: string): boolean {
  return id.startsWith('launch-pending:')
}
