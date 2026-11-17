import { getArtifactsSettingsSearchEntries } from '@/components/settings/artifacts/artifacts-settings-search'
import { getAutomationsSettingsSearchEntries } from '@/components/settings/automations/automations-settings-search'
import { getBrowserPaneCombinedSearchEntries } from '@/components/settings/browser/browser-pane-search'
import { getCommitMessageAiPaneSearchEntries } from '@/components/settings/source-control/commit-message-ai-search'
import { getFloatingWorkspaceSearchEntries } from '@/components/settings/floating-workspaces/floating-workspace-search'
import { getGitProviderApiBudgetSearchEntries } from '@/components/settings/source-control/git-provider-api-budget-search'
import { getGitPaneSearchEntries } from '@/components/settings/source-control/git-search'
import { getPerforcePaneSearchEntries } from '@/components/settings/perforce-search'
import { getMobileEmulatorSearchEntries } from '@/components/settings/mobile/emulator/mobile-emulator-search'
import { getQuickCommandsPaneSearchEntries } from '@/components/settings/quick-commands/quick-commands-search'
import { getShareSkillsSettingsSearchEntries } from '@/components/settings/skills/sharing/share-skills-settings-search'
import { getTasksPaneSearchEntries } from '@/components/settings/tasks/tasks-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsNavSection } from '@/components/settings/navigation/settings-navigation-types'
import {
  BookOpen,
  CalendarClock,
  Files,
  History,
  GitBranch,
  Globe,
  ListChecks,
  PanelsTopLeft,
  Play,
  SquareTerminal,
  TabletSmartphone
} from 'lucide-react'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'

