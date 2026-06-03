/* oxlint-disable max-lines */
import { createElement, useMemo } from 'react'
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
  SquareTerminal,
  TextCursorInput,
  UserCog,
  Wrench
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import logo from '../../../../resources/logo.svg'
import type { Repo } from '../../../shared/types'
import { getRepoKindLabel } from '../../../shared/repo-kind'
import { useAppStore } from '@/store'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import { GENERAL_PANE_SEARCH_ENTRIES } from '@/components/settings/general-search'
import { AGENTS_PANE_SEARCH_ENTRIES } from '@/components/settings/agents-search'
import { ACCOUNTS_PANE_SEARCH_ENTRIES } from '@/components/settings/accounts-search'
import { INTEGRATIONS_PANE_SEARCH_ENTRIES } from '@/components/settings/integrations-search'
import { GIT_PANE_SEARCH_ENTRIES } from '@/components/settings/git-search'
import { COMMIT_MESSAGE_AI_PANE_SEARCH_ENTRIES } from '@/components/settings/commit-message-ai-search'
import { TASKS_PANE_SEARCH_ENTRIES } from '@/components/settings/tasks-search'
import { FLOATING_WORKSPACE_SEARCH_ENTRIES } from '@/components/settings/floating-workspace-search'
import { APPEARANCE_PANE_SEARCH_ENTRIES } from '@/components/settings/appearance-search'
import { INPUT_PANE_SEARCH_ENTRIES } from '@/components/settings/input-search'
import { getTerminalPaneSearchEntries } from '@/components/settings/terminal-search'
import { QUICK_COMMANDS_PANE_SEARCH_ENTRIES } from '@/components/settings/quick-commands-search'
import { BROWSER_PANE_SEARCH_ENTRIES } from '@/components/settings/browser-pane-search'
import { NOTIFICATIONS_PANE_SEARCH_ENTRIES } from '@/components/settings/notifications-search'
import { ORCHESTRATION_PANE_SEARCH_ENTRIES } from '@/components/settings/orchestration-search'
import {
  RUNTIME_ENVIRONMENTS_SEARCH_ENTRY,
  WEB_RUNTIME_ENVIRONMENTS_SEARCH_ENTRY
} from '@/components/settings/runtime-environments-search'
import { SSH_PANE_SEARCH_ENTRIES } from '@/components/settings/ssh-search'
import { MOBILE_SETTINGS_PANE_SEARCH_ENTRIES } from '@/components/settings/mobile-settings-search'
import { COMPUTER_USE_PANE_SEARCH_ENTRIES } from '@/components/settings/computer-use-search'
import { VOICE_PANE_SEARCH_ENTRIES } from '@/components/settings/voice-pane-search'
import { DEVELOPER_PERMISSIONS_PANE_SEARCH_ENTRIES } from '@/components/settings/developer-permissions-search'
import { PRIVACY_PANE_SEARCH_ENTRIES } from '@/components/settings/privacy-search'
import { ADVANCED_PANE_SEARCH_ENTRIES } from '@/components/settings/advanced-search'
import { SHORTCUTS_PANE_SEARCH_ENTRIES } from '@/components/settings/shortcuts-search'
import { STATS_PANE_SEARCH_ENTRIES } from '@/components/stats/stats-search'
import { EXPERIMENTAL_PANE_SEARCH_ENTRIES } from '@/components/settings/experimental-search'
import { getRepositoryPaneSearchEntries } from '@/components/settings/repository-search'
import { cn } from '@/lib/utils'
import {
  getCachedWindowsTerminalCapabilities,
  getWindowsTerminalCapabilityOwnerKey
} from '@/lib/windows-terminal-capabilities'

