import type { AppState } from '@/store/types'
import type { AgentMainAgentStatus } from '../../../../shared/main-agent-status'
import { programStatusFacetContent } from '../../../../shared/program-status/facet'

const AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS = 30_000

type AgentStatusProjectionCacheEntry = {
  entry: AppState['agentStatusByPaneKey'][string]
  projection: string
}
type AgentStatusProjectionCache = {
  source: AppState['agentStatusByPaneKey']
  entries: Map<string, AgentStatusProjectionCacheEntry>
  projection: string
}

let cachedAgentStatusProjection: AgentStatusProjectionCache | null = null

function mainAgentKey(mainAgent: AgentMainAgentStatus | undefined) {
  return mainAgent ? [mainAgent.state, mainAgent.outcome ?? null, mainAgent.stateStartedAt] : null
}

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
    turnStartedAt: entry.turnStartedAt ?? null,
    turnEndedAt: entry.turnEndedAt ?? null,
    turnEndDisposition: entry.turnEndDisposition ?? null,
    agentType: entry.agentType ?? null,
    terminalTitle: entry.terminalTitle ?? null,
    stateHistory: entry.stateHistory.map((history) => ({
      state: history.state,
      prompt: history.prompt,
      startedAt: history.startedAt,
      interrupted: history.interrupted ?? null,
      mainAgent: mainAgentKey(history.mainAgent)
    })),
    toolName: entry.toolName ?? null,
    toolInput: entry.toolInput ?? null,
    // Include the prompt so a newly captured question re-fires mobile publication.
    interactivePrompt: entry.interactivePrompt ?? null,
    lastAssistantMessage: entry.lastAssistantMessage ?? null,
    lastAssistantMessageIsToolOutput: entry.lastAssistantMessageIsToolOutput ?? null,
    interrupted: entry.interrupted ?? null,
    // A failure changes the verdict and leaves `interrupted` as it was.
    mainAgent: mainAgentKey(entry.mainAgent),
    programStatus: entry.programStatus ? programStatusFacetContent(entry.programStatus) : null
  })
}

export function buildRuntimeMobileAgentStatusProjection(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey']
): string {
  const cached = cachedAgentStatusProjection
  if (cached?.source === agentStatusByPaneKey) {
    return cached.projection
  }

  const nextEntries = Object.entries(agentStatusByPaneKey)
  // Equal size plus identical keyed entry references proves the same cached serialization; skip O(N log N) sort/O(bytes) join and reuse its Map.
  if (
    cached != null &&
    nextEntries.length === cached.entries.size &&
    nextEntries.every(([paneKey, entry]) => cached.entries.get(paneKey)?.entry === entry)
  ) {
    cachedAgentStatusProjection = {
      ...cached,
      source: agentStatusByPaneKey
    }
    return cached.projection
  }

  // A status ping replaces one entry and re-spreads the map; reuse every other entry.
  const entries = new Map<string, AgentStatusProjectionCacheEntry>()
  const parts: string[] = []
  let projectionUnchanged = cached != null && nextEntries.length === cached.entries.size
  // Use deterministic code-unit ordering for equality-only projections, avoiding ~4.5k ICU comparisons per ping at 500 entries.
  for (const [paneKey, entry] of nextEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const previous = cached?.entries.get(paneKey)
    const entryCache =
      previous?.entry === entry
        ? previous
        : { entry, projection: serializeAgentStatusEntry(paneKey, entry) }
    entries.set(paneKey, entryCache)
    parts.push(entryCache.projection)
    projectionUnchanged &&= previous?.projection === entryCache.projection
  }
  // Same-bucket heartbeats must not rejoin every pane's accumulated preview text.
  const projection = projectionUnchanged && cached ? cached.projection : `[${parts.join(',')}]`
  cachedAgentStatusProjection = {
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
  cachedAgentStatusProjection = null
}
