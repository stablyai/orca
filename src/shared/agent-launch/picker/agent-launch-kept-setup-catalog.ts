import type { AgentSessionModelCatalogResult } from '../../agent-session/agent-session-wire'
import { confirmsListedEffortAtSend } from '../../agent-session/options/model-catalog/agent-model-catalog-ownership'

/** A kept setup (a bot's, an automation's) runs unattended, so it offers no unconfirmed effort
 *  that every chat it starts could be refused on. */
export function keptSetupCatalog(
  agent: string,
  catalog: AgentSessionModelCatalogResult
): AgentSessionModelCatalogResult {
  if (catalog.origin === 'unknown' || !confirmsListedEffortAtSend(agent)) {
    return catalog
  }
  return {
    ...catalog,
    models: catalog.models.map((model) => {
      if (model.effortsKnown !== false) {
        return model
      }
      const { chatEfforts: _unconfirmed, ...rest } = model
      return { ...rest, efforts: [] }
    })
  }
}
