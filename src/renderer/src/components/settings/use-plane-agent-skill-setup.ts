import { useMemo } from 'react'
import { PLANE_AGENT_SKILL_NAMES } from '@/lib/agent-feature-skill-names'
import { getPlaneAgentSkillUpdateTarget } from '@/lib/plane-agent-skill-update-command'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkillNames
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'

export function usePlaneAgentSkillSetup(): {
  updateSkillName: string
  freshnessSkillName: string | undefined
  skillInstalled: boolean
  skillLoading: boolean
  skillChecking: boolean
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
    skills: planeSkills,
    refresh: refreshSkill
  } = useInstalledAgentSkillNames(PLANE_AGENT_SKILL_NAMES, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  const updateTarget = useMemo(
    () => getPlaneAgentSkillUpdateTarget(planeSkills, skillInstalled),
    [planeSkills, skillInstalled]
  )
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
