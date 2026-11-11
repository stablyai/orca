import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import {
  findCatalogModel,
  getAgentSessionOptionCatalog
} from '../../../../shared/agent-session/options/agent-session-option-catalog'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { agentPickerModelFromCatalogModel } from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import {
  catalogModelsFromModelDiscovery,
  mergeDiscoveredCatalogModels
} from '../../../../shared/native-chat/input/native-chat-discovered-catalog-models'
import { isNativeChatSupportedAgent } from '../../../../shared/native-chat/native-chat-agent-support'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import { discoverRuntimeCommitMessageModels } from '@/runtime/source-control/git/runtime-git-generation-client'

/** Agents with no structured chat have no host model catalog, so they list models through their CLI. */
export function agentPickerListsCliModels(entry: Pick<AgentPickerEntry, 'agent'>): boolean {
  return (
    !isNativeChatSupportedAgent(entry.agent) &&
    getAgentSessionOptionCatalog(entry.agent)?.listModels !== undefined
  )
}

export async function readAgentPickerCliModelCatalog(
  agent: AgentPickerEntry['agent'],
  runtime: RuntimeGitContext
): Promise<AgentSessionModelCatalogResult> {
  const catalog = getAgentSessionOptionCatalog(agent)
  const result = catalog ? await discoverRuntimeCommitMessageModels(runtime, agent) : null
  // Only a real listing may replace the seed: the picker retires saved picks missing from it.
  const discovered =
    result?.success && result.catalogOrigin === 'probe'
      ? catalogModelsFromModelDiscovery(agent, result)
      : null
  if (!catalog || !discovered) {
    return { origin: 'unknown' }
  }
  return {
    origin: 'probe',
    fetchedAt: Date.now(),
    models: mergeDiscoveredCatalogModels(agent, catalog, discovered).map((model) =>
      // Launch gives an unlisted model the catalog's generic options, so the picker offers the same.
      agentPickerModelFromCatalogModel(
        findCatalogModel(catalog, model.id)
          ? model
          : { ...model, options: catalog.unknownModelOptions ?? [] }
      )
    )
  }
}
