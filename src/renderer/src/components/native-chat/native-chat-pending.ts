// Pure logic for desktop optimistic "queued" composer sends (mobile parity).
// A sent prompt is echoed immediately as a queued entry and pruned once its real
// user turn lands in the transcript. Kept separate from the view so the prune
// rule (match on normalized user-message content) is unit-testable without React.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'
import {
  advancedNativeChatUserContentCounts,
  advancedNativeChatUserTexts,
  assignNativeChatPendingOccurrence,
  matchingNativeChatUserContentCounts,
  matchingNativeChatUserTexts,
  nativeChatPendingContentKey,
  nativeChatPendingMatchKey,
  nativeChatPendingMatchingAfter,
  nativeChatPendingOccurrence,
  selectPendingIndicesRepresentedByUserTexts
} from './native-chat-pending-occurrence'
import type { NativeChatTranscriptOrder } from './native-chat-transcript-order'

/** An optimistic, not-yet-confirmed composer send. */
export type NativeChatPendingSend = {
  /** Renderer-minted id, unique per send, used as the list key. */
  id: string
  /** The exact draft text the user submitted. */
  text: string
  /** Image paths that were sent through the TUI image attachment paste path. */
  imagePaths?: string[]
  /** Epoch ms when the send was issued, so the queued bubble sorts to the end. */
  sentAt: number
  /** Last authoritative transcript message visible when this send was issued.
   * Matching starts after it so repeated prompts cannot bind to an old turn. */
  afterMessageId?: string | null
  /** Timestamp of that boundary in the transcript host's clock domain. */
  afterMessageTimestamp?: number | null
  /** 1-based occurrence among identical sends sharing the same boundary. */
  matchingOccurrence?: number
  /** Shared host-domain time bound when the message id boundary is paged out. */
  matchingAfterTimestamp?: number
  /** Renderer-local live-stream position captured when no transcript row exists. */
  afterTranscriptGeneration?: number
  afterTranscriptHighWater?: number
}

export type NativeChatPendingSendScope = {
  paneKey: string
  agent: string
}

const PENDING_SEND_LIMIT = 8
const pendingSendCache = new Map<string, NativeChatPendingSend[]>()
let pendingSendCounter = 0

function pendingSendScopeKey(scope: NativeChatPendingSendScope): string {
  return `${scope.paneKey}\0${scope.agent}`
}

export function readPendingSendCache(scope: NativeChatPendingSendScope): NativeChatPendingSend[] {
  return [...(pendingSendCache.get(pendingSendScopeKey(scope)) ?? [])]
}

export function writePendingSendCache(
  scope: NativeChatPendingSendScope,
  pending: NativeChatPendingSend[]
): NativeChatPendingSend[] {
  const next = pending.slice(-PENDING_SEND_LIMIT)
  const key = pendingSendScopeKey(scope)
  if (next.length === 0) {
    pendingSendCache.delete(key)
  } else {
    // Why: the empty-drain path above clears keys on the normal confirm flow,
    // but a pane closed with an unconfirmed send (agent crash / early close)
    // would strand its entry forever. LRU-bound the key count too.
    setBoundedScopeCacheEntry(pendingSendCache, key, next)
  }
  return [...next]
}

export function appendPendingSendCache(
  scope: NativeChatPendingSendScope,
  entry: NativeChatPendingSend
): NativeChatPendingSend[] {
  const existing = readPendingSendCache(scope)
  const next = assignNativeChatPendingOccurrence(existing, entry)
  return writePendingSendCache(scope, [...existing, next])
}

export function clearPendingSendCacheForTests(): void {
  pendingSendCache.clear()
  pendingSendCounter = 0
}

