import type { JSX } from 'react'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import {
  ORCHESTRATION_SKILL_INSTALL_COMMAND,
  ORCHESTRATION_SKILL_UPDATE_COMMAND
} from '@/lib/orchestration-install-command'
import type { InstalledAgentSkillState } from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import {
  buildSkillCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getWslCliDistroRequest
} from './CliSkillRuntimeSetup'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function OrchestrationSetupCard(props: {
  compact?: boolean
  terminalHeightPx?: number
  skill: InstalledAgentSkillState
}): JSX.Element {
  const { compact, terminalHeightPx, skill } = props
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const installCommand =
    activeSkillRuntime.agentRuntime && !activeSkillRuntime.installDisabledReason
      ? buildSkillCommandForRuntime(
          ORCHESTRATION_SKILL_INSTALL_COMMAND,
          activeSkillRuntime.agentRuntime
        )
      : ORCHESTRATION_SKILL_INSTALL_COMMAND
  const updateCommand =
    activeSkillRuntime.agentRuntime && !activeSkillRuntime.installDisabledReason
      ? buildSkillCommandForRuntime(
          ORCHESTRATION_SKILL_UPDATE_COMMAND,
          activeSkillRuntime.agentRuntime
        )
      : ORCHESTRATION_SKILL_UPDATE_COMMAND

  const setupPanel = (
    <AgentSkillSetupPanel
      className={compact ? 'w-full max-w-[520px]' : undefined}
      title={translate(
        'auto.components.settings.OrchestrationSetupCard.2777ff0fdc',
        'Orchestration skill'
      )}
      description={translate(
        'auto.components.settings.OrchestrationSetupCard.e7d2a5146c',
        'Enables agents to hand off context and coordinate work through Orca.'
      )}
      command={installCommand}
      installedCommand={updateCommand}
      terminalTitle="Orchestration setup"
      terminalAriaLabel="Orchestration skill install terminal"
      terminalWorktreeId="feature-wall-orchestration-skill-terminal"
      terminalShellOverride={activeSkillRuntime.terminalShellOverride}
      installed={skill.installed}
      loading={skill.loading}
      error={activeSkillRuntime.installDisabledReason ?? skill.error}
      installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
      terminalHeightPx={terminalHeightPx}
      preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
      getPrerequisiteStatus={() =>
        activeSkillRuntime.agentRuntime?.runtime === 'wsl'
          ? window.api.cli.getWslInstallStatus(
              getWslCliDistroRequest(activeSkillRuntime.agentRuntime)
            )
          : window.api.cli.getInstallStatus()
      }
      onBeforeOpenTerminal={async () => {
        useAppStore.getState().recordFeatureInteraction('agent-orchestration-setup')
        await (activeSkillRuntime.agentRuntime?.runtime === 'wsl'
          ? ensureWslCliAvailableForAgentSkillTerminal(activeSkillRuntime.agentRuntime)
          : ensureOrcaCliAvailableForAgentSkillTerminal())
      }}
      onRecheck={skill.refresh}
    />
  )

  if (compact) {
    return <div className="flex min-h-24 flex-1 items-center justify-center">{setupPanel}</div>
  }
  return <div className="flex">{setupPanel}</div>
}
