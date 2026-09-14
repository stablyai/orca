import { useState } from 'react'
import { ArrowRightCircle, BookOpen, MessageSquarePlus, PlusCircle, Sliders } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PlaneConnectDialog } from '@/components/plane-connect-dialog'
import { PlaneIcon } from '@/components/icons/PlaneIcon'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { ORCA_PLANE_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { getPlaneUsageExamples } from '@/lib/plane-usage-examples'
import type { SkillUsageExample } from '@/lib/skill-usage-example'
import { usePlaneProviderConnected } from '@/hooks/usePlaneProviderConnected'
import { normalizeVisibleTaskProviders } from '../../../../shared/task-providers'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { PlaneAgentSkillGuide } from './PlaneAgentSkillGuide'
import { PlaneAgentSkillNotes } from './PlaneAgentSkillNotes'
import { getPlaneAgentSkillPaneSearchEntries } from './plane-agent-skill-search'
import { SearchableSetting } from './SearchableSetting'
import { SkillUsageExamplesSection } from './SkillUsageExamplesSection'
import { PLANE_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { usePlaneAgentSkillSetup } from './use-plane-agent-skill-setup'
import { translate } from '@/i18n/i18n'

const PLANE_EXAMPLE_ICONS: Record<string, LucideIcon> = {
  'read-ticket': BookOpen,
  'post-update': MessageSquarePlus,
  'move-state': ArrowRightCircle,
  'triage-priority': Sliders,
  'create-followup': PlusCircle
}

function resolvePlaneExampleIcon(example: SkillUsageExample): LucideIcon {
  return PLANE_EXAMPLE_ICONS[example.id] ?? PlaneIcon
}

export function PlaneAgentSkillPane(): React.JSX.Element {
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const settings = useAppStore((state) => state.settings)
  const planeStatusChecked = useAppStore((state) => state.planeStatusChecked)
  const planeConnected = usePlaneProviderConnected()
  const checkPlaneConnection = useAppStore((state) => state.checkPlaneConnection)
  const [connectDialogOpen, setConnectDialogOpen] = useState(false)
  const skillSetup = usePlaneAgentSkillSetup()

  const openTaskSources = (): void => {
    openSettingsPage()
    openSettingsTarget({ pane: 'tasks', repoId: null })
  }

  const openIntegrationSettings = (): void => {
    openSettingsPage()
    openSettingsTarget({
      pane: 'integrations',
      repoId: null,
      sectionId: PLANE_INTEGRATION_SECTION_ID
    })
  }

  const visibleInTasks = normalizeVisibleTaskProviders(settings?.visibleTaskProviders).includes(
    'plane'
  )
  const connectionChecking = !planeStatusChecked

  const skillPanel = (
    <AgentSkillSetupPanel
      variant="inline"
      hideHeader
      title={translate('auto.components.settings.PlaneAgentSkillPane.skillTitle', 'Plane skill')}
      description={null}
      command={skillSetup.installCommand}
      installedCommand={skillSetup.updateCommand}
      terminalTitle={translate(
        'auto.components.settings.PlaneAgentSkillPane.terminalTitle',
        'Plane skill setup'
      )}
      terminalAriaLabel={translate(
        'auto.components.settings.PlaneAgentSkillPane.terminalAriaLabel',
        'Plane skill install terminal'
      )}
      terminalWorktreeId="settings-plane-skill-terminal"
      terminalShellOverride={skillSetup.terminalShellOverride}
      terminalRuntime={skillSetup.terminalRuntime}
      installed={skillSetup.skillInstalled}
      loading={skillSetup.skillLoading}
      error={skillSetup.error}
      installDisabled={skillSetup.installDisabled}
      preInstallNotice={skillSetup.preInstallNotice}
      getPrerequisiteStatus={skillSetup.getPrerequisiteStatus}
      onBeforeOpenTerminal={skillSetup.onBeforeOpenTerminal}
      onRecheck={skillSetup.refreshSkill}
      freshnessSkillName={skillSetup.freshnessSkillName}
    />
  )

  return (
    <SearchableSetting
      title={translate('auto.components.settings.PlaneAgentSkillPane.title', 'Plane')}
      description={translate(
        'auto.components.settings.PlaneAgentSkillPane.description',
        'How Plane works in Orca: browse issues, start linked workspaces, and let agents update tickets with /orca-plane.'
      )}
      keywords={getPlaneAgentSkillPaneSearchEntries()[0].keywords}
      className="space-y-6 py-2"
    >
      <PlaneAgentSkillGuide
        status={{
          connected: planeConnected,
          connectionChecking,
          skillInstalled: skillSetup.skillInstalled,
          skillChecking: skillSetup.skillChecking,
          visibleInTasks
        }}
        onOpenTaskSources={openTaskSources}
        onManagePlaneAccess={
          planeConnected ? openIntegrationSettings : () => setConnectDialogOpen(true)
        }
        skillPanel={skillPanel}
      />

      <SkillUsageExamplesSection
        heading={translate(
          'auto.components.settings.PlaneAgentSkillPane.howToUse',
          'Example prompts'
        )}
        description={translate(
          'auto.components.settings.PlaneAgentSkillPane.howToUseDescription',
          'Click a card to copy a prompt. Use these in a Plane-linked worktree after the skill is installed.'
        )}
        examples={getPlaneUsageExamples()}
        resolveIcon={resolvePlaneExampleIcon}
        slashCommand={`/${ORCA_PLANE_SKILL_NAME}`}
      />

      <PlaneAgentSkillNotes />

      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.PlaneAgentSkillPane.manageConnectionHint',
          'Review connected Plane workspaces and API tokens in'
        )}{' '}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs align-baseline"
          onClick={openIntegrationSettings}
        >
          {translate(
            'auto.components.settings.PlaneAgentSkillPane.manageConnectionLink',
            'Integrations'
          )}
        </Button>
      </p>

      <PlaneConnectDialog
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
        onConnected={() => {
          void checkPlaneConnection()
        }}
      />
    </SearchableSetting>
  )
}
