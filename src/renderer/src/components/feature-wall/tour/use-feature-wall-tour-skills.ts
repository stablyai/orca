import {
  ORCA_CLI_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/skills/installation/agent-feature-skill-names'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/skills/discovery/useInstalledAgentSkills'
import { useOrcaTeamFeatureBlocked } from '@/lib/orca-team-policy'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../../../shared/orca-profiles/orca-cloud-team-policy'

type DiscoveryTarget = NonNullable<Parameters<typeof useInstalledAgentSkill>[1]>['discoveryTarget']

/** The skills the tour's completion checklist reads, discovered only while the tour is open. */
export function useFeatureWallTourSkills(
  isOpen: boolean,
  discoveryTarget: DiscoveryTarget
): {
  orchestrationSkill: ReturnType<typeof useInstalledAgentSkill>
  browserUseSkill: ReturnType<typeof useInstalledAgentSkill>
} {
  const browserUseBlocked = useOrcaTeamFeatureBlocked(ORCA_CLOUD_TEAM_POLICY_FLAGS.browserUse)
  const orchestrationSkill = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    enabled: isOpen,
    discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const browserUseSkill = useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
    enabled: isOpen && !browserUseBlocked,
    discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  return { orchestrationSkill, browserUseSkill }
}
