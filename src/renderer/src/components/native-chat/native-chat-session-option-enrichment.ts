import type { AgentType } from '../../../../shared/agent-status-types'
import {
  getAgentSessionOptionCatalog,
  mergeCatalogModels,
  mergeDiscoveredAuthoritativeModels,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import { resolveNativeChatSessionOptionDefaults } from '../../../../shared/native-chat-session-option-defaults'
import type {
  PersistedNativeChatSessionOptions,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'

type CatalogEnrichmentEntry = {
  agent: AgentType
  state: 'idle' | 'pending' | 'settled'
  models: CatalogModel[] | null
  listeners: Set<(models: CatalogModel[]) => void>
}

const enrichmentByAgentHost = new Map<string, CatalogEnrichmentEntry>()

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

export function subscribeNativeChatEnrichedModels(
  agent: AgentType,
  hostKey: string,
  listener: (models: CatalogModel[]) => void
): () => void {
  const key = enrichmentKey(agent, hostKey)
  const entry = enrichmentByAgentHost.get(key) ?? {
    agent,
    state: 'idle' as const,
    models: null,
    listeners: new Set<(models: CatalogModel[]) => void>()
  }
  entry.listeners.add(listener)
  enrichmentByAgentHost.set(key, entry)
  return () => entry.listeners.delete(listener)
}

export function resolveNativeChatLaunchSessionOptions(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  agent: AgentType
): Record<string, SessionOptionValue> | undefined {
  const values = resolveNativeChatSessionOptionDefaults(persisted, agent)
  if (!values || !getAgentSessionOptionCatalog(agent)?.discoveredModelsAreAuthoritative) {
    return values
  }
  let probed = false
  for (const entry of enrichmentByAgentHost.values()) {
    if (entry.agent === agent && entry.models) {
      probed = true
      if (entry.models.some((model) => model.id === values.model)) {
        return values
      }
    }
  }
  return probed ? undefined : values
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
    return
  }
  const entry: CatalogEnrichmentEntry = existing ?? {
    agent: args.agent,
    state: 'idle',
    models: null,
    listeners: new Set()
  }
  entry.state = 'pending'
  enrichmentByAgentHost.set(key, entry)

  // Why: model discovery must never delay rendering or launching; the seed is
  // immediately usable while this once-per-host probe runs in the background.
  void args
    .discover()
    .then((discovered) => {
      entry.state = 'settled'
      if (!discovered || discovered.length === 0) {
        return
      }
      entry.models =
        args.agent === 'claude'
          ? [...discovered]
          : catalog.discoveredModelsAreAuthoritative
            ? mergeDiscoveredAuthoritativeModels(catalog.models, discovered)
            : mergeCatalogModels(catalog.models, discovered)
      for (const listener of entry.listeners) {
        listener([...entry.models])
      }
    })
    .catch(() => {
      entry.state = 'settled'
    })
}

export function clearNativeChatModelEnrichmentForTests(): void {
  enrichmentByAgentHost.clear()
}
