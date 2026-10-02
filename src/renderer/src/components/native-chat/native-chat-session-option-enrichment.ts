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

export type NativeChatModelEnrichment = {
  models: CatalogModel[]
  reportedValues?: Record<string, SessionOptionValue>
}

type CatalogEnrichmentEntry = {
  agent: AgentType
  state: 'idle' | 'pending' | 'settled'
  value: NativeChatModelEnrichment | null
  listeners: Set<(value: NativeChatModelEnrichment) => void>
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
  const models = enrichmentByAgentHost.get(enrichmentKey(agent, hostKey))?.value?.models
  return models ? [...models] : null
}

export function readNativeChatEnrichedReportedValues(
  agent: AgentType,
  hostKey: string
): Record<string, SessionOptionValue> | null {
  const values = enrichmentByAgentHost.get(enrichmentKey(agent, hostKey))?.value?.reportedValues
  return values ? { ...values } : null
}

export function subscribeNativeChatEnrichedModels(
  agent: AgentType,
  hostKey: string,
  listener: (value: NativeChatModelEnrichment) => void
): () => void {
  const key = enrichmentKey(agent, hostKey)
  const entry = enrichmentByAgentHost.get(key) ?? {
    agent,
    state: 'idle' as const,
    value: null,
    listeners: new Set<(value: NativeChatModelEnrichment) => void>()
  }
  entry.listeners.add(listener)
  retainEnrichmentEntry(key, entry)
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
    if (entry.agent === agent && entry.value) {
      probed = true
      if (entry.value.models.some((model) => model.id === values.model)) {
        return values
      }
    }
  }
  return probed ? undefined : values
}

export function ensureNativeChatModelEnrichment(args: {
  agent: AgentType
  hostKey: string
  discover: () => Promise<NativeChatModelEnrichment | null>
}): void {
  const catalog = getAgentSessionOptionCatalog(args.agent)
  if (!catalog) {
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
    value: null,
    listeners: new Set()
  }
  entry.state = 'pending'
  retainEnrichmentEntry(key, entry)

  // Why: model discovery must never delay rendering or launching; the seed is
  // immediately usable while this once-per-host probe runs in the background.
  void args
    .discover()
    .then((discovered) => {
      entry.state = 'settled'
      retainEnrichmentEntry(key, entry)
      if (!discovered || discovered.models.length === 0) {
        return
      }
      entry.value = {
        // Why: the Claude probe replaces the family seed wholesale; other agents
        // merge over the seed (authoritative lists still retire absent ids).
        models:
          args.agent === 'claude'
            ? [...discovered.models]
            : catalog.discoveredModelsAreAuthoritative
              ? mergeDiscoveredAuthoritativeModels(catalog.models, discovered.models)
              : mergeCatalogModels(catalog.models, discovered.models),
        ...(discovered.reportedValues ? { reportedValues: discovered.reportedValues } : {})
      }
      for (const listener of entry.listeners) {
        listener({
          models: [...entry.value.models],
          ...(entry.value.reportedValues
            ? { reportedValues: { ...entry.value.reportedValues } }
            : {})
        })
      }
    })
    .catch(() => {
      entry.state = 'settled'
      retainEnrichmentEntry(key, entry)
    })
}

export function clearNativeChatModelEnrichmentForTests(): void {
  enrichmentByAgentHost.clear()
}

/** @internal - exposed for leak-regression tests only. */
export function getNativeChatModelEnrichmentEntryCountForTests(): number {
  return enrichmentByAgentHost.size
}
