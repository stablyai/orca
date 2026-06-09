/* oxlint-disable max-lines */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
// Why: this registry mirrors the Settings sidebar in one neutral module so
// Cmd+J and Settings visibility cannot drift. Keep it free of Settings pane UI
// imports; the boundary is enforced by a focused architecture test.
import {
  BarChart3,
  Bell,
  Blocks,
  Bot,
  Cable,
  FlaskConical,
  GitBranch,
  Globe,
  Keyboard,
  ListChecks,
  Lock,
  Mic,
  MousePointerClick,
  Network,
  Palette,
  PanelsTopLeft,
  Play,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  TabletSmartphone,
  SquareTerminal,
  TextCursorInput,
  UserCog,
  Wrench
} from 'lucide-react'
import { OrcaLogoSettingsIcon } from '@/components/settings/orca-logo-settings-icon'
import type { Repo } from '../../../shared/types'
import { getRepoKindLabel } from '../../../shared/repo-kind'
import { useAppStore } from '@/store'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import { getGeneralPaneSearchEntries } from '@/components/settings/general-search'
import { getAgentsPaneSearchEntries } from '@/components/settings/agents-search'
import { getAccountsPaneSearchEntries } from '@/components/settings/accounts-search'
import { getIntegrationsPaneSearchEntries } from '@/components/settings/integrations-search'
import { getGitPaneSearchEntries } from '@/components/settings/git-search'
import { getCommitMessageAiPaneSearchEntries } from '@/components/settings/commit-message-ai-search'
import { getTasksPaneSearchEntries } from '@/components/settings/tasks-search'
import { getFloatingWorkspaceSearchEntries } from '@/components/settings/floating-workspace-search'
import { getAppearancePaneSearchEntries } from '@/components/settings/appearance-search'
import { getInputPaneSearchEntries } from '@/components/settings/input-search'
import { getTerminalPaneSearchEntries } from '@/components/settings/terminal-search'
import { getQuickCommandsPaneSearchEntries } from '@/components/settings/quick-commands-search'
import { getBrowserPaneCombinedSearchEntries } from '@/components/settings/browser-pane-search'
import { getNotificationsPaneSearchEntries } from '@/components/settings/notifications-search'
import { getOrchestrationPaneSearchEntries } from '@/components/settings/orchestration-search'
import {
  getRuntimeEnvironmentsSearchEntry,
  getWebRuntimeEnvironmentsSearchEntry
} from '@/components/settings/runtime-environments-search'
import { getSshPaneSearchEntries } from '@/components/settings/ssh-search'
import { getMobileSettingsPaneSearchEntries } from '@/components/settings/mobile-settings-search'
import { getMobileEmulatorSearchEntries } from '@/components/settings/mobile-emulator-search'
import { getComputerUsePaneSearchEntries } from '@/components/settings/computer-use-search'
import { getVoicePaneSearchEntries } from '@/components/settings/voice-pane-search'
import { getDeveloperPermissionsPaneSearchEntries } from '@/components/settings/developer-permissions-search'
import { getPrivacyPaneSearchEntries } from '@/components/settings/privacy-search'
import { getAdvancedPaneSearchEntries } from '@/components/settings/advanced-search'
import { getShortcutsPaneSearchEntries } from '@/components/settings/shortcuts-search'
import { getStatsPaneSearchEntries } from '@/components/stats/stats-search'
import { getExperimentalPaneSearchEntries } from '@/components/settings/experimental-search'
import { getRepositoryPaneSearchEntries } from '@/components/settings/repository-search'
import {
  getCachedWindowsTerminalCapabilities,
  getWindowsTerminalCapabilityOwnerKey
} from '@/lib/windows-terminal-capabilities'
import { translate } from '@/i18n/i18n'

export function isWebClientLocation(): boolean {
  return (
    Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) ||
    window.location.pathname.endsWith('/web-index.html')
  )
}

