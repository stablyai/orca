import {
  createClaudeCatalogOptions,
  getAgentSessionOptionCatalog,
  mergeCatalogModels,
  mergeDiscoveredAuthoritativeModels,
  type AgentSessionOptionCatalog,
  type CatalogModel
} from './agent-session-option-catalog'
import type { AgentType } from './agent-status-types'
import type { CommitMessageModelCapability } from './commit-message-agent-spec'

export type NativeChatModelDiscoveryResult =
  | {
      success: true
      models: readonly CommitMessageModelCapability[]
      /** Missing only when an older remote runtime produced the response. */
      catalogOrigin?: 'probe' | 'spec'
    }
  | { success: false }

/** The host's CLI model listing as picker models, or null when it cannot stand in for the catalog. */
export function catalogModelsFromModelDiscovery(
  agent: AgentType,
  result: NativeChatModelDiscoveryResult
): CatalogModel[] | null {
  if (
    !result.success ||
    result.models.length === 0 ||
    // Static fallback lists cannot stand in for the host's authoritative inventory.
    ((agent === 'claude' ||
      getAgentSessionOptionCatalog(agent)?.discoveredModelsAreAuthoritative) &&
      result.catalogOrigin !== 'probe')
  ) {
    return null
  }
  return result.models.map((model) => ({
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true as const } : {}),
    ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
    options:
      agent === 'claude'
        ? createClaudeCatalogOptions({
            effortLevelIds: model.thinkingLevels?.map(({ id }) => id) ?? [],
            supportsFastMode: model.supportsFastMode
          })
        : []
  }))
}

/** Discovered models as the picker lists them: Claude's own, or merged with the seed so its option menus stay. */
export function mergeDiscoveredCatalogModels(
  agent: AgentType,
  catalog: AgentSessionOptionCatalog,
  discovered: readonly CatalogModel[]
): CatalogModel[] {
  if (agent === 'claude') {
    return [...discovered]
  }
  return catalog.discoveredModelsAreAuthoritative
    ? mergeDiscoveredAuthoritativeModels(catalog.models, discovered)
    : mergeCatalogModels(catalog.models, discovered)
}
