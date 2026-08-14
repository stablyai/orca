import { useState } from 'react'
import { ArrowRightCircle, BookOpen, Link2, ListTodo, MessageSquarePlus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { ORCA_LINEAR_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { getLinearUsageExamples } from '@/lib/linear-usage-examples'
import type { SkillUsageExample } from '@/lib/skill-usage-example'
import { useLinearProviderConnected } from '@/hooks/useLinearProviderConnected'
import { normalizeVisibleTaskProviders } from '../../../../shared/task-providers'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { LinearAgentSkillGuide } from './LinearAgentSkillGuide'
import { LinearAgentSkillNotes } from './LinearAgentSkillNotes'
import { getLinearAgentSkillPaneSearchEntries } from './linear-agent-skill-search'
import { SearchableSetting } from './SearchableSetting'
import { SkillUsageExamplesSection } from './SkillUsageExamplesSection'
import { LINEAR_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { useLinearAgentSkillSetup } from './use-linear-agent-skill-setup'
import { translate } from '@/i18n/i18n'

const LINEAR_EXAMPLE_ICONS: Record<string, LucideIcon> = {
  'read-ticket': BookOpen,
  'post-update': MessageSquarePlus,
  'move-state': ArrowRightCircle,
  'attach-pr': Link2,
  'triage-followups': ListTodo
}

function resolveLinearExampleIcon(example: SkillUsageExample): LucideIcon {
  return LINEAR_EXAMPLE_ICONS[example.id] ?? LinearIcon
}

// Checklist owns connect + skill + visibility; examples and notes sit below.
export function LinearAgentSkillPane(): React.JSX.Element {
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const settings = useAppStore((state) => state.settings)
  const linearStatusChecked = useAppStore((state) => state.linearStatusChecked)
  const linearStatusContextKey = useAppStore((state) => state.linearStatusContextKey)
  const linearConnected = useLinearProviderConnected()
  const checkLinearConnection = useAppStore((state) => state.checkLinearConnection)
  const [linearKeyDialogOpen, setLinearKeyDialogOpen] = useState(false)
  const skillSetup = useLinearAgentSkillSetup()

  const openTaskSources = (): void => {
    openSettingsPage()
    openSettingsTarget({ pane: 'tasks', repoId: null })
  }

  const openIntegrationSettings = (): void => {
    openSettingsPage()
    openSettingsTarget({
      pane: 'integrations',
      repoId: null,
      sectionId: LINEAR_INTEGRATION_SECTION_ID
    })
  }

  const visibleInTasks = normalizeVisibleTaskProviders(settings?.visibleTaskProviders).includes(
    'linear'
  )
  const connectionChecking =
    linearStatusContextKey !== getProviderRuntimeContextKey(settings) || !linearStatusChecked

  const skillPanel = (
    <AgentSkillSetupPanel
      variant="inline"
      hideHeader
      title={translate('auto.components.settings.LinearAgentSkillPane.skillTitle', 'Linear skill')}
      description={null}
      command={skillSetup.installCommand}
      installedCommand={skillSetup.updateCommand}
      terminalTitle={translate(
        'auto.components.settings.LinearAgentSkillPane.terminalTitle',
        'Linear skill setup'
      )}
      terminalAriaLabel={translate(
        'auto.components.settings.LinearAgentSkillPane.terminalAriaLabel',
        'Linear skill install terminal'
      )}
      terminalWorktreeId="settings-linear-skill-terminal"
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
      title={translate('auto.components.settings.LinearAgentSkillPane.title', 'Linear')}
      description={translate(
        'auto.components.settings.LinearAgentSkillPane.description',
        'How Linear works in Orca: browse issues, start linked workspaces, and let agents update tickets with /orca-linear.'
      )}
      keywords={getLinearAgentSkillPaneSearchEntries()[0].keywords}
      className="space-y-6 py-2"
    >
      <LinearAgentSkillGuide
        status={{
          connected: linearConnected,
          connectionChecking,
          skillInstalled: skillSetup.skillInstalled,
          skillChecking: skillSetup.skillChecking,
          visibleInTasks
        }}
        onOpenTaskSources={openTaskSources}
        onManageLinearAccess={
          linearConnected ? openIntegrationSettings : () => setLinearKeyDialogOpen(true)
        }
        skillPanel={skillPanel}
      />

      <SkillUsageExamplesSection
        heading={translate(
          'auto.components.settings.LinearAgentSkillPane.howToUse',
          'Example prompts'
        )}
        description={translate(
          'auto.components.settings.LinearAgentSkillPane.howToUseDescription',
          'Click a card to copy a prompt. Use these in a Linear-linked worktree after the skill is installed.'
        )}
        examples={getLinearUsageExamples()}
        resolveIcon={resolveLinearExampleIcon}
        slashCommand={`/${ORCA_LINEAR_SKILL_NAME}`}
      />

      <LinearAgentSkillNotes />

      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.LinearAgentSkillPane.manageConnectionHint',
          'Review connected Linear workspaces and API keys in'
        )}{' '}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs align-baseline"
          onClick={openIntegrationSettings}
        >
          {translate(
            'auto.components.settings.LinearAgentSkillPane.manageConnectionLink',
            'Integrations'
          )}
        </Button>
      </p>

      <LinearApiKeyDialog
        open={linearKeyDialogOpen}
        onOpenChange={setLinearKeyDialogOpen}
        connectLabel={translate(
          'auto.components.settings.LinearAgentSkillGuide.addAccess',
          'Add access'
        )}
        onConnected={() => {
          void checkLinearConnection(true)
        }}
      />
    </SearchableSetting>
  )
}
