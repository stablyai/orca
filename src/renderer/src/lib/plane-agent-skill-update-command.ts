import type { DiscoveredSkill } from '../../../shared/skills'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  hasInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import {
  PLANE_TICKETS_SKILL_NAME,
  PLANE_TICKETS_SKILL_UPDATE_COMMAND,
  ORCA_PLANE_SKILL_NAME,
  ORCA_PLANE_SKILL_UPDATE_COMMAND
} from '@/lib/agent-feature-install-commands'

export type PlaneAgentSkillUpdateTarget = {
  skillName: typeof ORCA_PLANE_SKILL_NAME | typeof PLANE_TICKETS_SKILL_NAME
  command: string
}

// Why: legacy-only installs must update and report freshness for the installed
// legacy skill, while fresh/canonical/both-name states use the canonical name.
export function getPlaneAgentSkillUpdateTarget(
  skills: readonly DiscoveredSkill[],
  installed: boolean
): PlaneAgentSkillUpdateTarget {
  const canonicalSkillInstalled = hasInstalledAgentSkill(skills, ORCA_PLANE_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const legacySkillInstalled = hasInstalledAgentSkill(skills, PLANE_TICKETS_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  return !installed || canonicalSkillInstalled || !legacySkillInstalled
    ? { skillName: ORCA_PLANE_SKILL_NAME, command: ORCA_PLANE_SKILL_UPDATE_COMMAND }
    : { skillName: PLANE_TICKETS_SKILL_NAME, command: PLANE_TICKETS_SKILL_UPDATE_COMMAND }
}

export function getPlaneAgentSkillUpdateCommand(
  skills: readonly DiscoveredSkill[],
  installed: boolean
): string {
  return getPlaneAgentSkillUpdateTarget(skills, installed).command
}
