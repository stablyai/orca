import { getAdvancedPaneSearchEntries } from '@/components/settings/advanced-search'
import { getDeveloperPermissionsPaneSearchEntries } from '@/components/settings/developer-permissions-search'
import { getExperimentalPaneSearchEntries } from '@/components/settings/experimental-search'
import { getPluginsPaneSearchEntries } from '@/components/settings/plugins-search'
import { getPrivacyPaneSearchEntries } from '@/components/settings/privacy-search'
import { getRepositoryPaneSearchEntries } from '@/components/settings/repository-search'
import { buildSettingsProjectList } from '@/components/settings/settings-project-list'
import { getSshPaneSearchEntries } from '@/components/settings/ssh-search'
import { translate } from '@/i18n/i18n'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import { getRepoKindLabel } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import {
  Blocks,
  Bug,
  Cable,
  FlaskConical,
  Lock,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Wrench
} from 'lucide-react'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'

export function buildRemoteSettingsSections(
  { isMac, isWindowsTerminalHost, isWebClient, isDev, repos }: SettingsNavigationBuildOptions,
  runtimeEnvironmentsSearchEntry: SettingsNavSection['searchEntries'][number],
  reposById: ReadonlyMap<string, Repo>
): SettingsNavSection[] {
  const showDesktopOnlySettings = !isWebClient
  return [
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'ssh',
            title: translate('auto.hooks.useSettingsNavigationMetadata.94a5afe910', 'SSH Hosts'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.31e57d1c70',
              'Use existing machines over SSH for files, terminals, Git, and workspaces.'
            ),
            icon: Cable,
            searchEntries: getSshPaneSearchEntries(),
            group: 'remote'
          }
        ]
      : []),
    {
      id: 'servers',
      title: translate(
        'auto.hooks.useSettingsNavigationMetadata.de0c2907a1',
        'Remote Orca Servers'
      ),
      description: isWebClient
        ? 'Connect this browser to a saved Orca server.'
        : 'Pair remote Orca runtimes for persistent sessions, richer remote state, and web or mobile handoff.',
      icon: Server,
      searchEntries: [runtimeEnvironmentsSearchEntry],
      group: 'remote',
      badge: translate('auto.hooks.useSettingsNavigationMetadata.40d80bad8a', 'Beta')
    },
    ...(showDesktopOnlySettings && isMac
      ? [
          {
            id: 'developer-permissions',
            title: translate(
              'auto.hooks.useSettingsNavigationMetadata.d91ae31fbd',
              'macOS Permissions'
            ),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.65ec7d1968',
              'macOS privacy access for terminal-launched developer tools.'
            ),
            icon: ShieldCheck,
            searchEntries: getDeveloperPermissionsPaneSearchEntries(),
            group: 'security'
          }
        ]
      : []),
    {
      id: 'privacy',
      title: translate(
        'auto.hooks.useSettingsNavigationMetadata.3618579df6',
        'Privacy & Telemetry'
      ),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.8400cfe1c1',
        'Anonymous usage data and telemetry controls.'
      ),
      icon: Lock,
      searchEntries: getPrivacyPaneSearchEntries(),
      group: 'security'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'advanced',
            title: translate('auto.hooks.useSettingsNavigationMetadata.580a04cd81', 'Advanced'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.e338c507c1',
              'Low-level compatibility settings for troubleshooting.'
            ),
            icon: Wrench,
            searchEntries: getAdvancedPaneSearchEntries(),
            group: 'advanced'
          }
        ]
      : []),
    // Why: dev tooling must not be reachable from packaged/web builds even if
    // this pure metadata builder is called manually with isDev=true.
    ...(showDesktopOnlySettings && import.meta.env.DEV && isDev
      ? [
          {
            id: 'dev',
            title: translate('auto.hooks.useSettingsNavigationMetadata.dev', 'Dev Tools'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.devDescription',
              'Dev-only tools for exercising UI states.'
            ),
            // Why: distinct from the sibling Advanced section's Wrench so the two
            // entries in the same 'advanced' group stay visually distinguishable.
            icon: Bug,
            searchEntries: getDevToolsPaneSearchEntries(),
            group: 'advanced',
            badge: translate('auto.hooks.useSettingsNavigationMetadata.devBadge', 'Dev')
          }
        ]
      : []),
    {
      id: 'experimental',
      title: translate('auto.hooks.useSettingsNavigationMetadata.225071c560', 'Experimental'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.4a728cd56b',
        'New features that are still taking shape. Give them a try.'
      ),
      icon: FlaskConical,
      searchEntries: getExperimentalPaneSearchEntries(),
      group: 'experimental'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'plugins',
            title: translate('auto.hooks.useSettingsNavigationMetadata.pluginsTitle', 'Plugins'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.pluginsDescription',
              'Install and manage experimental Orca plugins.'
            ),
            icon: Blocks,
            searchEntries: getPluginsPaneSearchEntries(),
            group: 'experimental'
          }
        ]
      : []),
    // Why: one nav row per project, not per repo row — a project set up on
    // multiple hosts (local + a Remote Orca Server, or two clones) collapses to
    // a single entry. Derived from repos alone so this list matches the panes.
    ...buildSettingsProjectList(repos).map(({ project, representativeRepoId, setups }) => {
      const representativeRepo = reposById.get(representativeRepoId) ?? repos[0]
      const hostSummary =
        setups.length > 1
          ? translate(
              'auto.hooks.useSettingsNavigationMetadata.projectHostsSummary',
              '{{value0}} hosts',
              { value0: setups.length }
            )
          : (setups[0]?.path ?? representativeRepo.path)
      return {
        id: `repo-${representativeRepoId}`,
        title: project.displayName,
        description: `${getRepoKindLabel(project)} • ${hostSummary}`,
        icon: SlidersHorizontal,
        searchEntries: getRepositoryPaneSearchEntries(representativeRepo, {
          windowsRuntimeSupported: isWindowsTerminalHost
        }),
        group: 'repositories'
      }
    })
  ]
}

function getDevToolsPaneSearchEntries(): SettingsNavSection['searchEntries'] {
  return [
    {
      title: translate(
        'auto.hooks.useSettingsNavigationMetadata.devSearchNotificationPlayground',
        'Notification playground'
      ),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.devSearchNotificationPlaygroundDescription',
        'Trigger representative toast and notification UI states.'
      ),
      keywords: [
        translate('auto.hooks.useSettingsNavigationMetadata.devSearchKeywordDev', 'dev'),
        translate('auto.hooks.useSettingsNavigationMetadata.devSearchKeywordToast', 'toast'),
        translate('auto.hooks.useSettingsNavigationMetadata.devSearchKeywordSonner', 'sonner'),
        translate('auto.hooks.useSettingsNavigationMetadata.devSearchKeywordError', 'error'),
        translate(
          'auto.hooks.useSettingsNavigationMetadata.devSearchKeywordNotification',
          'notification'
        )
      ]
    }
  ]
}
