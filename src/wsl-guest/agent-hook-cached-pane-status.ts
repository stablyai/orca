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

// Skip retired pane surfaces to prevent ghost status and auto-resume onto an orphan’s live transcript.
// Missing envelope metadata means cache drift; never guess replay provenance.
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
