import type { DiscoveredSkill } from '../../../shared/skills'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  hasInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import {
  buildAgentFeatureSkillInstallCommand,
  LINEAR_TICKETS_SKILL_NAME,
  ORCA_LINEAR_SKILL_NAME
} from '@/lib/agent-feature-install-commands'

export type LinearAgentSkillUpdateTarget = {
  skillName: typeof ORCA_LINEAR_SKILL_NAME | typeof LINEAR_TICKETS_SKILL_NAME
  command: string
}

// Why: legacy-only installs must update and report freshness for the installed
// legacy skill, while fresh/canonical/both-name states use the canonical name.
export function getLinearAgentSkillUpdateTarget(
  skills: readonly DiscoveredSkill[],
  installed: boolean
): LinearAgentSkillUpdateTarget {
  const canonicalSkillInstalled = hasInstalledAgentSkill(skills, ORCA_LINEAR_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const legacySkillInstalled = hasInstalledAgentSkill(skills, LINEAR_TICKETS_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const skillName =
    !installed || canonicalSkillInstalled || !legacySkillInstalled
      ? ORCA_LINEAR_SKILL_NAME
      : LINEAR_TICKETS_SKILL_NAME
  return { skillName, command: buildAgentFeatureSkillInstallCommand([skillName]) }
}

export function getLinearAgentSkillUpdateCommand(
  skills: readonly DiscoveredSkill[],
  installed: boolean
): string {
  return getLinearAgentSkillUpdateTarget(skills, installed).command
}
