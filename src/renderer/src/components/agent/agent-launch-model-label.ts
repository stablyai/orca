import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'

/** A model's name as the agent's catalog lists it, else its id. */
export function launchModelLabel(agent: string, model: string | undefined): string | undefined {
  return (
    getAgentSessionOptionLaunchCatalog(agent)?.models.find((entry) => entry.id === model)?.label ??
    model
  )
}
