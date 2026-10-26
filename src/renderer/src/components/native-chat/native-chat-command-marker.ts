// Slash-command feedback and transcript boundaries stay separate from optimistic user-send pruning.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { setBoundedScopeCacheEntry } from '../../../../shared/native-chat-scope-cache'

/** Local slash-command feedback replaces user-turn echoes for commands dispatched into the TUI. */
export type NativeChatCommandMarker = {
  id: string
  command: string
  sentAt: number
  /** What the host answered, for a command the agent never saw. */
  output?: string
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
  sentAt = Date.now(),
  output?: string
): NativeChatCommandMarker[] {
  commandMarkerCounter += 1
  const key = commandMarkerScopeKey(scope)
  // Cache feedback across native/TUI remounts because slash commands create no transcript turn.
  const next = [
    ...(commandMarkerCache.get(key) ?? []),
    {
      id: `${sentAt}-${commandMarkerCounter}`,
      command,
      sentAt,
      ...(output === undefined ? {} : { output })
    }
  ].slice(-COMMAND_MARKER_LIMIT)
  // Bound scope keys as well as per-scope markers; changing session ids would otherwise grow the cache forever.
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
  // Hide pre-clear history immediately while the TUI asynchronously replaces or truncates its transcript.
  return messages.filter((message) => message.timestamp !== null && message.timestamp > clearSentAt)
}

/** Use system asides without harness-noise prefixes; host-answered commands show their answer instead of Ran. */
export function commandMarkersAsMessages(
  markers: readonly NativeChatCommandMarker[]
): NativeChatMessage[] {
  return markers.map((marker) => ({
    id: `command:${marker.id}`,
    role: 'system' as const,
    // Why: a host answer is one sentence, so it reads as the aside it replaces, not a grid.
    blocks: [{ type: 'text' as const, text: marker.output ?? `Ran ${marker.command}` }],
    timestamp: marker.sentAt,
    source: 'scrape' as const
  }))
}
