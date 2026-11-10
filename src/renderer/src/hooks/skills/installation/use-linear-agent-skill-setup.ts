import { useMemo } from 'react'
import { LINEAR_AGENT_SKILL_NAMES } from '@/lib/skills/installation/agent-feature-skill-names'
import { getLinearAgentSkillUpdateTarget } from '@/lib/skills/installation/linear-agent-skill-update-target'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkillNames
} from '@/hooks/skills/discovery/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/skills/runtime/useActiveProjectSkillRuntime'

export function useLinearAgentSkillSetup(): {
  // Legacy-only installs update the legacy name.
  updateSkillName: string
  freshnessSkillName: string | undefined
  skillInstalled: boolean
  skillLoading: boolean
  // Keep known status through focus rescans instead of flashing Checking.
  skillChecking: boolean
  /** The scan could not vouch for "not installed", so no surface may claim it. */
  skillUnverifiable: boolean
  installDisabled: boolean
  error: string | null
  refreshSkill: () => Promise<boolean>
} {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const {
    installed: skillInstalled,
    loading: skillLoading,
    settled: skillSettled,
    installedUnverifiable: skillUnverifiable,
    error: skillError,
    skills: linearSkills,
    refresh: refreshSkill
  } = useInstalledAgentSkillNames(LINEAR_AGENT_SKILL_NAMES, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  const updateTarget = useMemo(
    () => getLinearAgentSkillUpdateTarget(linearSkills, skillInstalled),
    [linearSkills, skillInstalled]
  )
  // Freshness cannot verify WSL, so report presence there.
  const freshnessSkillName = activeSkillRuntime.canUseSkillFreshness
    ? updateTarget.skillName
    : undefined

  const installDisabled = Boolean(activeSkillRuntime.installDisabledReason)

  return {
    updateSkillName: updateTarget.skillName,
    freshnessSkillName,
    skillInstalled,
    skillLoading,
    skillChecking: skillLoading && !skillSettled,
    skillUnverifiable,
    installDisabled,
    error: activeSkillRuntime.installDisabledReason ?? skillError,
    refreshSkill
  }
}
