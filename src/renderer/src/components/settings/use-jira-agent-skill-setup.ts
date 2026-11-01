import { ORCA_JIRA_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'

export function useJiraAgentSkillSetup(): {
  freshnessSkillName: string | undefined
  skillInstalled: boolean
  skillLoading: boolean
  // Keep known status through focus rescans instead of flashing Checking.
  skillChecking: boolean
  installDisabled: boolean
  error: string | null
  refreshSkill: () => Promise<boolean>
} {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const {
    installed: skillInstalled,
    loading: skillLoading,
    settled: skillSettled,
    error: skillError,
    refresh: refreshSkill
  } = useInstalledAgentSkill(ORCA_JIRA_SKILL_NAME, {
    runtimeTarget: activeSkillRuntime.discoveryRuntimeTarget,
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  return {
    // Freshness cannot verify WSL, so report presence there.
    freshnessSkillName: activeSkillRuntime.canUseSkillFreshness ? ORCA_JIRA_SKILL_NAME : undefined,
    skillInstalled,
    skillLoading,
    skillChecking: skillLoading && !skillSettled,
    installDisabled: Boolean(activeSkillRuntime.installDisabledReason),
    error: activeSkillRuntime.installDisabledReason ?? skillError,
    refreshSkill
  }
}
