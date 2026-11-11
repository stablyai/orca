import { useState } from 'react'
import {
  ArrowRightCircle,
  BookOpen,
  Link2,
  ListTodo,
  MessageSquarePlus,
  type LucideIcon
} from 'lucide-react'

import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { ORCA_LINEAR_SKILL_NAME } from '@/lib/skills/installation/agent-feature-skill-names'
import { getLinearUsageExamples } from '@/lib/work-items/linear/linear-usage-examples'
import type { SkillUsageExample } from '@/lib/skills/examples/skill-usage-example'
import { useLinearProviderConnected } from '@/hooks/useLinearProviderConnected'
import { normalizeVisibleTaskProviders } from '../../../../../../shared/work-items/task-providers'
import { getProviderRuntimeContextKey } from '@/runtime/hosts/observations/provider-runtime-context'
import { AgentSkillSetupPanel } from '../../../skills/setup/AgentSkillSetupPanel'
import { LinearAgentSkillGuide } from './LinearAgentSkillGuide'
import { LinearAgentSkillNotes } from './LinearAgentSkillNotes'
import { getLinearAgentSkillPaneSearchEntries } from './linear-agent-skill-search'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SkillUsageExamplesSection } from '../../../skills/examples/SkillUsageExamplesSection'
import { LINEAR_INTEGRATION_SECTION_ID } from '../../../integrations/task-trackers/task-provider-integration-section-ids'
import { useLinearAgentSkillSetup } from '../../../../hooks/skills/installation/use-linear-agent-skill-setup'
import { useTranslate } from '@/i18n/use-translate'

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

export function LinearAgentSkillPane(): React.JSX.Element {
  const t = useTranslate()
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
      title={t('auto.components.settings.LinearAgentSkillPane.skillTitle', 'Linear skill')}
      description={null}
      skillNames={[ORCA_LINEAR_SKILL_NAME]}
      installedSkillNames={[skillSetup.updateSkillName]}
      installed={skillSetup.skillInstalled}
      loading={skillSetup.skillLoading}
      error={skillSetup.error}
      installDisabled={skillSetup.installDisabled}
      onRecheck={skillSetup.refreshSkill}
      freshnessSkillName={skillSetup.freshnessSkillName}
    />
  )

  return (
    <SearchableSetting
      title={t('auto.components.settings.LinearAgentSkillPane.title', 'Linear')}
      description={t(
        'auto.components.settings.LinearAgentSkillPane.description',
        'How Linear works in Orca: browse issues, start linked workspaces, and let agents update tickets with /orca-linear.'
      )}
      keywords={getLinearAgentSkillPaneSearchEntries()[0].keywords}
      className="space-y-8"
    >
      <LinearAgentSkillGuide
        readiness={{
          connected: linearConnected,
          checking: connectionChecking,
          skillInstalled: skillSetup.skillInstalled,
          skillChecking: skillSetup.skillChecking,
          skillUnverifiable: skillSetup.skillUnverifiable,
          visible: visibleInTasks
        }}
        onOpenTaskSources={openTaskSources}
        onManageLinearAccess={
          linearConnected ? openIntegrationSettings : () => setLinearKeyDialogOpen(true)
        }
        skillPanel={skillPanel}
      />

      <SkillUsageExamplesSection
        heading={t('auto.components.settings.LinearAgentSkillPane.howToUse', 'Example prompts')}
        description={t(
          'auto.components.settings.LinearAgentSkillPane.howToUseDescription',
          'Click a card to copy a prompt. Use these in a Linear-linked worktree after the skill is installed.'
        )}
        examples={getLinearUsageExamples()}
        resolveIcon={resolveLinearExampleIcon}
        slashCommand={`/${ORCA_LINEAR_SKILL_NAME}`}
      />

      <LinearAgentSkillNotes />

      <p className="px-1 text-xs text-muted-foreground">
        {t(
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
          {t('auto.components.settings.LinearAgentSkillPane.manageConnectionLink', 'Integrations')}
        </Button>
      </p>

      <LinearApiKeyDialog
        open={linearKeyDialogOpen}
        onOpenChange={setLinearKeyDialogOpen}
        connectLabel={t('auto.components.settings.LinearAgentSkillGuide.addAccess', 'Add access')}
        onConnected={() => {
          void checkLinearConnection(true)
        }}
      />
    </SearchableSetting>
  )
}
