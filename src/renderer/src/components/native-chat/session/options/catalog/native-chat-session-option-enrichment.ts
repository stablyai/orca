import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import { getAgentSessionOptionCatalog } from '../../../../../../../shared/agent-session/options/agent-session-option-catalog'
import type { CatalogModel } from '../../../../../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import { mergeDiscoveredCatalogModels } from '../../../../../../../shared/native-chat/input/session-options/native-chat-discovered-catalog-models'

type CatalogEnrichmentEntry = {
  state: 'idle' | 'pending' | 'settled'
  models: CatalogModel[] | null
  listeners: Set<(models: CatalogModel[]) => void>
  /** Resolves once discovery settles, also when it fails or lists nothing (which notifies no listener). */
  settled?: Promise<void>
}

const enrichmentByAgentHost = new Map<string, CatalogEnrichmentEntry>()
export const NATIVE_CHAT_MODEL_ENRICHMENT_MAX_ENTRIES = 256

function retainEnrichmentEntry(key: string, entry: CatalogEnrichmentEntry): void {
  enrichmentByAgentHost.delete(key)
  enrichmentByAgentHost.set(key, entry)
  while (enrichmentByAgentHost.size > NATIVE_CHAT_MODEL_ENRICHMENT_MAX_ENTRIES) {
    const evictable = [...enrichmentByAgentHost].find(
      ([, candidate]) => candidate.listeners.size === 0 && candidate.state !== 'pending'
    )
    if (!evictable) {
      return
    }
    enrichmentByAgentHost.delete(evictable[0])
  }
}

function enrichmentKey(agent: AgentType, hostKey: string): string {
  return JSON.stringify([agent, hostKey])
}

export function readNativeChatEnrichedModels(
  agent: AgentType,
  hostKey: string
): CatalogModel[] | null {
  const models = enrichmentByAgentHost.get(enrichmentKey(agent, hostKey))?.models
  return models ? [...models] : null
}

/** True once this host's discovery settled without a listing, or when the agent has none to discover. */
export function nativeChatModelDiscoveryListedNothing(agent: AgentType, hostKey: string): boolean {
  if (!getAgentSessionOptionCatalog(agent)?.listModels) {
    return true
  }
  const entry = enrichmentByAgentHost.get(enrichmentKey(agent, hostKey))
  return entry?.state === 'settled' && !entry.models
}

export function subscribeNativeChatEnrichedModels(
  agent: AgentType,
  hostKey: string,
  listener: (models: CatalogModel[]) => void
): () => void {
  const key = enrichmentKey(agent, hostKey)
  const entry = enrichmentByAgentHost.get(key) ?? {
    state: 'idle' as const,
    models: null,
    listeners: new Set<(models: CatalogModel[]) => void>()
  }
  entry.listeners.add(listener)
  retainEnrichmentEntry(key, entry)
  return () => entry.listeners.delete(listener)
}

export function ensureNativeChatModelEnrichment(args: {
  agent: AgentType
  hostKey: string
  discover: () => Promise<readonly CatalogModel[] | null>
}): Promise<void> {
  const catalog = getAgentSessionOptionCatalog(args.agent)
  if (!catalog?.listModels) {
    return Promise.resolve()
  }
  const key = enrichmentKey(args.agent, args.hostKey)
  const existing = enrichmentByAgentHost.get(key)
  if (existing?.state === 'pending' || existing?.state === 'settled') {
    return existing.settled ?? Promise.resolve()
  }
  const entry: CatalogEnrichmentEntry = existing ?? {
    state: 'idle',
    models: null,
    listeners: new Set()
  }
  entry.state = 'pending'
  retainEnrichmentEntry(key, entry)

  // Render and launch from the seed while once-per-host discovery runs in the background.
  entry.settled = args
    .discover()
    .then((discovered) => {
      entry.state = 'settled'
      retainEnrichmentEntry(key, entry)
      if (!discovered || discovered.length === 0) {
        return
      }
      entry.models = mergeDiscoveredCatalogModels(args.agent, catalog, discovered)
      for (const listener of entry.listeners) {
        listener([...entry.models])
      }
    })
    .catch(() => {
      entry.state = 'settled'
      retainEnrichmentEntry(key, entry)
    })
  return entry.settled
}

export function clearNativeChatModelEnrichmentForTests(): void {
  enrichmentByAgentHost.clear()
}

/** @internal - exposed for leak-regression tests only. */
export function getNativeChatModelEnrichmentEntryCountForTests(): number {
  return enrichmentByAgentHost.size
}
