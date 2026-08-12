import { useCallback } from 'react'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import {
  HULY_AGENT_SKILL_INSTALL_COMMAND,
  HULY_AGENT_SKILL_NAMES
} from '@/lib/agent-feature-install-commands'
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

export function useHulyAgentSkillSetup(): {
  installCommand: string
  updateCommand: string
  skillInstalled: boolean
  skillLoading: boolean
  skillChecking: boolean
  installDisabled: boolean
  error: string | null
  preInstallNotice: string
  refreshSkill: () => Promise<boolean>
  getPrerequisiteStatus: () => Promise<Awaited<ReturnType<typeof window.api.cli.getInstallStatus>>>
  onBeforeOpenTerminal: () => Promise<void>
  terminalShellOverride: string | undefined
  terminalRuntime: LocalAgentRuntime | undefined
} {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const {
    installed: skillInstalled,
    loading: skillLoading,
    settled: skillSettled,
    error: skillError,
    refresh: refreshSkill
  } = useInstalledAgentSkillNames(HULY_AGENT_SKILL_NAMES, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  const installCommand = activeSkillRuntime.installDisabledReason
    ? HULY_AGENT_SKILL_INSTALL_COMMAND
    : buildSkillCommandForRuntime(HULY_AGENT_SKILL_INSTALL_COMMAND, activeSkillRuntime.agentRuntime)

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

  return {
    installCommand,
    updateCommand: installCommand,
    skillInstalled,
    skillLoading,
    skillChecking: skillLoading && !skillSettled,
    installDisabled: Boolean(activeSkillRuntime.installDisabledReason),
    error: activeSkillRuntime.installDisabledReason ?? skillError,
    preInstallNotice: AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
    refreshSkill,
    getPrerequisiteStatus,
    onBeforeOpenTerminal,
    terminalShellOverride: activeSkillRuntime.terminalShellOverride,
    terminalRuntime: activeSkillRuntime.agentRuntime
  }
}
