// Local slash-command feedback (e.g. `/clear`) for native chat. Commands are not
// transcript turns; markers hide pre-clear rows by message id so we never compare
// renderer sentAt to host/provider timestamps (#11519).

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'
import type { NativeChatTranscriptOrder } from './native-chat-transcript-order'

export type NativeChatClearBoundary = {
  clearAfterMessageId: string | null
  clearTranscriptGeneration: number
  clearTranscriptHighWater: number
}

export type NativeChatCommandMarker = {
  id: string
  /** The command as typed, e.g. `/clear`. */
  command: string
  sentAt: number
  /** Last ordered transcript row visible when `/clear` was issued. */
  clearAfterMessageId?: string | null
  clearTranscriptGeneration?: number
  clearTranscriptHighWater?: number
  /** Pre-boundary cache shape retained for hot-reload compatibility. */
  clearedMessageIds?: readonly string[]
}

export type NativeChatCommandMarkerScope = {
  paneKey: string
  agent: string
  sessionId: string | null
  sourceKey?: string
}

const COMMAND_MARKER_LIMIT = 8
const commandMarkerCache = new Map<string, NativeChatCommandMarker[]>()
let commandMarkerCounter = 0

function commandMarkerScopeKey(scope: NativeChatCommandMarkerScope): string {
  return `${scope.paneKey}\0${scope.agent}\0${scope.sessionId ?? ''}\0${scope.sourceKey ?? ''}`
}

export function readCommandMarkerCache(
  scope: NativeChatCommandMarkerScope
): NativeChatCommandMarker[] {
  return [...(commandMarkerCache.get(commandMarkerScopeKey(scope)) ?? [])]
}

export function appendCommandMarkerCache(
  scope: NativeChatCommandMarkerScope,
  command: string,
  sentAt = Date.now(),
  clearBoundary?: NativeChatClearBoundary
): NativeChatCommandMarker[] {
  commandMarkerCounter += 1
  const key = commandMarkerScopeKey(scope)
  // Why: native/TUI view switches remount the chat surface, but slash commands
  // are not transcript turns, so their local feedback needs a pane-scoped cache.
  const next = [
    ...(commandMarkerCache.get(key) ?? []),
    {
      id: `${sentAt}-${commandMarkerCounter}`,
      command,
      sentAt,
      ...clearBoundary
    }
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

export function isNativeChatClearCommand(command: string): boolean {
  return command.trim().toLowerCase().split(/\s+/)[0] === '/clear'
}

/** Ordered transcript boundary for a `/clear`; undefined for other commands. */
export function clearBoundaryForSlashCommand(
  command: string,
  messages: readonly Pick<NativeChatMessage, 'id'>[],
  transcriptOrder: NativeChatTranscriptOrder
): NativeChatClearBoundary | undefined {
  if (!isNativeChatClearCommand(command)) {
    return undefined
  }
  return {
    clearAfterMessageId: messages.at(-1)?.id ?? null,
    clearTranscriptGeneration: transcriptOrder.generation,
    clearTranscriptHighWater: transcriptOrder.highWater
  }
}

function latestClearMarker(
  markers: readonly NativeChatCommandMarker[]
): NativeChatCommandMarker | null {
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index]
    if (marker && isNativeChatClearCommand(marker.command)) {
      return marker
    }
  }
  return null
}

export function applyCommandMarkerBoundaries(
  messages: readonly NativeChatMessage[],
  markers: readonly NativeChatCommandMarker[],
  transcriptOrder?: NativeChatTranscriptOrder
): NativeChatMessage[] {
  const clearMarker = latestClearMarker(markers)
  if (clearMarker === null) {
    return messages as NativeChatMessage[]
  }
  const boundaryId =
    clearMarker.clearAfterMessageId !== undefined
      ? clearMarker.clearAfterMessageId
      : (clearMarker.clearedMessageIds?.at(-1) ?? null)
  if (boundaryId !== null) {
    const boundaryIndex = messages.findIndex((message) => message.id === boundaryId)
    if (boundaryIndex !== -1) {
      return messages.slice(boundaryIndex + 1)
    }
  }
  if (
    transcriptOrder !== undefined &&
    clearMarker.clearTranscriptGeneration === transcriptOrder.generation &&
    clearMarker.clearTranscriptHighWater !== undefined
  ) {
    const highWater = clearMarker.clearTranscriptHighWater
    const hasPostClearSequence = [...transcriptOrder.messageSequenceById.values()].some(
      (sequence) => sequence > highWater
    )
    if (!hasPostClearSequence) {
      return messages as NativeChatMessage[]
    }
    return messages.filter((message) => {
      const sequence = transcriptOrder.messageSequenceById.get(message.id)
      return sequence !== undefined && sequence > highWater
    })
  }
  // A missing boundary can mean an empty read, pagination, or replacement.
  // Showing rows keeps the user recoverable; blanking here can persist forever.
  return messages as NativeChatMessage[]
}

/** True when the latest clear marker cannot prove which rows are post-clear. */
export function hasUnavailableNativeChatClearBoundary(
  messages: readonly NativeChatMessage[],
  markers: readonly NativeChatCommandMarker[],
  transcriptOrder?: NativeChatTranscriptOrder
): boolean {
  const clearMarker = latestClearMarker(markers)
  if (clearMarker === null) {
    return false
  }
  const boundaryId =
    clearMarker.clearAfterMessageId !== undefined
      ? clearMarker.clearAfterMessageId
      : (clearMarker.clearedMessageIds?.at(-1) ?? null)
  if (boundaryId !== null && messages.some((message) => message.id === boundaryId)) {
    return false
  }
  if (
    transcriptOrder !== undefined &&
    clearMarker.clearTranscriptGeneration === transcriptOrder.generation &&
    clearMarker.clearTranscriptHighWater !== undefined
  ) {
    const hasPostClearSequence = [...transcriptOrder.messageSequenceById.values()].some(
      (sequence) => sequence > clearMarker.clearTranscriptHighWater!
    )
    return !hasPostClearSequence
  }
  return true
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
