import type { AppState } from '@/store/types'
import { AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS, graphState } from './graph-state'
import type { AgentStatusProjectionCacheEntry } from './types'

function serializeAgentStatusEntry(
  paneKey: string,
  entry: AppState['agentStatusByPaneKey'][string]
): string {
  return JSON.stringify({
    paneKey,
    entryPaneKey: entry.paneKey,
    state: entry.state,
    workingMode: entry.workingMode ?? null,
    prompt: entry.prompt,
    updatedAtBucket: Math.floor(entry.updatedAt / AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS),
    stateStartedAt: entry.stateStartedAt,
    agentType: entry.agentType ?? null,
    terminalTitle: entry.terminalTitle ?? null,
    stateHistory: entry.stateHistory.map((history) => ({
      state: history.state,
      prompt: history.prompt,
      startedAt: history.startedAt,
      interrupted: history.interrupted ?? null
    })),
    toolName: entry.toolName ?? null,
    toolInput: entry.toolInput ?? null,
    // Include the prompt so a newly captured question re-fires mobile publication.
    interactivePrompt: entry.interactivePrompt ?? null,
    lastAssistantMessage: entry.lastAssistantMessage ?? null,
    lastAssistantMessageIsToolOutput: entry.lastAssistantMessageIsToolOutput ?? null,
    interrupted: entry.interrupted ?? null
  })
}

export function buildRuntimeMobileAgentStatusProjection(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey']
): string {
  const cached = graphState.cachedAgentStatusProjection
  if (cached?.source === agentStatusByPaneKey) {
    return cached.projection
  }

  // A status ping replaces one entry and re-spreads the map; reuse every other entry.
  const entries = new Map<string, AgentStatusProjectionCacheEntry>()
  const parts: string[] = []
  // Why tracked: if every entry was reused and the key set is unchanged, the joined
  // string is character-identical to the cached one by construction, so the join —
  // which is O(total serialized bytes of every live agent status) — can be skipped.
  let everyEntryReused = cached != null
  // Code-unit order, not `localeCompare`: this projection is only ever compared with `===`, so it
  // must be deterministic, not locale-correct — and an ICU collator per comparison is ~4.5k calls
  // per ping at the 500-entry cap.
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    const previous = cached?.entries.get(paneKey)
    const reused = previous?.entry === entry
    const entryCache = reused
      ? previous
      : { entry, projection: serializeAgentStatusEntry(paneKey, entry) }
    everyEntryReused &&= reused
    entries.set(paneKey, entryCache)
    parts.push(entryCache.projection)
  }
  // The size check covers removals; an addition already fails the reuse test above,
  // and the sort makes a matching key set imply a matching order.
  const projection =
    everyEntryReused && cached != null && entries.size === cached.entries.size
      ? cached.projection
      : `[${parts.join(',')}]`
  graphState.cachedAgentStatusProjection = {
    source: agentStatusByPaneKey,
    entries,
    projection
  }
  return projection
}

export function buildRuntimeMobileAgentStatusProjectionForTests(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey']
): string {
  return buildRuntimeMobileAgentStatusProjection(agentStatusByPaneKey)
}

export const AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS_FOR_TESTS =
  AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS

export function resetRuntimeMobileAgentStatusProjectionCacheForTests(): void {
  graphState.cachedAgentStatusProjection = null
}
