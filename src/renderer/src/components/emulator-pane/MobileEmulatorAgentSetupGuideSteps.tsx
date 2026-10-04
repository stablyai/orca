import { useAppStore } from '@/store'
import { ORCA_CLI_SKILL_INSTALL_COMMAND } from '@/lib/agent-feature-install-commands'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { AgentSkillSetupPanel } from '../settings/AgentSkillSetupPanel'
import { buildSkillCommandForRuntime } from '../settings/CliSkillRuntimeSetup'
import type { useMobileEmulatorAgentSetupState } from './use-mobile-emulator-agent-setup-state'
import { translate } from '@/i18n/i18n'

type MobileEmulatorAgentSetupGuideStepsProps = {
  setup: ReturnType<typeof useMobileEmulatorAgentSetupState>
  worktreeId: string
}

export function MobileEmulatorAgentSetupGuideSteps({
  setup,
  worktreeId
}: MobileEmulatorAgentSetupGuideStepsProps): React.JSX.Element {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  // Why: skill detection here scans the local host only, so keep building host
  // commands; routing them to a WSL runtime would install where we never look.
  const skillInstallCommand = buildSkillCommandForRuntime(ORCA_CLI_SKILL_INSTALL_COMMAND)
  const terminalWorktreeId = `mobile-emulator-${worktreeId}-orca-cli-skill-terminal`

  return (
    <div className="py-2.5">
      <p className="text-sm font-medium">
        {translate(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.21f5687c07',
          'Orca CLI skill'
        )}
      </p>
      <AgentSkillSetupPanel
        variant="inline"
        hideHeader
        className="min-w-0"
        title={translate(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.21f5687c07',
          'Orca CLI skill'
        )}
        description={translate(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.64fb057667',
          'Teaches agents the orca emulator commands for this worktree.'
        )}
        command={skillInstallCommand}
        terminalTitle={translate(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.5c59ea96ca',
          'Mobile emulator Orca CLI skill setup'
        )}
        terminalAriaLabel={translate(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.bff5341ac3',
          'Mobile emulator Orca CLI skill install terminal'
        )}
        terminalWorktreeId={terminalWorktreeId}
        terminalShellOverride={activeSkillRuntime.terminalShellOverride}
        installed={setup.cliSkillInstalled}
        loading={setup.cliSkillLoading || setup.setupRechecking}
        error={setup.cliSkillError}
        showInstallWhenInstalled={!setup.cliSkillInstalled}
        terminalHeightPx={112}
        onBeforeOpenTerminal={() => {
          recordFeatureInteraction('mobile-emulator-agent-setup')
        }}
        onRecheck={() => {
          recordFeatureInteraction('mobile-emulator-agent-setup')
          void setup.recheckSetup()
        }}
      />
    </div>
  )
}
