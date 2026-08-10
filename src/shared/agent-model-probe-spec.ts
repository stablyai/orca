import { getCommitMessageAgentSpec, type CommitMessageAgentSpec } from './commit-message-agent-spec'
import { DROID_MODEL_LIST_ARGS, parseDroidModelList } from './droid-model-list-probe'
import { GROK_MODEL_LIST_ARGS, parseGrokModelList } from './grok-model-list-probe'
import type { TuiAgent } from './types'

/** Why: model discovery reads only these fields; excluding the prompt-delivery
 *  half is what keeps a probe-only agent out of the commit-message registry. */
export type AgentModelProbeSpec = Omit<CommitMessageAgentSpec, 'promptDelivery' | 'buildArgs'>

/** Agents that support model discovery but are not commit-message agents. */
const MODEL_DISCOVERY_ONLY_SPECS: Partial<Record<TuiAgent, AgentModelProbeSpec>> = {
  grok: {
    id: 'grok',
    label: 'Grok',
    binary: 'grok',
    modelSource: 'dynamic',
    modelDiscovery: {
      binary: 'grok',
      args: GROK_MODEL_LIST_ARGS,
      parse: parseGrokModelList
    },
    // Why: empty so a failed probe degrades to the catalog seed instead of a
    // second model list here that can drift from it.
    models: [],
    defaultModelId: 'grok-4.5'
  },
  droid: {
    id: 'droid',
    label: 'Droid',
    binary: 'droid',
    modelSource: 'dynamic',
    modelDiscovery: {
      binary: 'droid',
      args: DROID_MODEL_LIST_ARGS,
      parse: parseDroidModelList
    },
    models: [],
    // Why: the interactive CLI's model comes from account/session settings, not a
    // flag, so no id here can be stated as the one it runs with.
    defaultModelId: ''
  }
}

export function getAgentModelProbeSpec(agentId: TuiAgent): AgentModelProbeSpec | undefined {
  return getCommitMessageAgentSpec(agentId) ?? MODEL_DISCOVERY_ONLY_SPECS[agentId]
}
