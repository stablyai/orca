import type { GlobalSettings } from '../../global-settings-types'
import { isTuiAgent } from '../catalog/tui-agent-config'
import { normalizeAgentLaunchChoices, type AgentLaunchChoices } from './agent-launch-choices'
import { resolveAgentChoiceLayers } from './agent-choice-layers'

export type ProjectAgentLaunchDefaults = {
  defaultTuiAgent?: GlobalSettings['defaultTuiAgent']
  agentLaunchChoices?: AgentLaunchChoices
}

export function normalizeProjectAgentLaunchDefaults(
  value: unknown
): ProjectAgentLaunchDefaults | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const fields = new Map(Object.entries(value))
  const agent = fields.get('defaultTuiAgent')
  const choices = normalizeAgentLaunchChoices(fields.get('agentLaunchChoices'))
  const defaults: ProjectAgentLaunchDefaults = {
    ...(agent === 'blank' || (typeof agent === 'string' && isTuiAgent(agent))
      ? { defaultTuiAgent: agent }
      : {}),
    ...(Object.keys(choices).length ? { agentLaunchChoices: choices } : {})
  }
  return Object.keys(defaults).length ? defaults : undefined
}

export function applyProjectAgentLaunchDefaults<T extends ProjectAgentLaunchDefaults>(
  settings: T,
  defaults: ProjectAgentLaunchDefaults | undefined
): T {
  if (!defaults) {
    return settings
  }
  const choices = { ...settings.agentLaunchChoices }
  for (const [agent, action] of Object.entries(defaults.agentLaunchChoices ?? {})) {
    if (isTuiAgent(agent)) {
      choices[agent] = resolveAgentChoiceLayers({
        agent,
        defaults: choices[agent],
        action,
        argumentOwner: 'defaults'
      })
    }
  }
  return {
    ...settings,
    ...(defaults.defaultTuiAgent != null ? { defaultTuiAgent: defaults.defaultTuiAgent } : {}),
    agentLaunchChoices: choices
  }
}
