/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Bell,
  Bot,
  Cable,
  FlaskConical,
  GitBranch,
  Globe,
  Info,
  Keyboard,
  ListChecks,
  Lock,
  MousePointerClick,
  Network,
  PanelsTopLeft,
  ShieldCheck,
  Palette,
  Server,
  SlidersHorizontal,
  Smartphone,
  Blocks,
  Mic,
  SquareTerminal,
  TextCursorInput,
  UserCog
} from 'lucide-react'
import type { OrcaHooks } from '../../../../shared/types'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import { useAppStore } from '../../store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { applyDocumentTheme } from '@/lib/document-theme'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { SCROLLBACK_PRESETS_MB, getFallbackTerminalFonts } from './SettingsConstants'
import { DEFAULT_APP_FONT_FAMILY } from '../../../../shared/constants'
import { GeneralPane, GENERAL_PANE_SEARCH_ENTRIES } from './GeneralPane'
import { BrowserPane, BROWSER_PANE_SEARCH_ENTRIES } from './BrowserPane'
import { AppearancePane, APPEARANCE_PANE_SEARCH_ENTRIES } from './AppearancePane'
import { InputPane, INPUT_PANE_SEARCH_ENTRIES } from './InputPane'
import { ShortcutsPane, SHORTCUTS_PANE_SEARCH_ENTRIES } from './ShortcutsPane'
import { TerminalPane } from './TerminalPane'
import { FloatingWorkspacePane } from './FloatingWorkspacePane'
import { useGhosttyImport } from './useGhosttyImport'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import ghosttyIcon from '../../../../../resources/ghostty.svg'
import { RepositoryPane, getRepositoryPaneSearchEntries } from './RepositoryPane'
import { getTerminalPaneSearchEntries } from './terminal-search'
import { FLOATING_WORKSPACE_SEARCH_ENTRIES } from './floating-workspace-search'
import { GitPane, GIT_PANE_SEARCH_ENTRIES } from './GitPane'
import { CommitMessageAiPane } from './CommitMessageAiPane'
import { COMMIT_MESSAGE_AI_PANE_SEARCH_ENTRIES } from './commit-message-ai-search'
import { NotificationsPane, NOTIFICATIONS_PANE_SEARCH_ENTRIES } from './NotificationsPane'
import { VoicePane } from './VoicePane'
import { VOICE_PANE_SEARCH_ENTRIES } from './voice-pane-search'
import { SshPane, SSH_PANE_SEARCH_ENTRIES } from './SshPane'
import { ExperimentalPane, EXPERIMENTAL_PANE_SEARCH_ENTRIES } from './ExperimentalPane'
import { AgentsPane, AGENTS_PANE_SEARCH_ENTRIES } from './AgentsPane'
import { OrchestrationPane } from './OrchestrationPane'
import { ORCHESTRATION_PANE_SEARCH_ENTRIES } from './orchestration-search'
import { AccountsPane, ACCOUNTS_PANE_SEARCH_ENTRIES } from './AccountsPane'
import { StatsPane, STATS_PANE_SEARCH_ENTRIES } from '../stats/StatsPane'
import { IntegrationsPane, INTEGRATIONS_PANE_SEARCH_ENTRIES } from './IntegrationsPane'
import { TasksPane } from './TasksPane'
import { TASKS_PANE_SEARCH_ENTRIES } from './tasks-search'
import {
  DeveloperPermissionsPane,
  DEVELOPER_PERMISSIONS_PANE_SEARCH_ENTRIES
} from './DeveloperPermissionsPane'
import { ComputerUsePane, COMPUTER_USE_PANE_SEARCH_ENTRIES } from './ComputerUsePane'
import { MobileSettingsPane, MOBILE_SETTINGS_PANE_SEARCH_ENTRIES } from './MobileSettingsPane'
import { RuntimeEnvironmentsPane } from './RuntimeEnvironmentsPane'
import {
  RUNTIME_ENVIRONMENTS_SEARCH_ENTRY,
  WEB_RUNTIME_ENVIRONMENTS_SEARCH_ENTRY
} from './runtime-environments-search'
import { PrivacyPane } from './PrivacyPane'
import { PRIVACY_PANE_SEARCH_ENTRIES } from './privacy-search'
import { SettingsSidebar } from './SettingsSidebar'
import { ActiveSettingsSectionProvider, SettingsSection } from './SettingsSection'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { useWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import {
  deriveNeededRepoIds,
  deriveNeededSectionIds,
  getInitialMountedSectionIds,
  getRuntimeTargetIdentity
} from './settings-load-performance'

type SettingsNavTarget =
  | 'general'
  | 'integrations'
  | 'accounts'
  | 'browser'
  | 'git'
  | 'tasks'
  | 'appearance'
  | 'input'
  | 'floating-workspace'
  | 'terminal'
  | 'notifications'
  | 'computer-use'
  | 'developer-permissions'
  | 'privacy'
  | 'voice'
  | 'shortcuts'
  | 'stats'
  | 'ssh'
  | 'privacy'
  | 'experimental'
  | 'agents'
  | 'orchestration'
  | 'servers'
  | 'mobile'
  | 'repo'

type SettingsNavSection = {
  id: string
  title: string
  description: string
  icon: typeof SlidersHorizontal
  searchEntries: SettingsSearchEntry[]
  group: string
  badge?: string
}

type SettingsNavGroup = {
  id: string
  title: string
  sections: SettingsNavSection[]
}

const SETTINGS_NAV_GROUPS = [
  { id: 'setup', title: 'Set Up' },
  { id: 'workflows', title: 'Workflows' },
  { id: 'interface', title: 'Interface' },
  { id: 'capabilities', title: 'AI Capabilities' },
  { id: 'remote', title: 'Remote Access' },
  { id: 'safety', title: 'Safety' },
  { id: 'experimental', title: 'Experimental' }
] as const

function getSettingsSectionId(pane: SettingsNavTarget, repoId: string | null): string {
  if (pane === 'repo' && repoId) {
    return `repo-${repoId}`
  }
  return pane
}

function getFallbackVisibleSection(sections: SettingsNavSection[]): SettingsNavSection | undefined {
  return sections.at(0)
}

function computerUsePlatformLabel(args: { isWindows: boolean; isMac: boolean }): string {
  if (args.isWindows) {
    return 'Windows'
  }
  if (!args.isMac) {
    return 'Linux'
  }
  return 'This platform'
}

function getSettingsScrollTarget(
  sectionId: string,
  container?: HTMLElement | null
): HTMLElement | null {
  return (
    container?.querySelector<HTMLElement>(`[data-settings-section="${CSS.escape(sectionId)}"]`) ??
    document.getElementById(sectionId)
  )
}

function scrollSubsectionIntoView(targetId: string, container?: HTMLElement | null): void {
  // Why: deep links into Settings can target a specific subsection inside a
  // pane (e.g. a particular row). The pane itself is now swapped in
  // wholesale, so this only needs to nudge the inner scroll if the pane has
  // grown taller than the viewport.
  const target = getSettingsScrollTarget(targetId, container)
  if (!target) {
    return
  }
  if (!container) {
    target.scrollIntoView({ block: 'start' })
    return
  }
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const targetTop = targetRect.top - containerRect.top + container.scrollTop
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
  container.scrollTo({ top: Math.min(Math.max(0, targetTop - 16), maxScrollTop) })
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.isContentEditable) {
    return true
  }
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function isWebClientLocation(): boolean {
  return (
    Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__) ||
    window.location.pathname.endsWith('/web-index.html')
  )
}