export function buildSettingsNavigationMetadata({
  isMac,
  isWindows,
  isWindowsTerminalHost = isWindows,
  isWebClient,
  repos
}: {
  isMac: boolean
  isWindows: boolean
  isWindowsTerminalHost?: boolean
  isWebClient: boolean
  repos: readonly Repo[]
}): SettingsNavSection[] {
  const showDesktopOnlySettings = !isWebClient
  const terminalPaneSearchEntries = getTerminalPaneSearchEntries({
    isWindows: isWindowsTerminalHost,
    isMac
  })
  const runtimeEnvironmentsSearchEntry = isWebClient
    ? getWebRuntimeEnvironmentsSearchEntry()
    : getRuntimeEnvironmentsSearchEntry()

  return [
    // Why: this array's order must mirror SETTINGS_NAV_GROUPS so the Settings
    // sidebar and the Cmd+J palette both read top-to-bottom in the same grouped
    // order — keep each new entry beside its group's siblings.
    {
      id: 'agents',
      title: translate('auto.hooks.useSettingsNavigationMetadata.b49abbd2f7', 'Agents'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.4121f7a0a2',
        'Manage AI agents, set a default, and customize commands.'
      ),
      icon: Bot,
      searchEntries: getAgentsPaneSearchEntries(),
      group: 'capabilities'
    },
    {
      id: 'accounts',
      title: translate(
        'auto.hooks.useSettingsNavigationMetadata.f70ac54d38',
        'AI Provider Accounts'
      ),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.b1c2f8b0ac',
        'Optional account switching for Claude, Codex, Gemini, and OpenCode Go.'
      ),
      icon: UserCog,
      searchEntries: getAccountsPaneSearchEntries(),
      group: 'capabilities',
      badge: translate('auto.hooks.useSettingsNavigationMetadata.7c79d3b7bf', 'Optional')
    },
    {
      id: 'orchestration',
      title: translate('auto.hooks.useSettingsNavigationMetadata.58a868e8e4', 'Orchestration'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.cd50cec5d7',
        'Coordinate multiple coding agents through Orca.'
      ),
      icon: Network,
      searchEntries: getOrchestrationPaneSearchEntries(),
      group: 'capabilities'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'computer-use',
            title: translate('auto.hooks.useSettingsNavigationMetadata.b35e92364b', 'Computer Use'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.0059bd17f3',
              'Enable agents to control any app on your computer.'
            ),
            icon: MousePointerClick,
            searchEntries: getComputerUsePaneSearchEntries(),
            group: 'capabilities'
          },
          {
            id: 'voice',
            title: translate('auto.hooks.useSettingsNavigationMetadata.6a50cdcd7c', 'Voice'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.8ac3de82f5',
              'Local speech-to-text dictation with on-device models.'
            ),
            icon: Mic,
            searchEntries: getVoicePaneSearchEntries(),
            group: 'capabilities'
          }
        ]
      : []),
    {
      id: 'setup-guide',
      title: translate(
        'auto.hooks.useSettingsNavigationMetadata.ded9e9032f',
        'Onboarding checklist'
      ),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.5f32ac08f3',
        'Finish the onboarding checklist for core Orca workflows.'
      ),
      icon: OrcaLogoSettingsIcon,
      searchEntries: [
        {
          title: translate(
            'auto.hooks.useSettingsNavigationMetadata.ded9e9032f',
            'Onboarding checklist'
          ),
          description: translate(
            'auto.hooks.useSettingsNavigationMetadata.17005c73d4',
            'Open the onboarding checklist for setup and milestone steps.'
          ),
          keywords: [
            translate('auto.hooks.useSettingsNavigationMetadata.ea0b1bc7b8', 'setup guide'),
            translate(
              'auto.hooks.useSettingsNavigationMetadata.0505d0df29',
              'get started with Orca'
            ),
            translate('auto.hooks.useSettingsNavigationMetadata.724c440e72', 'getting started')
          ]
        }
      ],
      group: 'setup'
    },
    {
      id: 'general',
      title: translate('auto.hooks.useSettingsNavigationMetadata.13241992bd', 'General'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.2cd4ea75da',
        'Workspace defaults, app setup, and maintenance.'
      ),
      icon: SlidersHorizontal,
      searchEntries: getGeneralPaneSearchEntries(),
      group: 'setup'
    },
    {
      id: 'integrations',
      title: translate('auto.hooks.useSettingsNavigationMetadata.2b043783ef', 'Integrations'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.33a5e1d597',
        'Connect GitHub, GitLab, Linear, and source-hosting services.'
      ),
      icon: Blocks,
      searchEntries: getIntegrationsPaneSearchEntries(),
      group: 'setup'
    },
    {
      id: 'git',
      title: translate(
        'auto.hooks.useSettingsNavigationMetadata.09607cb0fe',
        'Git & Source Control'
      ),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.ab4b21b58e',
        'Branch naming, base refs, attribution, and Git AI Author.'
      ),
      icon: GitBranch,
      // Why: Git AI Author is rendered inside Git, so shared
      // metadata must search both surfaces wherever Git appears.
      searchEntries: [...getGitPaneSearchEntries(), ...getCommitMessageAiPaneSearchEntries()],
      group: 'workflows'
    },
    {
      id: 'tasks',
      title: translate('auto.hooks.useSettingsNavigationMetadata.85f4fd7710', 'Task Sources'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.5235c215ca',
        'Choose which task providers appear in the Tasks page and sidebar.'
      ),
      icon: ListChecks,
      searchEntries: getTasksPaneSearchEntries(),
      group: 'workflows'
    },
    {
      id: 'terminal',
      title: translate('auto.hooks.useSettingsNavigationMetadata.a9fb10afca', 'Terminal'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.c33bfd664c',
        'Shells, renderer, sessions, and terminal behavior.'
      ),
      icon: SquareTerminal,
      searchEntries: terminalPaneSearchEntries,
      group: 'workflows'
    },
    {
      id: 'quick-commands',
      title: translate('auto.hooks.useSettingsNavigationMetadata.3fc3db144f', 'Quick Commands'),
      description: translate(
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
            title: translate('auto.hooks.useSettingsNavigationMetadata.8c197f74a1', 'Browser'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.e815fd01bd',
              'Home page, link routing, and session cookies.'
            ),
            icon: Globe,
            searchEntries: getBrowserPaneCombinedSearchEntries(),
            group: 'workflows'
          }
        ]
      : []),
    ...(showDesktopOnlySettings && isMac
      ? [
          {
            id: 'mobile-emulator',
            title: translate(
              'auto.hooks.useSettingsNavigationMetadata.1e761cff2b',
              'Mobile Emulator'
            ),
            description: translate(
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
      title: translate('auto.hooks.useSettingsNavigationMetadata.65b19f5bde', 'Floating Workspace'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.2d0659f6f0',
        'Global terminal, browser, and markdown tabs.'
      ),
      icon: PanelsTopLeft,
      searchEntries: getFloatingWorkspaceSearchEntries(),
      group: 'workflows'
    },
    {
      id: 'appearance',
      title: translate('auto.hooks.useSettingsNavigationMetadata.93d88d20bf', 'Appearance'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.b11a5a48a2',
        'Theme, zoom, app and terminal appearance, sidebars, and status bar.'
      ),
      icon: Palette,
      searchEntries: getAppearancePaneSearchEntries(),
      group: 'interface'
    },
    {
      id: 'input',
      title: translate('auto.hooks.useSettingsNavigationMetadata.0c6ee88a5f', 'Input & Editing'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.1f452cbd4c',
        'Selection and editing behavior.'
      ),
      icon: TextCursorInput,
      searchEntries: getInputPaneSearchEntries(),
      group: 'interface'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'notifications',
            title: translate(
              'auto.hooks.useSettingsNavigationMetadata.2eece16ad1',
              'Notifications'
            ),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.7682607591',
              'Native desktop notifications for agent and terminal events.'
            ),
            icon: Bell,
            searchEntries: getNotificationsPaneSearchEntries(),
            group: 'interface'
          }
        ]
      : []),
    {
      id: 'shortcuts',
      title: translate('auto.hooks.useSettingsNavigationMetadata.94295ebfb3', 'Shortcuts'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.dcd0d9b74f',
        'Keyboard shortcuts for common actions.'
      ),
      icon: Keyboard,
      searchEntries: getShortcutsPaneSearchEntries(),
      group: 'interface'
    },
    {
      id: 'stats',
      title: translate('auto.hooks.useSettingsNavigationMetadata.d72a58b5b9', 'Stats & Usage'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.b351014180',
        'Orca stats plus Claude, Codex, and OpenCode usage analytics.'
      ),
      icon: BarChart3,
      searchEntries: getStatsPaneSearchEntries(),
      group: 'interface'
    },
    {
      id: 'servers',
      title: translate(
        'auto.hooks.useSettingsNavigationMetadata.de0c2907a1',
        'Remote Orca Servers'
      ),
      description: isWebClient
        ? 'Connect this browser to a saved Orca server.'
        : 'Switch between local desktop mode and paired remote Orca runtimes.',
      icon: Server,
      searchEntries: [runtimeEnvironmentsSearchEntry],
      group: 'remote',
      badge: translate('auto.hooks.useSettingsNavigationMetadata.40d80bad8a', 'Beta')
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'ssh',
            title: translate('auto.hooks.useSettingsNavigationMetadata.94a5afe910', 'SSH Hosts'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.31e57d1c70',
              'Remote SSH hosts for files, terminals, and git.'
            ),
            icon: Cable,
            searchEntries: getSshPaneSearchEntries(),
            group: 'remote'
          },
          {
            id: 'mobile',
            title: translate('auto.hooks.useSettingsNavigationMetadata.1cd25673df', 'Mobile'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.95a1886d94',
              'Control terminals and agents from your phone.'
            ),
            icon: Smartphone,
            searchEntries: getMobileSettingsPaneSearchEntries(),
            group: 'remote'
          }
        ]
      : []),
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
    ...repos.map((repo) => ({
      id: `repo-${repo.id}`,
      title: repo.displayName,
      description: `${getRepoKindLabel(repo)} • ${repo.path}`,
      icon: SlidersHorizontal,
      searchEntries: getRepositoryPaneSearchEntries(repo),
      group: 'repositories'
    }))
  ]
}