export function buildWorkflowSettingsSections(
  { isWebClient }: SettingsNavigationBuildOptions,
  terminalPaneSearchEntries: SettingsNavSection['searchEntries'],
  t: Translate = translate
): SettingsNavSection[] {
  const showDesktopOnlySettings = !isWebClient
  return [
    {
      id: 'automations',
      title: t('auto.hooks.useSettingsNavigationMetadata.automationsTitle', 'Automations'),
      description: t(
        'auto.hooks.useSettingsNavigationMetadata.automationsDescription',
        'Schedule agent work and choose whether Automations appears in the sidebar.'
      ),
      icon: CalendarClock,
      searchEntries: getAutomationsSettingsSearchEntries(),
      group: 'workflows'
    },
    {
      id: 'artifacts',
      title: t('auto.hooks.useSettingsNavigationMetadata.artifactsTitle', 'Artifacts'),
      description: t(
        'auto.hooks.useSettingsNavigationMetadata.artifactsDescription',
        'Share HTML and Markdown files with your team and manage their public links.'
      ),
      icon: Files,
      searchEntries: getArtifactsSettingsSearchEntries(),
      group: 'workflows',
      badge: t('auto.hooks.useSettingsNavigationMetadata.40d80bad8a', 'Beta')
    },
    {
      id: 'share-skills',
      title: t('auto.hooks.useSettingsNavigationMetadata.shareSkillsTitle', 'Share Skills'),
      description: t(
        'auto.hooks.useSettingsNavigationMetadata.shareSkillsDescription',
        'Share your skills with an unlisted link. Anyone who has it can install them.'
      ),
      // Match the skills sidebar/page icon in its settings entry.
      icon: BookOpen,
      searchEntries: getShareSkillsSettingsSearchEntries(),
      group: 'workflows',
      badge: t('auto.hooks.useSettingsNavigationMetadata.40d80bad8a', 'Beta')
    },
    {
      id: 'session-history',
      title: t('sessionHistory.settings.title', 'Agent Session Search'),
      description: t(
        'sessionHistory.settings.description',
        'Search everything your agents have said and done, on this computer and on any paired Orca server.'
      ),
      icon: History,
      searchEntries: [
        {
          title: t('sessionHistory.settings.indexComputers', 'Search inside sessions'),
          description: t(
            'sessionHistory.settings.searchDescription',
            'Turn on session search for this computer and paired servers, or clear search data.'
          )
        }
      ],
      group: 'workflows'
    },
    {
      id: 'git',
      title: t('auto.hooks.useSettingsNavigationMetadata.09607cb0fe', 'Git & Source Control'),
      description: t(
        'auto.hooks.useSettingsNavigationMetadata.ab4b21b58e',
        'Branch naming, base refs, and Git AI Author.'
      ),
      icon: GitBranch,
      // Git AI Author lives inside Git, so search metadata covers both surfaces.
      searchEntries: [
        ...getGitPaneSearchEntries(),
        ...getCommitMessageAiPaneSearchEntries(),
        ...getGitProviderApiBudgetSearchEntries()
      ],
      group: 'workflows'
    },
    {
      id: 'perforce',
      title: translate('perforce.settings.navTitle', 'Perforce'),
      description: translate(
        'perforce.settings.navDescription',
        'Connection, Source Control behavior, changelists, and shelves.'
      ),
      icon: GitBranch,
      searchEntries: getPerforcePaneSearchEntries(),
      group: 'workflows'
    },
    {
      id: 'tasks',
      title: t('auto.hooks.useSettingsNavigationMetadata.85f4fd7710', 'Task Sources'),
      description: t(
        'auto.hooks.useSettingsNavigationMetadata.tasksDescription',
        'Connect providers, install the Linear skill, and choose what appears in Tasks.'
      ),
      icon: ListChecks,
      searchEntries: getTasksPaneSearchEntries(),
      group: 'workflows'
    },
    {
      id: 'terminal',
      title: t('auto.hooks.useSettingsNavigationMetadata.a9fb10afca', 'Terminal'),
      description: t(
        'auto.hooks.useSettingsNavigationMetadata.c33bfd664c',
        'Shells, renderer, sessions, and terminal behavior.'
      ),
      icon: SquareTerminal,
      searchEntries: terminalPaneSearchEntries,
      group: 'workflows'
    },
    {
      id: 'quick-commands',
      title: t('auto.hooks.useSettingsNavigationMetadata.3fc3db144f', 'Quick Commands'),
      description: t(
        'auto.hooks.useSettingsNavigationMetadata.42ae40842f',
        'Saved terminal commands, scoped globally or per project.'
      ),
      icon: Play,
      searchEntries: getQuickCommandsPaneSearchEntries(),
      group: 'workflows'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'browser',
            title: t('auto.hooks.useSettingsNavigationMetadata.8c197f74a1', 'Browser'),
            description: t(
              'auto.hooks.useSettingsNavigationMetadata.e815fd01bd',
              'Home page, link routing, and session cookies.'
            ),
            icon: Globe,
            searchEntries: getBrowserPaneCombinedSearchEntries(),
            group: 'workflows'
          }
        ]
      : []),
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'mobile-emulator',
            title: t('auto.hooks.useSettingsNavigationMetadata.1e761cff2b', 'Mobile Emulator'),
            description: t(
              'auto.hooks.useSettingsNavigationMetadata.3d65d3f1b9',
              'Configure mobile emulator support for Orca and coding agents.'
            ),
            icon: TabletSmartphone,
            searchEntries: getMobileEmulatorSearchEntries(),
            group: 'workflows'
          }
        ]
      : []),
    {
      id: 'floating-workspace',
      title: t('auto.hooks.useSettingsNavigationMetadata.65b19f5bde', 'Floating Workspace'),
      description: showDesktopOnlySettings
        ? t(
            'auto.hooks.useSettingsNavigationMetadata.2d0659f6f0',
            'Global terminal, browser, and markdown tabs.'
          )
        : t(
            'auto.hooks.useSettingsNavigationMetadata.floatingWorkspaceWebDescription',
            'Global terminal and markdown tabs.'
          ),
      icon: PanelsTopLeft,
      searchEntries: getFloatingWorkspaceSearchEntries({
        includeBrowser: showDesktopOnlySettings
      }),
      group: 'workflows'
    }
  ]
}