function OrcaLogoSettingsIcon({ className }: LucideProps) {
  return createElement('img', {
    src: logo,
    alt: '',
    'aria-hidden': true,
    className: cn('object-contain invert dark:invert-0', className)
  })
}

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
    ? WEB_RUNTIME_ENVIRONMENTS_SEARCH_ENTRY
    : RUNTIME_ENVIRONMENTS_SEARCH_ENTRY

  return [
    // Why: this array's order must mirror SETTINGS_NAV_GROUPS so the Settings
    // sidebar and the Cmd+J palette both read top-to-bottom in the same grouped
    // order — keep each new entry beside its group's siblings.
    {
      id: 'agents',
      title: 'Agents',
      description: 'Manage AI agents, set a default, and customize commands.',
      icon: Bot,
      searchEntries: AGENTS_PANE_SEARCH_ENTRIES,
      group: 'capabilities'
    },
    {
      id: 'accounts',
      title: 'AI Provider Accounts',
      description: 'Optional account switching for Claude, Codex, Gemini, and OpenCode Go.',
      icon: UserCog,
      searchEntries: ACCOUNTS_PANE_SEARCH_ENTRIES,
      group: 'capabilities',
      badge: 'Optional'
    },
    {
      id: 'orchestration',
      title: 'Orchestration',
      description: 'Coordinate multiple coding agents through Orca.',
      icon: Network,
      searchEntries: ORCHESTRATION_PANE_SEARCH_ENTRIES,
      group: 'capabilities'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'computer-use',
            title: 'Computer Use',
            description: 'Enable agents to control any app on your computer.',
            icon: MousePointerClick,
            searchEntries: COMPUTER_USE_PANE_SEARCH_ENTRIES,
            group: 'capabilities'
          },
          {
            id: 'voice',
            title: 'Voice',
            description: 'Local speech-to-text dictation with on-device models.',
            icon: Mic,
            searchEntries: VOICE_PANE_SEARCH_ENTRIES,
            group: 'capabilities'
          }
        ]
      : []),
    {
      id: 'setup-guide',
      title: 'Onboarding checklist',
      description: 'Finish the onboarding checklist for core Orca workflows.',
      icon: OrcaLogoSettingsIcon,
      searchEntries: [
        {
          title: 'Onboarding checklist',
          description: 'Open the onboarding checklist for setup and milestone steps.',
          keywords: ['setup guide', 'get started with Orca', 'getting started']
        }
      ],
      group: 'setup'
    },
    {
      id: 'general',
      title: 'General',
      description: 'Workspace defaults, app setup, and maintenance.',
      icon: SlidersHorizontal,
      searchEntries: GENERAL_PANE_SEARCH_ENTRIES,
      group: 'setup'
    },
    {
      id: 'integrations',
      title: 'Integrations',
      description: 'Connect GitHub, GitLab, Linear, and source-hosting services.',
      icon: Blocks,
      searchEntries: INTEGRATIONS_PANE_SEARCH_ENTRIES,
      group: 'setup'
    },
    {
      id: 'git',
      title: 'Git & Source Control',
      description: 'Branch naming, base refs, attribution, and AI commit messages.',
      icon: GitBranch,
      // Why: the AI commit messages pane is rendered inside Git, so shared
      // metadata must search both surfaces wherever Git appears.
      searchEntries: [...GIT_PANE_SEARCH_ENTRIES, ...COMMIT_MESSAGE_AI_PANE_SEARCH_ENTRIES],
      group: 'workflows'
    },
    {
      id: 'tasks',
      title: 'Task Sources',
      description: 'Choose which task providers appear in the Tasks page and sidebar.',
      icon: ListChecks,
      searchEntries: TASKS_PANE_SEARCH_ENTRIES,
      group: 'workflows'
    },
    {
      id: 'terminal',
      title: 'Terminal',
      description: 'Shells, renderer, sessions, and terminal behavior.',
      icon: SquareTerminal,
      searchEntries: terminalPaneSearchEntries,
      group: 'workflows'
    },
    {
      id: 'quick-commands',
      title: 'Quick Commands',
      description: 'Saved terminal commands, scoped globally or per project.',
      icon: Play,
      searchEntries: QUICK_COMMANDS_PANE_SEARCH_ENTRIES,
      group: 'workflows'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'browser',
            title: 'Browser',
            description: 'Home page, link routing, and session cookies.',
            icon: Globe,
            searchEntries: BROWSER_PANE_SEARCH_ENTRIES,
            group: 'workflows'
          }
        ]
      : []),
    {
      id: 'floating-workspace',
      title: 'Floating Workspace',
      description: 'Global terminal, browser, and markdown tabs.',
      icon: PanelsTopLeft,
      searchEntries: FLOATING_WORKSPACE_SEARCH_ENTRIES,
      group: 'workflows'
    },
    {
      id: 'appearance',
      title: 'Appearance',
      description: 'Theme, zoom, app and terminal appearance, sidebars, and status bar.',
      icon: Palette,
      searchEntries: APPEARANCE_PANE_SEARCH_ENTRIES,
      group: 'interface'
    },
    {
      id: 'input',
      title: 'Input & Editing',
      description: 'Selection and editing behavior.',
      icon: TextCursorInput,
      searchEntries: INPUT_PANE_SEARCH_ENTRIES,
      group: 'interface'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'notifications',
            title: 'Notifications',
            description: 'Native desktop notifications for agent and terminal events.',
            icon: Bell,
            searchEntries: NOTIFICATIONS_PANE_SEARCH_ENTRIES,
            group: 'interface'
          }
        ]
      : []),
    {
      id: 'shortcuts',
      title: 'Shortcuts',
      description: 'Keyboard shortcuts for common actions.',
      icon: Keyboard,
      searchEntries: SHORTCUTS_PANE_SEARCH_ENTRIES,
      group: 'interface'
    },
    {
      id: 'stats',
      title: 'Stats & Usage',
      description: 'Orca stats plus Claude, Codex, and OpenCode usage analytics.',
      icon: BarChart3,
      searchEntries: STATS_PANE_SEARCH_ENTRIES,
      group: 'interface'
    },
    {
      id: 'servers',
      title: 'Remote Orca Servers',
      description: isWebClient
        ? 'Connect this browser to a saved Orca server.'
        : 'Switch between local desktop mode and paired remote Orca runtimes.',
      icon: Server,
      searchEntries: [runtimeEnvironmentsSearchEntry],
      group: 'remote',
      badge: 'Beta'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'ssh',
            title: 'SSH Hosts',
            description: 'Remote SSH hosts for files, terminals, and git.',
            icon: Cable,
            searchEntries: SSH_PANE_SEARCH_ENTRIES,
            group: 'remote'
          },
          {
            id: 'mobile',
            title: 'Mobile',
            description: 'Control terminals and agents from your phone.',
            icon: Smartphone,
            searchEntries: MOBILE_SETTINGS_PANE_SEARCH_ENTRIES,
            group: 'remote'
          }
        ]
      : []),
    ...(showDesktopOnlySettings && isMac
      ? [
          {
            id: 'developer-permissions',
            title: 'macOS Permissions',
            description: 'macOS privacy access for terminal-launched developer tools.',
            icon: ShieldCheck,
            searchEntries: DEVELOPER_PERMISSIONS_PANE_SEARCH_ENTRIES,
            group: 'security'
          }
        ]
      : []),
    {
      id: 'privacy',
      title: 'Privacy & Telemetry',
      description: 'Anonymous usage data and telemetry controls.',
      icon: Lock,
      searchEntries: PRIVACY_PANE_SEARCH_ENTRIES,
      group: 'security'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'advanced',
            title: 'Advanced',
            description: 'Low-level compatibility settings for troubleshooting.',
            icon: Wrench,
            searchEntries: ADVANCED_PANE_SEARCH_ENTRIES,
            group: 'advanced'
          }
        ]
      : []),
    {
      id: 'experimental',
      title: 'Experimental',
      description: 'New features that are still taking shape. Give them a try.',
      icon: FlaskConical,
      searchEntries: EXPERIMENTAL_PANE_SEARCH_ENTRIES,
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
    [isMac, isWindows, isWindowsTerminalHost, isWebClient, repos]
  )
}