function messagesAfterPendingBoundary(
  messages: readonly NativeChatMessage[],
  pending: NativeChatPendingSend,
  transcriptOrder?: NativeChatTranscriptOrder
): readonly NativeChatMessage[] {
  if (
    transcriptOrder !== undefined &&
    pending.afterTranscriptGeneration !== undefined &&
    transcriptOrder.generation !== pending.afterTranscriptGeneration
  ) {
    // Pending sends are pane-local. A source rebind clears their cache; until
    // that effect runs, never match an old send against the replacement list.
    return []
  }
  if (pending.afterMessageId === undefined) {
    return messages
  }
  if (pending.afterMessageId === null) {
    if (transcriptOrder === undefined) {
      return messages
    }
    if (
      pending.afterTranscriptGeneration === undefined ||
      pending.afterTranscriptHighWater === undefined ||
      transcriptOrder.generation !== pending.afterTranscriptGeneration
    ) {
      return []
    }
    const highWater = pending.afterTranscriptHighWater
    return messages.filter((message) => {
      const sequence = transcriptOrder.messageSequenceById.get(message.id)
      return sequence !== undefined && sequence > highWater
    })
  }
  const boundaryIndex = messages.findIndex((message) => message.id === pending.afterMessageId)
  if (boundaryIndex !== -1) {
    return messages.slice(boundaryIndex + 1)
  }
  // A bounded authoritative read can page the boundary out. Use the pending
  // host-domain timestamp when available; otherwise match by identity/occurrence.
  return messages.filter((message) => messageIsAfterPendingTimestamp(message, pending))
}

function messageIsAfterPendingTimestamp(
  message: NativeChatMessage,
  pending: NativeChatPendingSend
): boolean {
  // Why: some transcripts (e.g. Grok) never carry timestamps. Excluding their
  // rows would make the echo unmatchable forever, stranding a rank-pinned
  // bubble at the list tail — which reads as the conversation reordering.
  if (message.timestamp === null) {
    // A paged-out boundary without a timestamp cannot prove post-boundary
    // ordering; treating every row as newer can retire an older identical turn.
    return false
  }
  const boundary = nativeChatPendingMatchingAfter(pending)
  // Why: `sentAt` is renderer-clock; `message.timestamp` is host/provider clock
  // on remote runtimes. Never fall back to sentAt here — a host behind strands
  // the echo forever, and a host ahead matches an older identical prompt.
  // Without a host-domain bound, identity/occurrence matching sees the full list.
  if (boundary == null) {
    return false
  }
  // A transcript-clock boundary describes an existing message, so exclude ties.
  // Inclusive only when the bound was not taken from a concrete boundary row.
  return pending.afterMessageTimestamp == null
    ? message.timestamp >= boundary
    : message.timestamp > boundary
}

/**
 * Drop any pending send only after the transcript has advanced beyond its real
 * user turn. Keeping the echo through the user-only transcript phase prevents a
 * first-turn empty-state flash if the live transcript briefly reports [] before
 * the assistant response lands.
 */
