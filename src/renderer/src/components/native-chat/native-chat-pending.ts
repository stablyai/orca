// Pure logic for desktop optimistic "queued" composer sends (mobile parity).
// A sent prompt is echoed immediately as a queued entry and pruned once its real
// user turn lands in the transcript. Kept separate from the view so the prune
// rule (match on normalized user-message content) is unit-testable without React.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'
import type { NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
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
  if (boundaryIndex >= 0) {
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
  // Why: when rapid body writes glued two optimistic sends into one transcript
  // user row ("joke"+"continue"→"jokecontinue"), exact keys never match. Drop
  // those echoes once an assistant turn advances past the glued user text.
  const stillOpen = pending.filter((_, index) => exactKeep[index])
  const gluedRepresented = selectPendingIndicesRepresentedByUserTexts(
    stillOpen,
    advancedNativeChatUserTexts(messages)
  )
  const next = pending.filter((entry, index) => {
    if (!exactKeep[index]) {
      return false
    }
    const openIndex = stillOpen.indexOf(entry)
    return openIndex < 0 || !gluedRepresented.has(openIndex)
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
  const gluedRepresented = selectPendingIndicesRepresentedByUserTexts(
    stillVisible,
    matchingNativeChatUserTexts(existingMessages)
  )
  return pending
    .filter((entry, index) => {
      if (!exactVisible[index]) {
        return false
      }
      const openIndex = stillVisible.indexOf(entry)
      return openIndex < 0 || !gluedRepresented.has(openIndex)
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

/** A locally-recorded slash command (e.g. `/clear`). Slash commands dispatch to
 *  the agent's TUI and are not chat turns, so we surface a small system line as
 *  feedback that the command ran rather than echoing a user bubble. */
export type NativeChatCommandMarker = {
  id: string
  /** The command as typed, e.g. `/clear`. */
  command: string
  sentAt: number
}

export type NativeChatCommandMarkerScope = {
  paneKey: string
  agent: string
  sessionId: string | null
}

const COMMAND_MARKER_LIMIT = 8
const commandMarkerCache = new Map<string, NativeChatCommandMarker[]>()
let commandMarkerCounter = 0

function commandMarkerScopeKey(scope: NativeChatCommandMarkerScope): string {
  return `${scope.paneKey}\0${scope.agent}\0${scope.sessionId ?? ''}`
}

export function readCommandMarkerCache(
  scope: NativeChatCommandMarkerScope
): NativeChatCommandMarker[] {
  return [...(commandMarkerCache.get(commandMarkerScopeKey(scope)) ?? [])]
}

export function appendCommandMarkerCache(
  scope: NativeChatCommandMarkerScope,
  command: string,
  sentAt = Date.now()
): NativeChatCommandMarker[] {
  commandMarkerCounter += 1
  const key = commandMarkerScopeKey(scope)
  // Why: native/TUI view switches remount the chat surface, but slash commands
  // are not transcript turns, so their local feedback needs a pane-scoped cache.
  const next = [
    ...(commandMarkerCache.get(key) ?? []),
    { id: `${sentAt}-${commandMarkerCounter}`, command, sentAt }
  ].slice(-COMMAND_MARKER_LIMIT)
  // Why: the per-key array is capped at 8, but the KEY (paneKey\0agent\0sessionId,
  // sessionId changes on every /clear) is ephemeral and was never evicted, so it
  // grew one entry per (pane, session) for the renderer's whole life. LRU-bound
  // the key count (mirrors the #7566 draft/attachment caches in this folder).
  setBoundedScopeCacheEntry(commandMarkerCache, key, next)
  return [...next]
}

export function clearCommandMarkerCacheForTests(): void {
  commandMarkerCache.clear()
  commandMarkerCounter = 0
}

function isClearCommand(command: string): boolean {
  return command.trim().toLowerCase().split(/\s+/)[0] === '/clear'
}

function latestClearSentAt(markers: readonly NativeChatCommandMarker[]): number | null {
  let latest: number | null = null
  for (const marker of markers) {
    if (isClearCommand(marker.command) && (latest === null || marker.sentAt > latest)) {
      latest = marker.sentAt
    }
  }
  return latest
}

export function applyCommandMarkerBoundaries(
  messages: readonly NativeChatMessage[],
  markers: readonly NativeChatCommandMarker[]
): NativeChatMessage[] {
  const clearSentAt = latestClearSentAt(markers)
  if (clearSentAt === null) {
    return messages as NativeChatMessage[]
  }
  // Why: `/clear` mutates the TUI/transcript asynchronously. Hide the current
  // transcript immediately so native chat reflects the command before the agent
  // writes a replacement session or truncates the file.
  return messages.filter((message) => message.timestamp !== null && message.timestamp > clearSentAt)
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
