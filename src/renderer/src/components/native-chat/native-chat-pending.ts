// Pure logic for desktop optimistic "queued" composer sends (mobile parity).
// A sent prompt is echoed immediately as a queued entry and pruned once its real
// user turn lands in the transcript. Kept separate from the view so the prune
// rule (match on normalized user-message content) is unit-testable without React.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'
import type { NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import {
  advancedNativeChatUserContentCounts,
  advancedNativeChatUserRows,
  assignNativeChatPendingOccurrence,
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
  /** Shared time boundary when that message boundary is unavailable. */
  matchingAfterTimestamp?: number
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
  pending: NativeChatPendingSend
): readonly NativeChatMessage[] {
  if (pending.afterMessageId === undefined) {
    return messages
  }
  if (pending.afterMessageId === null) {
    return messages.filter((message) => messageIsAfterPendingTimestamp(message, pending))
  }
  const boundaryIndex = messages.findIndex((message) => message.id === pending.afterMessageId)
  if (boundaryIndex !== -1) {
    return messages.slice(boundaryIndex + 1)
  }
  // A bounded authoritative read can page the boundary out. Fall back to the
  // send time instead of matching an arbitrary older identical prompt.
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
    return true
  }
  const boundary = nativeChatPendingMatchingAfter(pending)
  // A transcript-clock boundary describes an existing message, so exclude ties.
  // Local send time has no existing record and remains inclusive.
  return pending.afterMessageTimestamp == null
    ? message.timestamp >= boundary
    : message.timestamp > boundary
}

/**
 * Rows a glue match may consume, each tagged with the sends it landed after.
 * Unbounded, an older turn whose text happens to split across the queue ("fix
 * the bug" vs "fix the" + "bug") would retire sends issued long after it — so
 * every send carries its OWN boundary into the match, not just the oldest one
 * the run starts at (#14663 pruned newer queued prompts against older rows).
 * A missing message boundary falls back to send time: a fuzzy match must never
 * reach further back than an exact one.
 */
function gluedCandidateRows(
  messages: readonly NativeChatMessage[],
  open: readonly NativeChatPendingSend[],
  rowsOf: (messages: readonly NativeChatMessage[]) => readonly NativeChatUserRow[]
): readonly NativeChatGluedUserRow[] {
  const [oldest, ...newer] = open.map((entry) =>
    entry.afterMessageId === undefined ? { ...entry, afterMessageId: null } : entry
  )
  // Glue needs a run of 2+ sends, so a lone queued echo — by far the common
  // case while an agent streams — skips the per-send boundary scans entirely.
  if (!oldest || newer.length === 0) {
    return []
  }
  const newerRowIds = newer.map(
    (entry) => new Set(rowsOf(messagesAfterPendingBoundary(messages, entry)).map((row) => row.id))
  )
  // The run always starts at the oldest open send, so its rows are the whole
  // candidate set and index 0 is representable in every one of them.
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

/**
 * Drop any pending send only after the transcript has advanced beyond its real
 * user turn. Keeping the echo through the user-only transcript phase prevents a
 * first-turn empty-state flash if the live transcript briefly reports [] before
 * the assistant response lands.
 */
export function prunePendingSends(
  pending: NativeChatPendingSend[],
  messages: NativeChatMessage[]
): NativeChatPendingSend[] {
  if (pending.length === 0) {
    return pending
  }
  const consumed = new Map<string, number>()
  const exactKeep = pending.map((entry) => {
    const contentKey = nativeChatPendingContentKey(entry)
    const key = nativeChatPendingMatchKey(entry)
    const available =
      advancedNativeChatUserContentCounts(messagesAfterPendingBoundary(messages, entry)).get(
        contentKey
      ) ?? 0
    const used = consumed.get(key) ?? 0
    const occurrence = nativeChatPendingOccurrence(entry, used)
    consumed.set(key, Math.max(used, occurrence))
    return occurrence > available
  })
  // Why: when a lost Enter glued two optimistic sends onto one input line, the
  // transcript carries one row ("joke"+"continue"→"jokecontinue") that no exact
  // key matches. Drop those echoes once an assistant turn advances past it.
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

/**
 * Turn pending sends into chat messages so they render in the list as queued
 * user bubbles. They carry the `scrape` source (lowest priority) so the real
 * transcript turn always supersedes them if both are briefly present, and the
 * send time as the timestamp so they sort to the end (most recent) of the list.
 */
export function pendingSendsAsMessages(
  pending: NativeChatPendingSend[],
  existingMessages: NativeChatMessage[] = []
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
        messagesAfterPendingBoundary(existingMessages, entry)
      ).get(contentKey) ?? 0
    const used = consumed.get(key) ?? 0
    const occurrence = nativeChatPendingOccurrence(entry, used)
    consumed.set(key, Math.max(used, occurrence))
    return occurrence > represented
  })
  // Hide optimistic echoes that were glued into a single transcript user row
  // even before the assistant reply lands (matching, not advanced).
  const stillVisible = pending.filter((_, index) => exactVisible[index])
  const gluedRepresented = selectPendingIndicesRepresentedByUserRows(
    stillVisible,
    gluedCandidateRows(existingMessages, stillVisible, matchingNativeChatUserRows)
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

/** True when a message id was minted for an optimistic pending send. */
export function isPendingMessageId(id: string): boolean {
  return id.startsWith('pending:')
}

// Why: the seeded prompt has a synthetic id that never matches the real turn's,
// so dedup/prune match on normalized user-message text instead — this hides the
// optimistic bubble once the transcript's own copy of the turn catches up.
export function launchPromptAsMessage(
  entry: NativeChatLaunchPrompt | null,
  existingMessages: NativeChatMessage[] = []
): NativeChatMessage | null {
  if (!entry) {
    return null
  }
  // Why: a launch prompt seeds a brand-new session, so a matching user turn
  // with no timestamp (e.g. Grok transcripts) can only be its own delivery.
  const represented = matchingNativeChatUserContentCounts(
    existingMessages.filter(
      (message) => message.timestamp === null || message.timestamp >= entry.createdAt
    )
  )
  if ((represented.get(nativeChatPendingContentKey(entry)) ?? 0) > 0) {
    return null
  }
  return {
    id: `launch-pending:${entry.tabId}`,
    role: 'user' as const,
    blocks: entry.text.trim().length > 0 ? [{ type: 'text' as const, text: entry.text }] : [],
    timestamp: entry.createdAt,
    source: 'scrape' as const
  }
}

// Why: prune only once an assistant turn has landed after the matching user
// text — keeping the optimistic bubble through the user-only phase avoids a
// first-turn flash before the transcript's own copy of the turn catches up.
export function shouldPruneLaunchPrompt(
  entry: NativeChatLaunchPrompt,
  messages: NativeChatMessage[]
): boolean {
  const relevant = messages.filter(
    (message) => message.timestamp === null || message.timestamp >= entry.createdAt
  )
  return (
    (advancedNativeChatUserContentCounts(relevant).get(nativeChatPendingContentKey(entry)) ?? 0) > 0
  )
}

export function nextNativeChatPendingSendId(now = Date.now()): string {
  pendingSendCounter += 1
  return `${now}-${pendingSendCounter}`
}

export function isLaunchPromptMessageId(id: string): boolean {
  return id.startsWith('launch-pending:')
}