export function useSettingsNavigationMetadata(): SettingsNavSection[] {
  const { i18n } = useTranslation()
  const repos = useAppStore((state) => state.repos)
  const activeRuntimeEnvironmentId = useAppStore(
    (state) => state.settings?.activeRuntimeEnvironmentId
  )
  const isMac = isMacUserAgent()
  const isWindows = isWindowsUserAgent()
  const isWebClient = isWebClientLocation()
  const windowsTerminalCapabilityOwnerKey = getWindowsTerminalCapabilityOwnerKey(
    activeRuntimeEnvironmentId
  )
  const isWindowsTerminalHost =
    isWindows ||
    getCachedWindowsTerminalCapabilities(windowsTerminalCapabilityOwnerKey).hostPlatform === 'win32'

  // Why: Settings and Cmd+J share this metadata so platform/runtime visibility
  // and search entries cannot drift. Keep this hook free of Settings pane UI
  // imports; see docs/reference/cmd-j-settings-actions-plan.md.
  return useMemo(
    () =>
      buildSettingsNavigationMetadata({
        isMac,
        isWindows,
        isWindowsTerminalHost,
        isWebClient,
        repos
      }),
    [i18n.language, isMac, isWindows, isWindowsTerminalHost, isWebClient, repos]
  )
}
