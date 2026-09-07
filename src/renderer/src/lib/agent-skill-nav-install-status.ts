import type { SkillFreshnessInventory } from '../../../shared/skill-freshness'
import type { DiscoveredSkill } from '../../../shared/skills'
import type { SettingsNavInstallStatus } from './settings-navigation-types'
import { getLinearAgentSkillUpdateTarget } from './linear-agent-skill-update-command'
import { getSkillFreshnessDisplayStatus } from './skill-freshness-display-status'

type AgentSkillNavInstallStatusInput = {
  name: string
  installed: boolean
  loading: boolean
  inventory: SkillFreshnessInventory | null
}

export function getAgentSkillNavInstallStatus({
  name,
  installed,
  loading,
  inventory
}: AgentSkillNavInstallStatusInput): SettingsNavInstallStatus {
  if (loading) {
    return 'checking'
  }
  if (!installed) {
    return 'install'
  }
  return getSkillFreshnessDisplayStatus(inventory, name)
}

export function getLinearAgentSkillNavInstallStatus(
  input: Omit<AgentSkillNavInstallStatusInput, 'name'> & {
    skills: readonly DiscoveredSkill[]
  }
): SettingsNavInstallStatus {
  // Why: the sidebar must evaluate the same installed name the card will update,
  // including legacy-only linear-tickets installs.
  const updateTarget = getLinearAgentSkillUpdateTarget(input.skills, input.installed)
  return getAgentSkillNavInstallStatus({ ...input, name: updateTarget.skillName })
}