function Settings(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const switchRuntimeEnvironment = useAppStore((s) => s.switchRuntimeEnvironment)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const closeSettingsPage = useAppStore((s) => s.closeSettingsPage)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const removeRepo = useAppStore((s) => s.removeRepo)
  const settingsNavigationTarget = useAppStore((s) => s.settingsNavigationTarget)
  const clearSettingsTarget = useAppStore((s) => s.clearSettingsTarget)
  const settingsSearchInputQuery = useAppStore((s) => s.settingsSearchInputQuery)
  const settingsSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)

  const [repoHooksMap, setRepoHooksMap] = useState<
    Record<string, { hasHooks: boolean; hooks: OrcaHooks | null; mayNeedUpdate: boolean }>
  >({})
  const systemPrefersDark = useSystemPrefersDark()
  const isWindows = isWindowsUserAgent()
  const isMac = isMacUserAgent()
  const isWebClient = isWebClientLocation()
  const showDesktopOnlySettings = !isWebClient
  const showComputerUsePreviewTooltip = !isMac
  const computerUsePlatform = computerUsePlatformLabel({ isWindows, isMac })
  // Why: the Terminal settings section shares one search index with the
  // sidebar. We trim platform-only entries on other platforms so search never
  // reveals controls that the renderer will intentionally hide.
  const terminalPaneSearchEntries = useMemo(
    () => getTerminalPaneSearchEntries({ isWindows, isMac }),
    [isWindows, isMac]
  )
  const [scrollbackMode, setScrollbackMode] = useState<'preset' | 'custom'>('preset')
  const [prevScrollbackBytes, setPrevScrollbackBytes] = useState(settings?.terminalScrollbackBytes)
  // Why: lifted out of TerminalPane so the Terminal section header can render
  // the import trigger as a headerAction. The modal itself still lives inside
  // TerminalPane, driven by this shared state.
  const ghostty = useGhosttyImport(updateSettings, settings)
  const [fontSuggestions, setFontSuggestions] = useState<string[]>(
    Array.from(new Set([DEFAULT_APP_FONT_FAMILY, ...getFallbackTerminalFonts()]))
  )
  const [activeSectionId, setActiveSectionId] = useState('general')
  const [mountedSectionIds, setMountedSectionIds] = useState<Set<string>>(
    getInitialMountedSectionIds
  )
  const [pendingNavRequestTick, setPendingNavRequestTick] = useState(0)
  const [hasUnsavedCommitPromptChanges, setHasUnsavedCommitPromptChanges] = useState(false)
  const [commitPromptDiscardSignal, setCommitPromptDiscardSignal] = useState(0)
  const confirm = useConfirmationDialog()
  // Why: the hidden-experimental group is an unlock — Shift-clicking the
  // Experimental sidebar entry reveals it for the remainder of the session.
  // Not persisted on purpose: it's a power-user affordance we don't want to
  // leak through into a normal reopen of Settings.
  const [hiddenExperimentalUnlocked, setHiddenExperimentalUnlocked] = useState(false)
  const contentScrollRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const terminalFontsLoadedRef = useRef(false)
  const pendingNavSectionRef = useRef<string | null>(null)
  const pendingScrollTargetRef = useRef<string | null>(null)
  const repoHooksRequestSeqRef = useRef(0)
  const repoHooksRuntimeIdentityRef = useRef<string>('local')

  const confirmDiscardCommitPromptChanges = useCallback(async (): Promise<boolean> => {
    if (!hasUnsavedCommitPromptChanges) {
      return true
    }
    const shouldDiscard = await confirm({
      title: 'Discard unsaved commit prompt changes?',
      description: 'You have unsaved AI commit prompt changes. Leaving will discard them.',
      confirmLabel: 'Discard',
      confirmVariant: 'destructive'
    })
    if (shouldDiscard) {
      setCommitPromptDiscardSignal((signal) => signal + 1)
      setHasUnsavedCommitPromptChanges(false)
    }
    return shouldDiscard
  }, [confirm, hasUnsavedCommitPromptChanges])

  const closeSettingsPageWithPromptGuard = useCallback(async (): Promise<void> => {
    if (!(await confirmDiscardCommitPromptChanges())) {
      return
    }
    closeSettingsPage()
  }, [closeSettingsPage, confirmDiscardCommitPromptChanges])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const runtimeTargetIdentity = getRuntimeTargetIdentity(settings)

  useEffect(() => {
    const hasVisibleOverlay = (): boolean =>
      Array.from(
        document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')
      ).some((element) => {
        if (!(element instanceof HTMLElement)) {
          return false
        }
        if (element.closest('[aria-hidden="true"]')) {
          return false
        }
        const style = window.getComputedStyle(element)
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        )
      })

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      // Why: nested dialogs and menus own Escape before Settings page-level
      // navigation, including the unsaved commit prompt confirmation dialog.
      if (hasVisibleOverlay()) {
        return
      }
      // Why: Escape in an editable control usually means "cancel this edit",
      // not "close Settings". Closing the entire page would discard the user's
      // in-progress typing. Defer to the field's own handler when focus is on
      // an input/textarea/select or contenteditable region; a subsequent
      // Escape (with focus back on the body) will then close the page.
      if (isEditableTarget(event.target)) {
        return
      }
      void closeSettingsPageWithPromptGuard()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeSettingsPageWithPromptGuard])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!hasUnsavedCommitPromptChanges) {
        return
      }
      event.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedCommitPromptChanges])

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.shiftKey) {
        return
      }
      // Why: Cmd on Mac, Ctrl elsewhere — matches the rest of the app's
      // mod-key convention (see App.tsx) and aligns with platform Find norms.
      const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (!mod || event.key.toLowerCase() !== 'f') {
        return
      }
      const input = searchInputRef.current
      if (!input) {
        return
      }
      event.preventDefault()
      input.focus()
      input.select()
    }

    document.addEventListener('keydown', handleFindShortcut)
    return () => document.removeEventListener('keydown', handleFindShortcut)
  }, [isMac])

  useEffect(
    () => () => {
      // Why: the settings search is a transient in-page filter. Leaving it behind makes the next
      // visit look partially broken because whole sections stay hidden before the user types again.
      setSettingsSearchQuery('')
    },
    [setSettingsSearchQuery]
  )

  useEffect(() => {
    if (!settings || !settingsNavigationTarget) {
      return
    }

    const paneSectionId = getSettingsSectionId(
      settingsNavigationTarget.pane as SettingsNavTarget,
      settingsNavigationTarget.repoId
    )
    pendingNavSectionRef.current = paneSectionId
    pendingScrollTargetRef.current = settingsNavigationTarget.sectionId ?? paneSectionId
    setMountedSectionIds((previous) => {
      if (previous.has(paneSectionId)) {
        return previous
      }
      return new Set(previous).add(paneSectionId)
    })
    // Why: target consumption stores refs, so bump state to guarantee the
    // scroll effect runs even when the visible section set is otherwise stable.
    setPendingNavRequestTick((tick) => tick + 1)
    clearSettingsTarget()
  }, [clearSettingsTarget, settings, settingsNavigationTarget])

  // Why: only recompute scrollback mode when the byte value actually changes,
  // not on every unrelated settings mutation.
  if (settings?.terminalScrollbackBytes !== prevScrollbackBytes) {
    setPrevScrollbackBytes(settings?.terminalScrollbackBytes)
    if (settings) {
      const scrollbackMb = Math.max(1, Math.round(settings.terminalScrollbackBytes / 1_000_000))
      setScrollbackMode(
        SCROLLBACK_PRESETS_MB.includes(scrollbackMb as (typeof SCROLLBACK_PRESETS_MB)[number])
          ? 'preset'
          : 'custom'
      )
    }
  }

  const applyTheme = useCallback((theme: 'system' | 'dark' | 'light') => {
    applyDocumentTheme(theme)
  }, [])

  const displayedGitUsername = repos[0]?.gitUsername ?? ''
  const runtimeEnvironmentsSearchEntry = isWebClient
    ? WEB_RUNTIME_ENVIRONMENTS_SEARCH_ENTRY
    : RUNTIME_ENVIRONMENTS_SEARCH_ENTRY

  const navSections = useMemo<SettingsNavSection[]>(
    () => [
      {
        id: 'general',
        title: 'General',
        description: 'Workspace defaults, app setup, and maintenance.',
        icon: SlidersHorizontal,
        searchEntries: GENERAL_PANE_SEARCH_ENTRIES,
        group: 'setup'
      },
      {
        id: 'agents',
        title: 'Agents',
        description: 'Manage AI agents, set a default, and customize commands.',
        icon: Bot,
        searchEntries: AGENTS_PANE_SEARCH_ENTRIES,
        group: 'setup'
      },
      {
        id: 'accounts',
        title: 'AI Provider Accounts',
        description: 'Optional account switching for Claude, Codex, Gemini, and OpenCode Go.',
        icon: UserCog,
        searchEntries: ACCOUNTS_PANE_SEARCH_ENTRIES,
        group: 'setup',
        badge: 'Optional'
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
        // Why: the AI commit messages pane is rendered inside the Git section,
        // so its search entries belong to Git too — that way a query like
        // "claude" or "thinking" still surfaces the section.
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
        description: 'Theme, zoom, app font, sidebars, and status bar.',
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
      {
        id: 'terminal',
        title: 'Terminal',
        description: 'Shells, terminal appearance, quick commands, and pane behavior.',
        icon: SquareTerminal,
        searchEntries: terminalPaneSearchEntries,
        group: 'workflows'
      },
      ...(showDesktopOnlySettings
        ? [
            {
              id: 'browser' as const,
              title: 'Browser',
              description: 'Home page, link routing, and session cookies.',
              icon: Globe,
              searchEntries: BROWSER_PANE_SEARCH_ENTRIES,
              group: 'workflows'
            },
            {
              id: 'notifications' as const,
              title: 'Notifications',
              description: 'Native desktop notifications for agent and terminal events.',
              icon: Bell,
              searchEntries: NOTIFICATIONS_PANE_SEARCH_ENTRIES,
              group: 'interface'
            }
          ]
        : []),
      {
        id: 'orchestration',
        title: 'Orchestration',
        description: 'Coordinate multiple coding agents through Orca.',
        icon: Network,
        searchEntries: ORCHESTRATION_PANE_SEARCH_ENTRIES,
        group: 'capabilities'
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
              id: 'ssh' as const,
              title: 'SSH Hosts',
              description: 'Remote SSH hosts for files, terminals, and git.',
              icon: Cable,
              searchEntries: SSH_PANE_SEARCH_ENTRIES,
              group: 'remote'
            },
            {
              id: 'mobile' as const,
              title: 'Mobile',
              description: 'Control terminals and agents from your phone.',
              icon: Smartphone,
              searchEntries: MOBILE_SETTINGS_PANE_SEARCH_ENTRIES,
              group: 'remote',
              badge: 'Beta'
            },
            {
              id: 'computer-use' as const,
              title: 'Computer Use',
              description: 'Enable agents to control any app on your computer.',
              icon: MousePointerClick,
              searchEntries: COMPUTER_USE_PANE_SEARCH_ENTRIES,
              group: 'capabilities',
              badge: 'Beta'
            },
            {
              id: 'voice' as const,
              title: 'Voice',
              description: 'Local speech-to-text dictation with on-device models.',
              icon: Mic,
              searchEntries: VOICE_PANE_SEARCH_ENTRIES,
              group: 'capabilities',
              badge: 'Beta'
            }
          ]
        : []),
      ...(showDesktopOnlySettings && isMac
        ? [
            {
              id: 'developer-permissions' as const,
              title: 'macOS Permissions',
              description: 'macOS privacy access for terminal-launched developer tools.',
              icon: ShieldCheck,
              searchEntries: DEVELOPER_PERMISSIONS_PANE_SEARCH_ENTRIES,
              group: 'safety'
            }
          ]
        : []),
      {
        id: 'privacy',
        title: 'Privacy & Telemetry',
        description: 'Anonymous usage data and telemetry controls.',
        icon: Lock,
        searchEntries: PRIVACY_PANE_SEARCH_ENTRIES,
        group: 'safety'
      },
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
    ],
    [
      isMac,
      isWebClient,
      repos,
      runtimeEnvironmentsSearchEntry,
      showDesktopOnlySettings,
      terminalPaneSearchEntries
    ]
  )

  const visibleNavSections = useMemo(
    () =>
      navSections.filter((section) =>
        section.id === 'git' && hasUnsavedCommitPromptChanges
          ? true
          : matchesSettingsSearch(settingsSearchQuery, section.searchEntries)
      ),
    [hasUnsavedCommitPromptChanges, navSections, settingsSearchQuery]
  )
  const visibleSectionIds = useMemo(
    () => new Set(visibleNavSections.map((section) => section.id)),
    [visibleNavSections]
  )
  const neededSectionIds = useMemo(
    () =>
      deriveNeededSectionIds({
        navSectionIds: navSections.map((section) => section.id),
        mountedSectionIds,
        activeSectionId,
        pendingSectionId: pendingNavSectionRef.current,
        query: settingsSearchQuery,
        visibleSectionIds
      }),
    [activeSectionId, mountedSectionIds, navSections, settingsSearchQuery, visibleSectionIds]
  )
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    isWindows && neededSectionIds.has('terminal')
  )

  useEffect(() => {
    setMountedSectionIds((previous) => {
      let changed = false
      const next = new Set(previous)
      for (const id of neededSectionIds) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [neededSectionIds])

  useEffect(() => {
    if (!neededSectionIds.has('appearance') && !neededSectionIds.has('terminal')) {
      return
    }
    if (terminalFontsLoadedRef.current) {
      return
    }

    let stale = false
    const loadFontSuggestions = async (): Promise<void> => {
      try {
        const fonts = await window.api.settings.listFonts()
        if (stale || fonts.length === 0) {
          return
        }
        terminalFontsLoadedRef.current = true
        setFontSuggestions((prev) =>
          Array.from(new Set([DEFAULT_APP_FONT_FAMILY, ...fonts, ...prev])).slice(0, 320)
        )
      } catch {
        // Fall back to curated cross-platform suggestions.
      }
    }
    void loadFontSuggestions()
    return () => {
      stale = true
    }
  }, [neededSectionIds])

  const neededRepoIds = useMemo(
    () => deriveNeededRepoIds(repos, neededSectionIds),
    [neededSectionIds, repos]
  )

  useEffect(() => {
    const repoIdSet = new Set(repos.map((repo) => repo.id))
    setRepoHooksMap((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous).filter(([repoId]) => repoIdSet.has(repoId))
      ) as Record<string, { hasHooks: boolean; hooks: OrcaHooks | null; mayNeedUpdate: boolean }>
      return Object.keys(next).length === Object.keys(previous).length ? previous : next
    })
  }, [repos])

  useEffect(() => {
    if (repoHooksRuntimeIdentityRef.current !== runtimeTargetIdentity) {
      repoHooksRuntimeIdentityRef.current = runtimeTargetIdentity
      repoHooksRequestSeqRef.current += 1
      setRepoHooksMap({})
    }
  }, [runtimeTargetIdentity])

  useEffect(() => {
    if (neededRepoIds.length === 0) {
      return
    }

    let stale = false
    const requestSeq = ++repoHooksRequestSeqRef.current
    const repoById = new Map(repos.map((repo) => [repo.id, repo] as const))

    void Promise.all(
      neededRepoIds.map(async (repoId) => {
        const repo = repoById.get(repoId)
        if (!repo) {
          return
        }
        if (isFolderRepo(repo)) {
          setRepoHooksMap((previous) => {
            if (previous[repoId]) {
              return previous
            }
            return {
              ...previous,
              [repoId]: { hasHooks: false, hooks: null, mayNeedUpdate: false }
            }
          })
          return
        }
        try {
          const result = await checkRuntimeHooks(
            runtimeTargetIdentity === 'local'
              ? { activeRuntimeEnvironmentId: null }
              : { activeRuntimeEnvironmentId: runtimeTargetIdentity },
            repoId
          )
          if (stale || requestSeq !== repoHooksRequestSeqRef.current) {
            return
          }
          setRepoHooksMap((previous) => {
            if (!repos.some((entry) => entry.id === repoId)) {
              return previous
            }
            return { ...previous, [repoId]: result }
          })
        } catch {
          // Keep last known value on transient failures.
          if (stale || requestSeq !== repoHooksRequestSeqRef.current) {
            return
          }
          setRepoHooksMap((previous) => {
            if (!repos.some((entry) => entry.id === repoId)) {
              return previous
            }
            if (previous[repoId]) {
              return previous
            }
            return {
              ...previous,
              [repoId]: { hasHooks: false, hooks: null, mayNeedUpdate: false }
            }
          })
        }
      })
    )

    return () => {
      stale = true
    }
  }, [neededRepoIds, repos, runtimeTargetIdentity])

  useEffect(() => {
    const scrollTargetId = pendingScrollTargetRef.current
    const pendingNavSectionId = pendingNavSectionRef.current

    if (scrollTargetId && pendingNavSectionId && settingsSearchQuery.trim() !== '') {
      setSettingsSearchQuery('')
      return
    }

    if (scrollTargetId && pendingNavSectionId && visibleSectionIds.has(pendingNavSectionId)) {
      // Why: inactive Settings panes no longer render in the empty-search view.
      // Activate the pane first, then wait for the next render before looking
      // for any subsection target inside it.
      if (activeSectionId !== pendingNavSectionId) {
        setActiveSectionId(pendingNavSectionId)
        return
      }
      const container = contentScrollRef.current
      if (container) {
        container.scrollTo({ top: 0 })
      }
      // Why: deep links can target a row inside the pane; the pane itself is
      // already in view because the sidebar swap rendered just it.
      if (scrollTargetId !== pendingNavSectionId) {
        // Why: target navigation can arrive before the lazy section has mounted;
        // keep the pending refs alive until the mounted-section update commits.
        if (!getSettingsScrollTarget(scrollTargetId, container)) {
          return
        }
        const scrollToSubsection = (): void => {
          scrollSubsectionIntoView(scrollTargetId, contentScrollRef.current)
        }
        scrollToSubsection()
        requestAnimationFrame(scrollToSubsection)
      }
      setActiveSectionId(pendingNavSectionId)
      pendingNavSectionRef.current = null
      pendingScrollTargetRef.current = null
      return
    }

    if (!visibleSectionIds.has(activeSectionId) && visibleNavSections.length > 0) {
      setActiveSectionId(getFallbackVisibleSection(visibleNavSections)?.id ?? activeSectionId)
    }
  }, [
    activeSectionId,
    pendingNavRequestTick,
    setSettingsSearchQuery,
    settingsSearchQuery,
    visibleSectionIds,
    visibleNavSections
  ])

  const scrollToSection = useCallback(
    async (
      sectionId: string,
      modifiers?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }
    ): Promise<void> => {
      if (sectionId !== activeSectionId && !(await confirmDiscardCommitPromptChanges())) {
        return
      }
      // Why: Shift-clicking the Experimental sidebar entry unlocks a hidden
      // power-user group. Keep this scoped to the Experimental row so normal
      // shortcut combos on other rows don't accidentally flip state. The
      // unlock persists for the life of the Settings view (resets when
      // Settings is reopened).
      if (sectionId === 'experimental' && modifiers?.shiftKey) {
        setHiddenExperimentalUnlocked((previous) => !previous)
      }
      const container = contentScrollRef.current
      if (container) {
        container.scrollTo({ top: 0 })
      }
      setActiveSectionId(sectionId)
    },
    [activeSectionId, confirmDiscardCommitPromptChanges]
  )

  const openComputerUseFromBrowser = useCallback(async () => {
    if (!(await confirmDiscardCommitPromptChanges())) {
      return
    }
    pendingNavSectionRef.current = 'computer-use'
    pendingScrollTargetRef.current = 'computer-use'
    if (settingsSearchQuery !== '') {
      setSettingsSearchQuery('')
      return
    }
    // Why: the pending section refs do not schedule a render by themselves.
    // When search is already clear, this reruns the centralized jump effect.
    setPendingNavRequestTick((tick) => tick + 1)
  }, [confirmDiscardCommitPromptChanges, setSettingsSearchQuery, settingsSearchQuery])

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Loading settings...
      </div>
    )
  }

  const generalNavSections = visibleNavSections.filter((section) => !section.id.startsWith('repo-'))
  const generalNavGroups: SettingsNavGroup[] = SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    sections: generalNavSections.filter((section) => section.group === group.id)
  })).filter((group) => group.sections.length > 0)
  const repoNavSections = visibleNavSections
    .filter((section) => section.id.startsWith('repo-'))
    .map((section) => {
      const repo = repos.find((entry) => entry.id === section.id.replace('repo-', ''))
      return { ...section, badgeColor: repo?.badgeColor, isRemote: !!repo?.connectionId }
    })
  const isSectionMounted = (sectionId: string): boolean => neededSectionIds.has(sectionId)

  return (
    <div className="settings-view-shell flex min-h-0 flex-1 overflow-hidden bg-background">
      <SettingsSidebar
        activeSectionId={activeSectionId}
        generalGroups={generalNavGroups}
        repoSections={repoNavSections}
        hasRepos={repos.length > 0}
        searchQuery={settingsSearchInputQuery}
        searchInputRef={searchInputRef}
        onBack={closeSettingsPageWithPromptGuard}
        onSearchChange={setSettingsSearchQuery}
        onSelectSection={scrollToSection}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={contentScrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
          <div className="flex w-full max-w-5xl flex-col gap-10 px-8 py-10">
            {visibleNavSections.length === 0 ? (
              <div className="flex min-h-[24rem] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground">
                No settings found for &quot;{settingsSearchQuery.trim()}&quot;
              </div>
            ) : (
              <ActiveSettingsSectionProvider value={activeSectionId}>
                <SettingsSection
                  id="general"
                  title="General"
                  description="Workspace defaults, app setup, and maintenance."
                  searchEntries={GENERAL_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('general') ? (
                    <GeneralPane settings={settings} updateSettings={updateSettings} />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="agents"
                  title="Agents"
                  description="Manage AI agents, set a default, and customize commands."
                  searchEntries={AGENTS_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('agents') ? (
                    <AgentsPane settings={settings} updateSettings={updateSettings} />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="accounts"
                  title="AI Provider Accounts"
                  description="Optional. Orca works with your existing provider logins; add accounts only if you want Orca to help switch between them."
                  badge="Optional"
                  searchEntries={ACCOUNTS_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('accounts') ? (
                    <AccountsPane settings={settings} updateSettings={updateSettings} />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="integrations"
                  title="Integrations"
                  description="Connect GitHub, GitLab, Linear, and source-hosting services."
                  searchEntries={INTEGRATIONS_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('integrations') ? <IntegrationsPane /> : null}
                </SettingsSection>

                <SettingsSection
                  id="git"
                  title="Git & Source Control"
                  description="Branch naming, base refs, attribution, and AI commit messages."
                  searchEntries={[
                    ...GIT_PANE_SEARCH_ENTRIES,
                    ...COMMIT_MESSAGE_AI_PANE_SEARCH_ENTRIES
                  ]}
                  forceVisible={hasUnsavedCommitPromptChanges}
                >
                  {isSectionMounted('git') ? (
                    <>
                      <GitPane
                        settings={settings}
                        updateSettings={updateSettings}
                        displayedGitUsername={displayedGitUsername}
                      />
                      <CommitMessageAiPane
                        settings={settings}
                        updateSettings={updateSettings}
                        onCustomPromptDirtyChange={setHasUnsavedCommitPromptChanges}
                        customPromptDiscardSignal={commitPromptDiscardSignal}
                      />
                    </>
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="tasks"
                  title="Task Sources"
                  description="Choose which task providers appear in the Tasks page and sidebar."
                  searchEntries={TASKS_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('tasks') ? (
                    <TasksPane settings={settings} updateSettings={updateSettings} />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="floating-workspace"
                  title="Floating Workspace"
                  description="Global terminal, browser, and markdown tabs."
                  searchEntries={FLOATING_WORKSPACE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('floating-workspace') ? (
                    <FloatingWorkspacePane settings={settings} updateSettings={updateSettings} />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="terminal"
                  title="Terminal"
                  description="Shells, terminal appearance, quick commands, and pane behavior."
                  searchEntries={terminalPaneSearchEntries}
                  headerAction={
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => void ghostty.handleClick()}
                    >
                      <img src={ghosttyIcon} alt="" aria-hidden="true" className="size-4" />
                      Import from Ghostty
                    </Button>
                  }
                >
                  {isSectionMounted('terminal') ? (
                    <TerminalPane
                      settings={settings}
                      updateSettings={updateSettings}
                      systemPrefersDark={systemPrefersDark}
                      terminalFontSuggestions={fontSuggestions.filter(
                        (font) => font !== DEFAULT_APP_FONT_FAMILY
                      )}
                      scrollbackMode={scrollbackMode}
                      setScrollbackMode={setScrollbackMode}
                      ghostty={ghostty}
                      wslAvailable={windowsTerminalCapabilities.wslAvailable}
                      pwshAvailable={windowsTerminalCapabilities.pwshAvailable}
                    />
                  ) : null}
                </SettingsSection>

                {showDesktopOnlySettings ? (
                  <SettingsSection
                    id="browser"
                    title="Browser"
                    description="Home page, link routing, and session cookies."
                    searchEntries={BROWSER_PANE_SEARCH_ENTRIES}
                  >
                    {isSectionMounted('browser') ? (
                      <BrowserPane
                        settings={settings}
                        updateSettings={updateSettings}
                        onOpenComputerUse={openComputerUseFromBrowser}
                      />
                    ) : null}
                  </SettingsSection>
                ) : null}

                <SettingsSection
                  id="appearance"
                  title="Appearance"
                  description="Theme, zoom, app font, sidebars, and status bar."
                  searchEntries={APPEARANCE_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('appearance') ? (
                    <AppearancePane
                      settings={settings}
                      updateSettings={updateSettings}
                      applyTheme={applyTheme}
                      fontSuggestions={fontSuggestions}
                    />
                  ) : null}
                </SettingsSection>

                <SettingsSection
                  id="input"
                  title="Input & Editing"
                  description="Selection and editing behavior."
                  searchEntries={INPUT_PANE_SEARCH_ENTRIES}
                >
                  <InputPane settings={settings} updateSettings={updateSettings} />
                </SettingsSection>

                {showDesktopOnlySettings ? (
                  <SettingsSection
                    id="notifications"
                    title="Notifications"
                    description="Native desktop notifications for agent activity and terminal events."
                    searchEntries={NOTIFICATIONS_PANE_SEARCH_ENTRIES}
                  >
                    {isSectionMounted('notifications') ? (
                      <NotificationsPane settings={settings} updateSettings={updateSettings} />
                    ) : null}
                  </SettingsSection>
                ) : null}

                <SettingsSection
                  id="shortcuts"
                  title="Shortcuts"
                  description="Keyboard shortcuts for common actions."
                  searchEntries={SHORTCUTS_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('shortcuts') ? <ShortcutsPane /> : null}
                </SettingsSection>

                <SettingsSection
                  id="stats"
                  title="Stats & Usage"
                  description="Orca stats plus Claude, Codex, and OpenCode usage analytics."
                  searchEntries={STATS_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('stats') ? <StatsPane /> : null}
                </SettingsSection>

                <SettingsSection
                  id="orchestration"
                  title="Orchestration"
                  description="Coordinate multiple coding agents through Orca."
                  searchEntries={ORCHESTRATION_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('orchestration') ? <OrchestrationPane /> : null}
                </SettingsSection>

                {showDesktopOnlySettings ? (
                  <>
                    <SettingsSection
                      id="computer-use"
                      title="Computer Use"
                      badge="Beta"
                      badgeAccessory={
                        showComputerUsePreviewTooltip ? (
                          <TooltipProvider delayDuration={250}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  className="text-muted-foreground transition-colors hover:text-foreground"
                                  aria-label={`${computerUsePlatform} Computer Use preview details`}
                                >
                                  <Info className="size-3.5" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" sideOffset={6} className="max-w-72">
                                <span>
                                  {computerUsePlatform} Computer Use is an early preview. Some apps
                                  and desktop environments may behave inconsistently.
                                </span>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : null
                      }
                      description="Enable agents to control any app on your computer."
                      searchEntries={COMPUTER_USE_PANE_SEARCH_ENTRIES}
                    >
                      {isSectionMounted('computer-use') ? <ComputerUsePane /> : null}
                    </SettingsSection>

                    <SettingsSection
                      id="voice"
                      title="Voice"
                      badge="Beta"
                      description="Local speech-to-text dictation with on-device models."
                      searchEntries={VOICE_PANE_SEARCH_ENTRIES}
                    >
                      {isSectionMounted('voice') ? (
                        <VoicePane settings={settings} updateSettings={updateSettings} />
                      ) : null}
                    </SettingsSection>
                  </>
                ) : null}

                <SettingsSection
                  id="servers"
                  title="Remote Orca Servers"
                  badge="Beta"
                  description={
                    isWebClient
                      ? 'Connect this browser to a saved Orca server.'
                      : 'Switch between local desktop mode and paired remote Orca runtimes.'
                  }
                  searchEntries={[runtimeEnvironmentsSearchEntry]}
                >
                  {isSectionMounted('servers') ? (
                    <RuntimeEnvironmentsPane
                      settings={settings}
                      switchRuntimeEnvironment={switchRuntimeEnvironment}
                      canGeneratePairingUrl={!isWebClient}
                      allowLocalRuntime={!isWebClient}
                    />
                  ) : null}
                </SettingsSection>

                {showDesktopOnlySettings ? (
                  <>
                    <SettingsSection
                      id="ssh"
                      title="SSH Hosts"
                      description="Remote SSH hosts for files, terminals, and git."
                      searchEntries={SSH_PANE_SEARCH_ENTRIES}
                    >
                      {isSectionMounted('ssh') ? <SshPane /> : null}
                    </SettingsSection>

                    <SettingsSection
                      id="mobile"
                      title="Mobile"
                      badge="Beta"
                      description="Control terminals and agents from your phone."
                      searchEntries={MOBILE_SETTINGS_PANE_SEARCH_ENTRIES}
                    >
                      {isSectionMounted('mobile') ? (
                        <MobileSettingsPane settings={settings} updateSettings={updateSettings} />
                      ) : null}
                    </SettingsSection>
                  </>
                ) : null}

                {showDesktopOnlySettings && isMac ? (
                  <SettingsSection
                    id="developer-permissions"
                    title="macOS Permissions"
                    description="macOS privacy access for terminal-launched developer tools."
                    searchEntries={DEVELOPER_PERMISSIONS_PANE_SEARCH_ENTRIES}
                  >
                    {isSectionMounted('developer-permissions') ? (
                      <DeveloperPermissionsPane />
                    ) : null}
                  </SettingsSection>
                ) : null}

                <SettingsSection
                  id="privacy"
                  title="Privacy & Telemetry"
                  description="Anonymous usage data and telemetry controls."
                  searchEntries={PRIVACY_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('privacy') ? <PrivacyPane settings={settings} /> : null}
                </SettingsSection>

                <SettingsSection
                  id="experimental"
                  title="Experimental"
                  description="New features that are still taking shape. Give them a try."
                  searchEntries={EXPERIMENTAL_PANE_SEARCH_ENTRIES}
                >
                  {isSectionMounted('experimental') ? (
                    <ExperimentalPane
                      settings={settings}
                      updateSettings={updateSettings}
                      hiddenExperimentalUnlocked={hiddenExperimentalUnlocked}
                    />
                  ) : null}
                </SettingsSection>

                {repos.map((repo) => {
                  const repoSectionId = `repo-${repo.id}`
                  const repoHooksState = repoHooksMap[repo.id]

                  return (
                    <SettingsSection
                      key={repo.id}
                      id={repoSectionId}
                      title={repo.displayName}
                      description={repo.path}
                      searchEntries={getRepositoryPaneSearchEntries(repo)}
                    >
                      {isSectionMounted(repoSectionId) ? (
                        <RepositoryPane
                          repo={repo}
                          yamlHooks={repoHooksState?.hooks ?? null}
                          hasHooksFile={repoHooksState?.hasHooks ?? false}
                          mayNeedUpdate={repoHooksState?.mayNeedUpdate ?? false}
                          updateRepo={updateRepo}
                          removeRepo={removeRepo}
                        />
                      ) : null}
                    </SettingsSection>
                  )
                })}
              </ActiveSettingsSectionProvider>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Settings
