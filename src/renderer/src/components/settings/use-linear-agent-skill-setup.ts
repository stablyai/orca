import { useMemo } from 'react'
import { LINEAR_AGENT_SKILL_NAMES } from '@/lib/agent-feature-skill-names'
import { getLinearAgentSkillUpdateTarget } from '@/lib/linear-agent-skill-update-target'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkillNames
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'

// Shared install/update wiring for Task Sources + Linear settings.
export function useLinearAgentSkillSetup(): {
  // Legacy-only installs update the legacy name.
  updateSkillName: string
  freshnessSkillName: string | undefined
  skillInstalled: boolean
  skillLoading: boolean
  // Status surfaces (step badges, checklist pills) read this so a focus-triggered
  // rescan does not flip a known result back to "checking".
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
