import type { DiscoveredSkill } from '../../../shared/skills'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  hasInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import {
  LINEAR_TICKETS_SKILL_NAME,
  LINEAR_TICKETS_SKILL_UPDATE_COMMAND,
  ORCA_LINEAR_SKILL_NAME,
  ORCA_LINEAR_SKILL_UPDATE_COMMAND
} from '@/lib/agent-feature-install-commands'

// Why: legacy-only installs must update the installed legacy skill, while
// fresh/canonical/both-name states should move through the canonical name.
export function getLinearAgentSkillUpdateCommand(
  skills: readonly DiscoveredSkill[],
  installed: boolean
): string {
  const canonicalSkillInstalled = hasInstalledAgentSkill(skills, ORCA_LINEAR_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const legacySkillInstalled = hasInstalledAgentSkill(skills, LINEAR_TICKETS_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  return !installed || canonicalSkillInstalled || !legacySkillInstalled
    ? ORCA_LINEAR_SKILL_UPDATE_COMMAND
    : LINEAR_TICKETS_SKILL_UPDATE_COMMAND
}
