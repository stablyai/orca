import type { BundledSkillPlan } from '../../../shared/bundled-skill-plan'
import type { DiscoveredSkill } from '../../../shared/skills'
import type { SettingsNavInstallStatus } from './settings-navigation-types'
import { getLinearAgentSkillUpdateTarget } from './linear-agent-skill-update-target'
import { getSkillFreshnessDisplayStatus } from './skill-freshness-display-status'

type AgentSkillNavInstallStatusInput = {
  name: string
  installed: boolean
  loading: boolean
  plan: BundledSkillPlan | null
}

export function getAgentSkillNavInstallStatus({
  name,
  installed,
  loading,
  plan
}: AgentSkillNavInstallStatusInput): SettingsNavInstallStatus {
  if (loading) {
    return 'checking'
  }
  if (!installed) {
    return 'install'
  }
  return getSkillFreshnessDisplayStatus(plan, name)
}

export function getLinearAgentSkillNavInstallStatus(
  input: Omit<AgentSkillNavInstallStatusInput, 'name'> & {
    skills: readonly DiscoveredSkill[]
  }
): SettingsNavInstallStatus {
  // Use the card’s installed name, including legacy-only linear-tickets installs.
  const updateTarget = getLinearAgentSkillUpdateTarget(input.skills, input.installed)
  return getAgentSkillNavInstallStatus({ ...input, name: updateTarget.skillName })
}
