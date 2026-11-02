import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookRelayEnvelope, AgentHookSource } from '../shared/agent-hook-relay'
import type { ClaudeSettledRequest } from '../shared/agent-hook-listener/claude-settled-permission-requests'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'

export type CachedPaneEnvelopeMeta = {
  source: AgentHookSource
  env?: string
  version?: string
  claudeSettledRequests?: readonly ClaudeSettledRequest[]
}

export type CachedPaneReplaySelection = {
  event: AgentHookEventPayload
  meta: CachedPaneEnvelopeMeta
}

/** The cached row as a replay; ended Claude requests ride beside it so older receivers see one status. */
export function buildCachedPaneReplayEnvelope({
  event,
  meta
}: CachedPaneReplaySelection): AgentHookRelayEnvelope {
  const envelope = buildRelayHookEnvelope(event, meta.source, meta.env, meta.version, {
    isReplay: true
  })
  // Why not on a wait: a replayed wait replaces any held one, so the evidence would be unused.
  return meta.claudeSettledRequests && event.payload.state !== 'waiting'
    ? { ...envelope, claudeSettledRequests: meta.claudeSettledRequests }
    : envelope
}

/**
 * Chooses which cached pane statuses a reconnecting client may be re-told about, and drops the rest.
 *
 * Two panes are refused, for opposite reasons:
 * - a pane whose surface has been retired — the tab is gone, so replaying its status would hand the
 *   client a live agent pane nobody owns, which is what drives an auto-resume onto a transcript an
 *   orphaned agent is still writing;
 * - a pane whose envelope metadata is missing — the status cache and the metadata map are populated
 *   and cleared in lockstep, so a key present in one and not the other is drift. Skip rather than
 *   guess a source that mis-tags the replay downstream.
 */
export function selectReplayableCachedPanes(input: {
  cachedByPaneKey: ReadonlyMap<string, AgentHookEventPayload>
  metaByPaneKey: ReadonlyMap<string, CachedPaneEnvelopeMeta>
  isPaneSurfaceRetired: (paneKey: string) => boolean
  dropPane: (paneKey: string) => void
}): CachedPaneReplaySelection[] {
  const selected: CachedPaneReplaySelection[] = []
  // Snapshot: dropping a retired pane mutates the map being read.
  for (const [paneKey, event] of Array.from(input.cachedByPaneKey.entries())) {
    if (input.isPaneSurfaceRetired(paneKey)) {
      input.dropPane(paneKey)
      continue
    }
    const meta = input.metaByPaneKey.get(paneKey)
    if (meta) {
      selected.push({ event, meta })
    }
  }
  return selected
}

/** How many panes keep a cached status. Bounds a long-lived relay's per-pane state. */
export const MAX_CACHED_PANES = 256
