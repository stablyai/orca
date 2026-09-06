// Locally-recorded slash commands (e.g. `/clear`). They dispatch into the
// agent's TUI rather than the conversation, so native chat renders its own
// marker line and applies their transcript boundaries — kept out of the
// optimistic-send pruning in native-chat-pending.ts, which is a separate rule.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { translate } from '@/i18n/i18n'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

/** A locally-recorded slash command (e.g. `/clear`). Slash commands dispatch to
 *  the agent's TUI and are not chat turns, so we surface a small system line as
 *  feedback that the command ran rather than echoing a user bubble. */
export type NativeChatCommandMarker = {
  id: string
  /** The command as typed, e.g. `/clear`. */
  command: string
  sentAt: number
  /** Rendered output for commands Orca ran itself over RPC (OMP `/usage`).
   *  Absent for the PTY dispatch path, whose output lands in the TUI. */
  outputText?: string
  /** The collector hit its byte cap; rendered as a note under the output. */
  outputTruncated?: boolean
  /** False when the command completed WITHOUT invoking the model. Only set on
   *  the RPC path, where the result frame states it; the marker then shows a
   *  completion note instead of implying an agent turn. */
  agentInvoked?: boolean
}

/** Extra detail recorded for a command Orca executed over RPC rather than by
 *  typing into the PTY. */
export type NativeChatCommandMarkerOutcome = {
  outputText: string
  agentInvoked: boolean
  truncated?: boolean
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
  outcome?: NativeChatCommandMarkerOutcome
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
      ...(outcome
        ? {
            outputText: outcome.outputText,
            ...(outcome.truncated ? { outputTruncated: true } : {}),
            agentInvoked: outcome.agentInvoked
          }
        : {})
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
 *  prefixes so stripNoiseMessages keeps it. Output captured over RPC rides the
 *  same text block, so the message list's markdown renderer formats its fenced
 *  code exactly like agent prose. */
export function commandMarkersAsMessages(
  markers: readonly NativeChatCommandMarker[]
): NativeChatMessage[] {
  return markers.map((marker) => ({
    id: `command:${marker.id}`,
    role: 'system' as const,
    blocks: [{ type: 'text' as const, text: commandMarkerText(marker) }],
    timestamp: marker.sentAt,
    source: 'scrape' as const
  }))
}

/** Why translate here, not at append: markers are cached per pane and outlive
 *  a locale switch, so the text is the render-time projection of the marker. */
function commandMarkerText(marker: NativeChatCommandMarker): string {
  const parts = [
    translate('components.native-chat.commandMarker.ran', 'Ran {{command}}', {
      command: marker.command
    })
  ]
  if (marker.outputText?.trim()) {
    parts.push(marker.outputText.trim())
  }
  if (marker.outputTruncated) {
    parts.push(
      translate('components.native-chat.commandMarker.outputTruncated', '_Output truncated._')
    )
  }
  // Why: `agentInvoked:false` is the wire's own statement that no model turn
  // happened, so the marker says so explicitly rather than letting the output
  // read as an assistant reply.
  if (marker.agentInvoked === false) {
    parts.push(
      translate(
        'components.native-chat.commandMarker.localCommandNote',
        'Local command — agent not invoked'
      )
    )
  }
  return parts.join('\n\n')
}

/** True when a message id was minted for a slash-command marker. */
export function isCommandMarkerId(id: string): boolean {
  return id.startsWith('command:')
}
