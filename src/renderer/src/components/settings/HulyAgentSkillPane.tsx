import { HulyIcon } from '@/components/icons/HulyIcon'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { HULY_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { useHulyAgentSkillSetup } from './use-huly-agent-skill-setup'
import { translate } from '@/i18n/i18n'
import { useHulyProviderConnected } from '@/hooks/useHulyProviderConnected'

type HulyAgentSkillPaneProps = {
  compact?: boolean
}

export function HulyAgentSkillPane({
  compact = false
}: HulyAgentSkillPaneProps): React.JSX.Element {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const hulyConnected = useHulyProviderConnected()
  const skillSetup = useHulyAgentSkillSetup()

  const openIntegrations = (): void => {
    openSettingsPage()
    openSettingsTarget({
      pane: 'integrations',
      repoId: null,
      sectionId: HULY_INTEGRATION_SECTION_ID
    })
  }

  return (
    <div className="space-y-3">
      {!compact && !hulyConnected ? (
        <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.HulyAgentSkillPane.connectFirst',
            'Connect a Huly instance first to use this skill.'
          )}{' '}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 align-baseline text-xs"
            onClick={openIntegrations}
          >
            {translate(
              'auto.components.settings.HulyAgentSkillPane.openIntegrations',
              'Open Integrations'
            )}
          </Button>
        </div>
      ) : null}
      <AgentSkillSetupPanel
        variant="inline"
        hideHeader={compact}
        title={translate('auto.components.settings.HulyAgentSkillPane.skillTitle', 'Huly skill')}
        description={null}
        command={skillSetup.installCommand}
        installedCommand={skillSetup.updateCommand}
        terminalTitle={translate(
          'auto.components.settings.HulyAgentSkillPane.terminalTitle',
          'Huly skill setup'
        )}
        terminalAriaLabel={translate(
          'auto.components.settings.HulyAgentSkillPane.terminalAria',
          'Open terminal to install Huly skill'
        )}
        terminalWorktreeId="huly-skill"
        icon={<HulyIcon className="size-4" />}
        installed={skillSetup.skillInstalled}
        loading={skillSetup.skillLoading}
        installDisabled={skillSetup.installDisabled}
        error={skillSetup.error}
        preInstallNotice={skillSetup.preInstallNotice}
        getPrerequisiteStatus={skillSetup.getPrerequisiteStatus}
        onBeforeOpenTerminal={skillSetup.onBeforeOpenTerminal}
        onRecheck={() => skillSetup.refreshSkill().then(() => undefined)}
      />
    </div>
  )
}
