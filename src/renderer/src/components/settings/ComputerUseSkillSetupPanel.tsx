import { MonitorCog } from 'lucide-react'
import {
  COMPUTER_USE_SKILL_INSTALL_COMMAND,
  COMPUTER_USE_SKILL_NAME,
  COMPUTER_USE_SKILL_UPDATE_COMMAND
} from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { useAppStore } from '@/store'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import {
  buildSkillCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getWslCliDistroRequest
} from './CliSkillRuntimeSetup'
import { translate } from '@/i18n/i18n'

export function ComputerUseSkillSetupPanel(): React.JSX.Element {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const installCommand =
    activeSkillRuntime.agentRuntime && !activeSkillRuntime.installDisabledReason
      ? buildSkillCommandForRuntime(
          COMPUTER_USE_SKILL_INSTALL_COMMAND,
          activeSkillRuntime.agentRuntime
        )
      : COMPUTER_USE_SKILL_INSTALL_COMMAND
  const updateCommand =
    activeSkillRuntime.agentRuntime && !activeSkillRuntime.installDisabledReason
      ? buildSkillCommandForRuntime(
          COMPUTER_USE_SKILL_UPDATE_COMMAND,
          activeSkillRuntime.agentRuntime
        )
      : COMPUTER_USE_SKILL_UPDATE_COMMAND
  const {
    installed: computerUseSkillDetected,
    loading: computerUseSkillLoading,
    error: computerUseSkillError,
    refresh: refreshComputerUseSkill
  } = useInstalledAgentSkill(COMPUTER_USE_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  return (
    <AgentSkillSetupPanel
      title={translate('auto.components.settings.ComputerUsePane.93255aaf18', 'Computer Use skill')}
      description={translate(
        'auto.components.settings.ComputerUsePane.1735461723',
        'Enables agents to inspect and operate local desktop apps.'
      )}
      command={installCommand}
      installedCommand={updateCommand}
      terminalTitle="Computer Use setup"
      terminalAriaLabel="Computer Use skill install terminal"
      terminalWorktreeId="settings-computer-use-skill-terminal"
      terminalShellOverride={activeSkillRuntime.terminalShellOverride}
      installed={computerUseSkillDetected}
      loading={computerUseSkillLoading}
      error={activeSkillRuntime.installDisabledReason ?? computerUseSkillError}
      installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
      icon={<MonitorCog className="size-5" />}
      preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
      getPrerequisiteStatus={() =>
        activeSkillRuntime.agentRuntime?.runtime === 'wsl'
          ? window.api.cli.getWslInstallStatus(
              getWslCliDistroRequest(activeSkillRuntime.agentRuntime)
            )
          : window.api.cli.getInstallStatus()
      }
      onBeforeOpenTerminal={async () => {
        useAppStore.getState().recordFeatureInteraction('computer-use-setup')
        await (activeSkillRuntime.agentRuntime?.runtime === 'wsl'
          ? ensureWslCliAvailableForAgentSkillTerminal(activeSkillRuntime.agentRuntime)
          : ensureOrcaCliAvailableForAgentSkillTerminal())
      }}
      onRecheck={refreshComputerUseSkill}
    />
  )
}
