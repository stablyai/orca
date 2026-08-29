import { useCallback, useMemo } from 'react'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import {
  LINEAR_AGENT_SKILL_NAMES,
  ORCA_LINEAR_SKILL_INSTALL_COMMAND
} from '@/lib/agent-feature-install-commands'
import { getLinearAgentSkillUpdateTarget } from '@/lib/linear-agent-skill-update-command'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkillNames
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import {
  buildSkillCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getWslCliDistroRequest,
  type LocalAgentRuntime
} from './CliSkillRuntimeSetup'

// Shared install/update wiring for Task Sources + Linear settings.
export function useLinearAgentSkillSetup(): {
  installCommand: string
  updateCommand: string
  freshnessSkillName: string | undefined
  skillInstalled: boolean
  skillLoading: boolean
  // Status surfaces (step badges, checklist pills) read this so a focus-triggered
  // rescan does not flip a known result back to "checking".
  skillChecking: boolean
  installDisabled: boolean
  error: string | null
  terminalShellOverride: string | undefined
  terminalRuntime: LocalAgentRuntime | undefined
  preInstallNotice: string
  refreshSkill: () => Promise<boolean>
  getPrerequisiteStatus: () => Promise<Awaited<ReturnType<typeof window.api.cli.getInstallStatus>>>
  onBeforeOpenTerminal: () => Promise<void>
} {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const {
    installed: skillInstalled,
    loading: skillLoading,
    settled: skillSettled,
    error: skillError,
    skills: linearSkills,
    refresh: refreshSkill
  } = useInstalledAgentSkillNames(LINEAR_AGENT_SKILL_NAMES, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  // Why: the built command also depends on the focused runtime environment, so
  // memoizing it on the runtime alone can serve a stale Windows host command.
  const installCommand = activeSkillRuntime.installDisabledReason
    ? ORCA_LINEAR_SKILL_INSTALL_COMMAND
    : buildSkillCommandForRuntime(
        ORCA_LINEAR_SKILL_INSTALL_COMMAND,
        activeSkillRuntime.agentRuntime
      )
  const updateTarget = useMemo(
    () => getLinearAgentSkillUpdateTarget(linearSkills, skillInstalled),
    [linearSkills, skillInstalled]
  )
  const updateCommand = activeSkillRuntime.installDisabledReason
    ? updateTarget.command
    : buildSkillCommandForRuntime(updateTarget.command, activeSkillRuntime.agentRuntime)

  // Freshness cannot verify WSL, so report presence there.
  const freshnessSkillName = activeSkillRuntime.canUseLocalSkillFreshness
    ? updateTarget.skillName
    : undefined

  const getPrerequisiteStatus = useCallback(
    () =>
      activeSkillRuntime.agentRuntime?.runtime === 'wsl'
        ? window.api.cli.getWslInstallStatus(
            getWslCliDistroRequest(activeSkillRuntime.agentRuntime)
          )
        : window.api.cli.getInstallStatus(),
    [activeSkillRuntime.agentRuntime]
  )

  const onBeforeOpenTerminal = useCallback(async () => {
    await (activeSkillRuntime.agentRuntime?.runtime === 'wsl'
      ? ensureWslCliAvailableForAgentSkillTerminal(activeSkillRuntime.agentRuntime)
      : ensureOrcaCliAvailableForAgentSkillTerminal())
  }, [activeSkillRuntime.agentRuntime])

  const installDisabled = Boolean(activeSkillRuntime.installDisabledReason)

  return {
    installCommand,
    updateCommand,
    freshnessSkillName,
    skillInstalled,
    skillLoading,
    skillChecking: skillLoading && !skillSettled,
    installDisabled,
    error: activeSkillRuntime.installDisabledReason ?? skillError,
    terminalShellOverride: activeSkillRuntime.terminalShellOverride,
    terminalRuntime: activeSkillRuntime.agentRuntime,
    preInstallNotice: AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
    refreshSkill,
    getPrerequisiteStatus,
    onBeforeOpenTerminal
  }
}
