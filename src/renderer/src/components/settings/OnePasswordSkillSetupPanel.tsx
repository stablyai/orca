import { KeyRound } from 'lucide-react'
import {
  ONEPASSWORD_SKILL_INSTALL_COMMAND,
  ONEPASSWORD_SKILL_NAME,
  ONEPASSWORD_SKILL_UPDATE_COMMAND
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

export function OnePasswordSkillSetupPanel(): React.JSX.Element {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const installCommand = !activeSkillRuntime.installDisabledReason
    ? buildSkillCommandForRuntime(
        ONEPASSWORD_SKILL_INSTALL_COMMAND,
        activeSkillRuntime.agentRuntime
      )
    : ONEPASSWORD_SKILL_INSTALL_COMMAND
  const updateCommand = !activeSkillRuntime.installDisabledReason
    ? buildSkillCommandForRuntime(ONEPASSWORD_SKILL_UPDATE_COMMAND, activeSkillRuntime.agentRuntime)
    : ONEPASSWORD_SKILL_UPDATE_COMMAND
  const {
    installed: onePasswordSkillDetected,
    loading: onePasswordSkillLoading,
    error: onePasswordSkillError,
    refresh: refreshOnePasswordSkill
  } = useInstalledAgentSkill(ONEPASSWORD_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  return (
    <AgentSkillSetupPanel
      title={translate(
        'auto.components.settings.OnePasswordSkillSetupPanel.title',
        '1Password skill'
      )}
      description={translate(
        'auto.components.settings.OnePasswordSkillSetupPanel.description',
        'Teaches agents to use the op CLI for just-in-time secrets without printing values.'
      )}
      command={installCommand}
      installedCommand={updateCommand}
      terminalTitle="1Password skill setup"
      terminalAriaLabel="1Password skill install terminal"
      terminalWorktreeId="settings-onepassword-skill-terminal"
      terminalShellOverride={activeSkillRuntime.terminalShellOverride}
      installed={onePasswordSkillDetected}
      loading={onePasswordSkillLoading}
      error={activeSkillRuntime.installDisabledReason ?? onePasswordSkillError}
      installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
      icon={<KeyRound className="size-5" />}
      variant="inline"
      preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
      getPrerequisiteStatus={() =>
        activeSkillRuntime.agentRuntime?.runtime === 'wsl'
          ? window.api.cli.getWslInstallStatus(
              getWslCliDistroRequest(activeSkillRuntime.agentRuntime)
            )
          : window.api.cli.getInstallStatus()
      }
      onBeforeOpenTerminal={async () => {
        useAppStore.getState().recordFeatureInteraction('onepassword-skill-setup')
        await (activeSkillRuntime.agentRuntime?.runtime === 'wsl'
          ? ensureWslCliAvailableForAgentSkillTerminal(activeSkillRuntime.agentRuntime)
          : ensureOrcaCliAvailableForAgentSkillTerminal())
      }}
      onRecheck={refreshOnePasswordSkill}
      freshnessSkillName={
        activeSkillRuntime.canUseLocalSkillFreshness ? ONEPASSWORD_SKILL_NAME : undefined
      }
    />
  )
}
