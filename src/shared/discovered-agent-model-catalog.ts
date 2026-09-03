import type { AgentType } from './agent-status-types'
import {
  createClaudeCatalogOptions,
  getAgentSessionOptionCatalog,
  type CatalogModel
} from './agent-session-option-catalog'
import type { CommitMessageModelCapability } from './commit-message-agent-spec'

/** The `git.discoverCommitMessageModels` payload, structurally. Declared here so
 *  mobile can read it without importing the desktop runtime client. */
export type DiscoveredAgentModelsResult =
  | {
      success: true
      models: CommitMessageModelCapability[]
      defaultModelId?: string
      /** Missing only when an older remote runtime produced the response. */
      catalogOrigin?: 'probe' | 'spec'
    }
  | { success: false; error?: string }

/**
 * The host's live model list as catalog rows, or null when the response is not
 * usable evidence. Null means "keep the seed", never "the host has no models".
 */
export function toDiscoveredCatalogModels(
  agent: AgentType,
  result: DiscoveredAgentModelsResult | null | undefined
): CatalogModel[] | null {
  if (!result?.success || result.models.length === 0) {
    return null
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  // Why: a spec's static fallback list must never pass as a probe result for an
  // agent whose published list replaces rather than extends the seed. An older
  // runtime omits catalogOrigin entirely, so absence counts as "not a probe".
  if (
    (agent === 'claude' || catalog?.discoveredModelsAreAuthoritative) &&
    result.catalogOrigin !== 'probe'
  ) {
    return null
  }
  return result.models.map((model) => ({
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true as const } : {}),
    options:
      agent === 'claude'
        ? createClaudeCatalogOptions({
            effortLevelIds: model.thinkingLevels?.map(({ id }) => id) ?? [],
            supportsFastMode: model.supportsFastMode
          })
        : []
  }))
}
