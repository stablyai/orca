import { useCallback, useMemo } from 'react'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { GlobalSettings } from '../../../../shared/types'
import {
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_NAME,
  ORCA_CLI_SKILL_UPDATE_COMMAND
} from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal,
  isOrcaCliAvailableOnPath
} from '@/lib/agent-skill-cli-prerequisite'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import {
  buildSkillCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getAgentSkillTerminalShellOverride,
  getSelectedAgentRuntime,
  getSkillDiscoveryTargetForRuntime,
  getWslCliDistroRequest
} from './CliSkillRuntimeSetup'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

type CliAgentSkillSetupProps = {
  currentPlatform: string
  settings: GlobalSettings
  wslSupportedPlatform: boolean
  wslAvailable: boolean
  wslCapabilitiesLoading: boolean
  onHostStatusChange: (nextStatus: CliInstallStatus) => void
}

export function CliAgentSkillSetup({
  currentPlatform,
  settings,
  wslSupportedPlatform,
  wslAvailable,
  wslCapabilitiesLoading,
  onHostStatusChange
}: CliAgentSkillSetupProps): React.JSX.Element {
  const agentRuntime = useMemo(
    () =>
      getSelectedAgentRuntime(settings, wslSupportedPlatform, wslAvailable, wslCapabilitiesLoading),
    [settings, wslAvailable, wslCapabilitiesLoading, wslSupportedPlatform]
  )
  const cliSkillDiscoveryTarget = useMemo(
    () => getSkillDiscoveryTargetForRuntime(agentRuntime),
    [agentRuntime]
  )
  const {
    installed: cliSkillDetected,
    loading: cliSkillLoading,
    error: cliSkillError,
    refresh: refreshCliSkill
  } = useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
    discoveryTarget: cliSkillDiscoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const cliSkillInstallCommand = buildSkillCommandForRuntime(
    ORCA_CLI_SKILL_INSTALL_COMMAND,
    agentRuntime
  )
  const cliSkillUpdateCommand = buildSkillCommandForRuntime(
    ORCA_CLI_SKILL_UPDATE_COMMAND,
    agentRuntime
  )
  const cliSkillTerminalShellOverride = getAgentSkillTerminalShellOverride(
    currentPlatform,
    settings,
    agentRuntime
  )
  const getCliSkillPrerequisiteStatus = useCallback(
    () =>
      agentRuntime.runtime === 'wsl'
        ? window.api.cli.getWslInstallStatus(getWslCliDistroRequest(agentRuntime))
        : window.api.cli.getInstallStatus(),
    [agentRuntime]
  )

  return (
    <div className="border-t border-border/60 pt-3">
      <div className="space-y-0.5">
        <Label>{translate('auto.components.settings.CliSection.04873eea3e', 'Agent skills')}</Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CliSection.36a6f919ba',
            'Give agents Orca-aware workspace, terminal, and progress workflows.'
          )}
        </p>
      </div>

      <AgentSkillSetupPanel
        className="mt-3"
        variant="inline"
        title={translate('auto.components.settings.CliSection.6053cf736c', 'CLI skill')}
        description={translate(
          'auto.components.settings.CliSection.e8012c03a1',
          'Enables agents to use Orca workspace, terminal, and progress commands.'
        )}
        command={cliSkillInstallCommand}
        installedCommand={cliSkillUpdateCommand}
        terminalTitle={translate(
          'auto.components.settings.CliSection.cliSkillTerminalTitle',
          'CLI skill setup'
        )}
        terminalAriaLabel={translate(
          'auto.components.settings.CliSection.cliSkillTerminalAria',
          'CLI skill install terminal'
        )}
        terminalWorktreeId={`settings-cli-skill-terminal-${agentRuntime.runtime}`}
        terminalShellOverride={cliSkillTerminalShellOverride}
        installed={cliSkillDetected}
        loading={cliSkillLoading}
        error={cliSkillError}
        preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
        getPrerequisiteStatus={getCliSkillPrerequisiteStatus}
        isPrerequisiteAvailable={isOrcaCliAvailableOnPath}
        onBeforeOpenTerminal={async () => {
          await (agentRuntime.runtime === 'wsl'
            ? ensureWslCliAvailableForAgentSkillTerminal(agentRuntime)
            : ensureOrcaCliAvailableForAgentSkillTerminal({
                onStatusChange: onHostStatusChange
              }))
        }}
        onRecheck={refreshCliSkill}
      />
    </div>
  )
}
