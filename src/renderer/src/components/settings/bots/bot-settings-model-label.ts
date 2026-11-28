import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import { getAgentSessionOptionLaunchCatalog } from '../../../../../shared/agent-session/options/agent-session-option-catalog'

export function botSettingsModelLabel(
  agent: string,
  catalog: AgentSessionModelCatalogResult | undefined,
  seedModel: string | undefined,
  observedModel?: string
): { id: string; label: string } | undefined {
  const listed = catalog?.origin === 'unknown' ? undefined : catalog
  const id =
    seedModel ??
    (listed?.listingNamesConfiguredModel
      ? listed.models.find(({ isDefault }) => isDefault)?.id
      : undefined)
  if (!id || (observedModel && observedModel !== id)) {
    return undefined
  }
  const label =
    listed?.models.find((model) => model.id === id)?.label ??
    getAgentSessionOptionLaunchCatalog(agent)?.models.find((model) => model.id === id)?.label ??
    id
  return { id, label }
}
