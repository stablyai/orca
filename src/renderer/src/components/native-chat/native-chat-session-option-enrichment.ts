import type { AgentType } from '../../../../shared/agent-status-types'
import {
  getAgentSessionOptionCatalog,
  mergeCatalogModels,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'

type CatalogEnrichmentEntry = {
  state: 'idle' | 'pending' | 'settled'
  models: CatalogModel[] | null
  listeners: Set<(models: CatalogModel[]) => void>
}

const enrichmentByAgentHost = new Map<string, CatalogEnrichmentEntry>()
export const NATIVE_CHAT_MODEL_ENRICHMENT_CACHE_MAX = 128
export const NATIVE_CHAT_MODEL_ENRICHMENT_PENDING_MAX = 8
let pendingEnrichmentCount = 0

function rememberEnrichment(key: string, entry: CatalogEnrichmentEntry): void {
  enrichmentByAgentHost.delete(key)
  enrichmentByAgentHost.set(key, entry)
  let inactiveEntries = Array.from(enrichmentByAgentHost.values()).filter(
    (candidate) => candidate.state === 'settled' && candidate.listeners.size === 0
  ).length
  while (inactiveEntries > NATIVE_CHAT_MODEL_ENRICHMENT_CACHE_MAX) {
    const oldestInactive = Array.from(enrichmentByAgentHost).find(
      ([, candidate]) => candidate.state === 'settled' && candidate.listeners.size === 0
    )
    if (!oldestInactive) {
      break
    }
    enrichmentByAgentHost.delete(oldestInactive[0])
    inactiveEntries -= 1
  }
}

function enrichmentKey(agent: AgentType, hostKey: string): string {
  return JSON.stringify([agent, hostKey])
}

export function readNativeChatEnrichedModels(
  agent: AgentType,
  hostKey: string
): CatalogModel[] | null {
  const key = enrichmentKey(agent, hostKey)
  const entry = enrichmentByAgentHost.get(key)
  if (entry) {
    rememberEnrichment(key, entry)
  }
  const models = entry?.models
  return models ? [...models] : null
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
  rememberEnrichment(key, entry)
  return () => {
    entry.listeners.delete(listener)
    if (entry.state === 'idle' && enrichmentByAgentHost.get(key) === entry) {
      enrichmentByAgentHost.delete(key)
    } else if (enrichmentByAgentHost.get(key) === entry) {
      rememberEnrichment(key, entry)
    }
  }
}

export function ensureNativeChatModelEnrichment(args: {
  agent: AgentType
  hostKey: string
  discover: () => Promise<readonly CatalogModel[] | null>
}): void {
  const catalog = getAgentSessionOptionCatalog(args.agent)
  if (!catalog?.listModels) {
    return
  }
  const key = enrichmentKey(args.agent, args.hostKey)
  const existing = enrichmentByAgentHost.get(key)
  if (existing?.state === 'pending' || existing?.state === 'settled') {
    rememberEnrichment(key, existing)
    return
  }
  if (pendingEnrichmentCount >= NATIVE_CHAT_MODEL_ENRICHMENT_PENDING_MAX) {
    return
  }
  const entry: CatalogEnrichmentEntry = existing ?? {
    state: 'idle',
    models: null,
    listeners: new Set()
  }
  entry.state = 'pending'
  pendingEnrichmentCount += 1
  rememberEnrichment(key, entry)

  // Why: model discovery must never delay rendering or launching; the seed is
  // immediately usable while this once-per-host probe runs in the background.
  let discovery: Promise<readonly CatalogModel[] | null>
  try {
    discovery = args.discover()
  } catch {
    entry.state = 'settled'
    if (enrichmentByAgentHost.get(key) === entry) {
      rememberEnrichment(key, entry)
    }
    pendingEnrichmentCount = Math.max(0, pendingEnrichmentCount - 1)
    return
  }
  void discovery
    .then((discovered) => {
      entry.state = 'settled'
      if (!discovered || discovered.length === 0) {
        return
      }
      entry.models = mergeCatalogModels(catalog.models, discovered)
      for (const listener of entry.listeners) {
        listener([...entry.models])
      }
    })
    .catch(() => {
      entry.state = 'settled'
    })
    .finally(() => {
      if (enrichmentByAgentHost.get(key) === entry) {
        rememberEnrichment(key, entry)
      }
      pendingEnrichmentCount = Math.max(0, pendingEnrichmentCount - 1)
    })
}

export function clearNativeChatModelEnrichmentForTests(): void {
  enrichmentByAgentHost.clear()
  pendingEnrichmentCount = 0
}
