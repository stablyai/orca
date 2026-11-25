import { isTuiAgent } from '../catalog/tui-agent-config'
import {
  agentPermissionChoices,
  applyAllAgentsPermission,
  hasTypedAgentPermission,
  type AgentPermissionChoice,
  type AgentPermissionGlobalSettings
} from '../permissions/tui-agent-permission-choice'

export type AgentPermissionSeed = {
  choice: AgentPermissionChoice
  /** Keyed by the sender's agent ids, which can include agents this host doesn't know. */
  overrides: Partial<Record<string, AgentPermissionChoice>>
}

/** A host nobody has chosen a permission on: the product default for every agent. */
export function isUntouchedAgentPermission(settings: AgentPermissionGlobalSettings): boolean {
  return (
    hasTypedAgentPermission(settings) &&
    settings.agentPermissionDefault === 'full-access' &&
    Object.keys(settings.agentPermissionOverrides ?? {}).length === 0
  )
}

/** Applied inside the host's settings write, so a choice made after the caller looked always wins. */
export function seedPermissionUpdates(
  settings: AgentPermissionGlobalSettings,
  seed: AgentPermissionSeed
): AgentPermissionGlobalSettings {
  if (!isUntouchedAgentPermission(settings)) {
    return {}
  }
  const all = applyAllAgentsPermission(settings, seed.choice)
  const overrides = { ...all.agentPermissionOverrides }
  for (const [agent, choice] of Object.entries(seed.overrides)) {
    // A desktop can know agents or choices this host doesn't; those stay on the all-agents choice.
    if (isTuiAgent(agent) && choice && agentPermissionChoices(agent).includes(choice)) {
      overrides[agent] = choice
    }
  }
  return { agentPermissionDefault: all.agentPermissionDefault, agentPermissionOverrides: overrides }
}