export function prunePendingSends(
  pending: NativeChatPendingSend[],
  messages: NativeChatMessage[],
  transcriptOrder?: NativeChatTranscriptOrder
): NativeChatPendingSend[] {
  if (pending.length === 0) {
    return pending
  }
  const consumed = new Map<string, number>()
  const exactKeep = pending.map((entry) => {
    const contentKey = nativeChatPendingContentKey(entry)
    const key = nativeChatPendingMatchKey(entry)
    const available =
      advancedNativeChatUserContentCounts(
        messagesAfterPendingBoundary(messages, entry, transcriptOrder)
      ).get(contentKey) ?? 0
    const used = consumed.get(key) ?? 0
    const occurrence = nativeChatPendingOccurrence(entry, used)
    consumed.set(key, Math.max(used, occurrence))
    return occurrence > available
  })
  // Why: when a lost Enter glued two optimistic sends onto one input line, the
  // transcript carries one row ("joke"+"continue"→"jokecontinue") that no exact
  // key matches. Boundary-filter per send so an older row cannot retire a
  // fresh queued pair after its transcript high-water.
  const stillOpen = pending.filter((_, index) => exactKeep[index])
  const gluedRepresented = gluedPendingIndicesAfterBoundaries(
    stillOpen,
    messages,
    transcriptOrder,
    advancedNativeChatUserTexts
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

/**
 * Turn pending sends into chat messages so they render in the list as queued
 * user bubbles. They carry the `scrape` source (lowest priority) so the real
 * transcript turn always supersedes them if both are briefly present, and the
 * send time as the timestamp so they sort to the end (most recent) of the list.
 */
export function pendingSendsAsMessages(
  pending: NativeChatPendingSend[],
  existingMessages: NativeChatMessage[] = [],
  transcriptOrder?: NativeChatTranscriptOrder
): NativeChatMessage[] {
  if (pending.length === 0) {
    return []
  }
  const consumed = new Map<string, number>()
  const exactVisible = pending.map((entry) => {
    const contentKey = nativeChatPendingContentKey(entry)
    const key = nativeChatPendingMatchKey(entry)
    const represented =
      matchingNativeChatUserContentCounts(
        messagesAfterPendingBoundary(existingMessages, entry, transcriptOrder)
      ).get(contentKey) ?? 0
    const used = consumed.get(key) ?? 0
    const occurrence = nativeChatPendingOccurrence(entry, used)
    consumed.set(key, Math.max(used, occurrence))
    return occurrence > represented
  })
  // Hide optimistic echoes that were glued into a single transcript user row
  // even before the assistant reply lands (matching, not advanced).
  const stillVisible = pending.filter((_, index) => exactVisible[index])
  const gluedRepresented = gluedPendingIndicesAfterBoundaries(
    stillVisible,
    existingMessages,
    transcriptOrder,
    matchingNativeChatUserTexts
  )
  return pending
    .filter((entry, index) => {
      if (!exactVisible[index]) {
        return false
      }
      const openIndex = stillVisible.indexOf(entry)
      return openIndex === -1 || !gluedRepresented.has(openIndex)
    })
    .map((entry) => ({
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

function pendingBoundaryKey(pending: NativeChatPendingSend): string {
  return [
    String(pending.afterMessageId),
    String(pending.afterTranscriptGeneration),
    String(pending.afterTranscriptHighWater),
    String(nativeChatPendingMatchingAfter(pending))
  ].join('\0')
}

function messagesAfterGlueBoundary(
  messages: readonly NativeChatMessage[],
  pending: NativeChatPendingSend,
  transcriptOrder: NativeChatTranscriptOrder | undefined
): readonly NativeChatMessage[] {
  if (pending.afterMessageId === undefined && transcriptOrder === undefined) {
    // No comparable transcript boundary exists in this legacy shape. Identity
    // and occurrence matching may inspect the list, but renderer sentAt must
    // never be compared with a provider timestamp.
    return []
  }
  return messagesAfterPendingBoundary(messages, pending, transcriptOrder)
}

/** Glue-match only inside each send's post-boundary window (never full history). */
function gluedPendingIndicesAfterBoundaries(
  open: readonly NativeChatPendingSend[],
  messages: readonly NativeChatMessage[],
  transcriptOrder: NativeChatTranscriptOrder | undefined,
  userTextsOf: (window: readonly NativeChatMessage[]) => readonly string[]
): Set<number> {
  const represented = new Set<number>()
  if (open.length < 2) {
    return represented
  }
  const groups = new Map<string, number[]>()
  for (let index = 0; index < open.length; index += 1) {
    const entry = open[index]
    if (!entry) {
      continue
    }
    const key = pendingBoundaryKey(entry)
    const group = groups.get(key)
    if (group) {
      group.push(index)
    } else {
      groups.set(key, [index])
    }
  }
  for (const indices of groups.values()) {
    if (indices.length < 2) {
      continue
    }
    const headIndex = indices[0]
    const head = headIndex === undefined ? undefined : open[headIndex]
    if (!head) {
      continue
    }
    const groupPending = indices.flatMap((index) => {
      const entry = open[index]
      return entry ? [entry] : []
    })
    const local = selectPendingIndicesRepresentedByUserTexts(
      groupPending,
      userTextsOf(messagesAfterGlueBoundary(messages, head, transcriptOrder))
    )
    for (const localIndex of local) {
      const openIndex = indices[localIndex]
      if (openIndex !== undefined) {
        represented.add(openIndex)
      }
    }
  }
  return represented
}

/** True when a message id was minted for an optimistic pending send. */
export function isPendingMessageId(id: string): boolean {
  return id.startsWith('pending:')
}

export function nextNativeChatPendingSendId(now = Date.now()): string {
  pendingSendCounter += 1
  return `${now}-${pendingSendCounter}`
}
