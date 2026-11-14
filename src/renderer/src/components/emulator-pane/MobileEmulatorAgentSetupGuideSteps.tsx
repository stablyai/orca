import { useAppStore } from '@/store'
import { ORCA_CLI_SKILL_NAME } from '@/lib/skills/installation/agent-feature-skill-names'
import { AgentSkillSetupPanel } from '../skills/setup/AgentSkillSetupPanel'
import type { useMobileEmulatorAgentSetupState } from './use-mobile-emulator-agent-setup-state'
import { useTranslate } from '@/i18n/use-translate'

type MobileEmulatorAgentSetupGuideStepsProps = {
  setup: ReturnType<typeof useMobileEmulatorAgentSetupState>
}

export function MobileEmulatorAgentSetupGuideSteps({
  setup
}: MobileEmulatorAgentSetupGuideStepsProps): React.JSX.Element {
  const t = useTranslate()
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)

  return (
    <div className="py-2.5">
      <p className="text-sm font-medium">
        {t(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.21f5687c07',
          'Orca CLI skill'
        )}
      </p>
      <AgentSkillSetupPanel
        variant="inline"
        hideHeader
        className="min-w-0"
        title={t(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.21f5687c07',
          'Orca CLI skill'
        )}
        description={t(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.64fb057667',
          'Teaches agents the orca emulator commands for this worktree.'
        )}
        skillNames={[ORCA_CLI_SKILL_NAME]}
        target={setup.skillRuntime.bundledSkillTarget}
        terminalRuntime={setup.skillRuntime.agentRuntime}
        installDisabled={Boolean(setup.skillRuntime.installDisabledReason)}
        installed={setup.cliSkillInstalled}
        loading={setup.cliSkillLoading || setup.setupRechecking}
        error={setup.cliSkillError}
        showInstallWhenInstalled={!setup.cliSkillInstalled}
        onBeforeInstall={() => {
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
