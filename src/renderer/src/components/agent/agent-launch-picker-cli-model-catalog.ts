import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import { independentAgentModelCatalog } from '../../../../shared/agent-session/options/agent-model-catalog-ownership'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { agentPickerModelFromCatalogModel } from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import { mergeDiscoveredCatalogModels } from '../../../../shared/native-chat/input/native-chat-discovered-catalog-models'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import { discoverNativeChatCatalogModels } from '../native-chat/session/options/catalog/native-chat-session-option-discovery'

/** Terminal-only agents the host catalog doesn't list take their models from the CLI's own listing. */
export function agentPickerListsCliModels(
  entry: Pick<AgentPickerEntry, 'agent' | 'surfaces'>
): boolean {
  return (
    !independentAgentModelCatalog(entry.agent) &&
    !entry.surfaces.includes('chat') &&
    getAgentSessionOptionCatalog(entry.agent)?.listModels !== undefined
  )
}

export async function readAgentPickerCliModelCatalog(
  agent: AgentPickerEntry['agent'],
  runtime: RuntimeGitContext
): Promise<AgentSessionModelCatalogResult> {
  const catalog = getAgentSessionOptionCatalog(agent)
  const discovered = catalog ? await discoverNativeChatCatalogModels(agent, runtime) : null
  if (!catalog || !discovered) {
    return { origin: 'unknown' }
  }
  return {
    origin: 'probe',
    fetchedAt: Date.now(),
    models: mergeDiscoveredCatalogModels(agent, catalog, discovered).map(
      agentPickerModelFromCatalogModel
    )
  }
}
