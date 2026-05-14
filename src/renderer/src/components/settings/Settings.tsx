/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Bell,
  Bot,
  FlaskConical,
  GitBranch,
  Globe,
  Info,
  Keyboard,
  Lock,
  MousePointerClick,
  Network,
  ShieldCheck,
  Palette,
  Server,
  SlidersHorizontal,
  Smartphone,
  Blocks,
  Mic,
  SquareTerminal,
  UserCog
} from 'lucide-react'
import type { OrcaHooks } from '../../../../shared/types'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import { useAppStore } from '../../store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { applyDocumentTheme } from '@/lib/document-theme'
import { SCROLLBACK_PRESETS_MB, getFallbackTerminalFonts } from './SettingsConstants'
import { DEFAULT_APP_FONT_FAMILY } from '../../../../shared/constants'
import { GeneralPane, GENERAL_PANE_SEARCH_ENTRIES } from './GeneralPane'
import { BrowserPane, BROWSER_PANE_SEARCH_ENTRIES } from './BrowserPane'
import { AppearancePane, APPEARANCE_PANE_SEARCH_ENTRIES } from './AppearancePane'
import { ShortcutsPane, SHORTCUTS_PANE_SEARCH_ENTRIES } from './ShortcutsPane'
import { TerminalPane } from './TerminalPane'
import { useGhosttyImport } from './useGhosttyImport'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import ghosttyIcon from '../../../../../resources/ghostty.svg'
import { RepositoryPane, getRepositoryPaneSearchEntries } from './RepositoryPane'
import { getTerminalPaneSearchEntries } from './terminal-search'
import { GitPane, GIT_PANE_SEARCH_ENTRIES } from './GitPane'
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
import {
  DeveloperPermissionsPane,
  DEVELOPER_PERMISSIONS_PANE_SEARCH_ENTRIES
} from './DeveloperPermissionsPane'
import { ComputerUsePane, COMPUTER_USE_PANE_SEARCH_ENTRIES } from './ComputerUsePane'
import { MobileSettingsPane, MOBILE_SETTINGS_PANE_SEARCH_ENTRIES } from './MobileSettingsPane'
import { PrivacyPane } from './PrivacyPane'
import { PRIVACY_PANE_SEARCH_ENTRIES } from './privacy-search'
import { SettingsSidebar } from './SettingsSidebar'
import { SettingsSection } from './SettingsSection'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'

type SettingsNavTarget =
  | 'general'
  | 'integrations'
  | 'accounts'
  | 'browser'
  | 'git'
  | 'appearance'
  | 'terminal'
  | 'notifications'
  | 'computer-use'
  | 'developer-permissions'
  | 'privacy'
  | 'voice'
  | 'shortcuts'
  | 'stats'
  | 'ssh'
  | 'experimental'
  | 'agents'
  | 'orchestration'
  | 'mobile'
  | 'repo'

type SettingsNavSection = {
  id: string
  title: string
  description: string
  icon: typeof SlidersHorizontal
  searchEntries: SettingsSearchEntry[]
  badge?: string
}

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

// Why: after a sidebar jump the target section is now in the viewport center
// rather than the top, which can make it less obvious which section just
// scrolled into view. Pulsing the border for a moment reassures the user that
// their click landed on the right section.
const SECTION_FLASH_CLASS = 'settings-section-flash'
const SECTION_FLASH_DURATION_MS = 900

function scrollSectionIntoView(sectionId: string, container?: HTMLElement | null): void {
  const target = document.getElementById(sectionId)
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

  // Why: the scroll spy samples 40% down the viewport. Put sidebar jump
  // targets just above that probe so short sections like Voice do not
  // immediately hand active selection to the next section.
  const desiredTop = targetTop - container.clientHeight * 0.3
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
  container.scrollTo({ top: Math.min(Math.max(0, desiredTop), maxScrollTop) })
}

function flashSectionHighlight(sectionId: string): void {
  const target = document.getElementById(sectionId)
  if (!target) {
    return
  }
  target.classList.remove(SECTION_FLASH_CLASS)
  // Force a reflow so re-adding the class restarts the animation.
  void target.offsetWidth
  target.classList.add(SECTION_FLASH_CLASS)
  window.setTimeout(() => {
    target.classList.remove(SECTION_FLASH_CLASS)
  }, SECTION_FLASH_DURATION_MS)
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

function Settings(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const closeSettingsPage = useAppStore((s) => s.closeSettingsPage)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const removeRepo = useAppStore((s) => s.removeRepo)
  const settingsNavigationTarget = useAppStore((s) => s.settingsNavigationTarget)
  const clearSettingsTarget = useAppStore((s) => s.clearSettingsTarget)
  const settingsSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)

  const [repoHooksMap, setRepoHooksMap] = useState<
    Record<string, { hasHooks: boolean; hooks: OrcaHooks | null; mayNeedUpdate: boolean }>
  >({})
  const systemPrefersDark = useSystemPrefersDark()
  const isWindows = isWindowsUserAgent()
  const isMac = isMacUserAgent()
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
  const [wslAvailable, setWslAvailable] = useState(false)
  const [pwshAvailable, setPwshAvailable] = useState(false)
  useEffect(() => {
    if (!isWindows) {
      setWslAvailable(false)
      setPwshAvailable(false)
      return
    }

    void window.api.wsl.isAvailable().then(setWslAvailable)
    void window.api.pwsh.isAvailable().then(setPwshAvailable)
  }, [isWindows])
  const [fontSuggestions, setFontSuggestions] = useState<string[]>(
    Array.from(new Set([DEFAULT_APP_FONT_FAMILY, ...getFallbackTerminalFonts()]))
  )
  const [activeSectionId, setActiveSectionId] = useState('general')
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

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
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
      closeSettingsPage()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeSettingsPage])

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
    clearSettingsTarget()
  }, [clearSettingsTarget, settings, settingsNavigationTarget])

  useEffect(() => {
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
  }, [])

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

  useEffect(() => {
    let stale = false

    const checkHooks = async (): Promise<void> => {
      const results = await Promise.all(
        repos.map(async (repo) => {
          if (isFolderRepo(repo)) {
            return [repo.id, { hasHooks: false, hooks: null, mayNeedUpdate: false }] as const
          }
          try {
            const result = await window.api.hooks.check({ repoId: repo.id })
            return [repo.id, result] as const
          } catch {
            return [repo.id, { hasHooks: false, hooks: null, mayNeedUpdate: false }] as const
          }
        })
      )

      if (!stale) {
        setRepoHooksMap(
          Object.fromEntries(results) as Record<
            string,
            { hasHooks: boolean; hooks: OrcaHooks | null; mayNeedUpdate: boolean }
          >
        )
      }
    }

    if (repos.length > 0) {
      void checkHooks()
    } else {
      setRepoHooksMap({})
    }

    return () => {
      stale = true
    }
  }, [repos])

  const applyTheme = useCallback((theme: 'system' | 'dark' | 'light') => {
    applyDocumentTheme(theme)
  }, [])

  const displayedGitUsername = repos[0]?.gitUsername ?? ''

  const navSections = useMemo<SettingsNavSection[]>(
    () => [
      {
        id: 'general',
        title: 'General',
        description: 'Workspace, editor, and updates.',
        icon: SlidersHorizontal,
        searchEntries: GENERAL_PANE_SEARCH_ENTRIES
      },
      {
        id: 'agents',
        title: 'Agents',
        description: 'Manage AI agents, set a default, and customize commands.',
        icon: Bot,
        searchEntries: AGENTS_PANE_SEARCH_ENTRIES
      },
      {
        id: 'accounts',
        title: 'Agent Accounts',
        description: 'Sign in and switch between Claude, Codex, Gemini, and OpenCode Go accounts.',
        icon: UserCog,
        searchEntries: ACCOUNTS_PANE_SEARCH_ENTRIES
      },
      {
        id: 'git',
        title: 'Git',
        description: 'Branch naming and local ref behavior.',
        icon: GitBranch,
        searchEntries: GIT_PANE_SEARCH_ENTRIES
      },
      {
        id: 'appearance',
        title: 'Appearance',
        description: 'Theme and UI scaling.',
        icon: Palette,
        searchEntries: APPEARANCE_PANE_SEARCH_ENTRIES
      },
      {
        id: 'terminal',
        title: 'Terminal',
        description: 'Terminal appearance, previews, and defaults for new panes.',
        icon: SquareTerminal,
        searchEntries: terminalPaneSearchEntries
      },
      {
        id: 'browser',
        title: 'Browser',
        description: 'Home page, link routing, and session cookies.',
        icon: Globe,
        searchEntries: BROWSER_PANE_SEARCH_ENTRIES
      },
      {
        id: 'notifications',
        title: 'Notifications',
        description: 'Native desktop notifications for agent and terminal events.',
        icon: Bell,
        searchEntries: NOTIFICATIONS_PANE_SEARCH_ENTRIES
      },
      {
        id: 'orchestration',
        title: 'Orchestration',
        description: 'Coordinate multiple coding agents through Orca.',
        icon: Network,
        searchEntries: ORCHESTRATION_PANE_SEARCH_ENTRIES
      },
      {
        id: 'mobile',
        title: 'Mobile',
        description: 'Control terminals and agents from your phone.',
        icon: Smartphone,
        searchEntries: MOBILE_SETTINGS_PANE_SEARCH_ENTRIES,
        badge: 'Beta'
      },
      {
        id: 'computer-use',
        title: 'Computer Use',
        description: 'Enable agents to control any app on your computer.',
        icon: MousePointerClick,
        searchEntries: COMPUTER_USE_PANE_SEARCH_ENTRIES,
        badge: 'Beta'
      },
      {
        id: 'voice',
        title: 'Voice',
        description: 'Local speech-to-text dictation with on-device models.',
        icon: Mic,
        searchEntries: VOICE_PANE_SEARCH_ENTRIES,
        badge: 'Beta'
      },
      ...(isMac
        ? [
            {
              id: 'developer-permissions' as const,
              title: 'Permissions',
              description: 'macOS privacy access for terminal-launched developer tools.',
              icon: ShieldCheck,
              searchEntries: DEVELOPER_PERMISSIONS_PANE_SEARCH_ENTRIES
            }
          ]
        : []),
      {
        id: 'privacy',
        title: 'Privacy & Telemetry',
        description: 'Anonymous usage data and telemetry controls.',
        icon: Lock,
        searchEntries: PRIVACY_PANE_SEARCH_ENTRIES
      },
      {
        id: 'shortcuts',
        title: 'Shortcuts',
        description: 'Keyboard shortcuts for common actions.',
        icon: Keyboard,
        searchEntries: SHORTCUTS_PANE_SEARCH_ENTRIES
      },
      {
        id: 'integrations',
        title: 'Integrations',
        description: 'GitHub, Linear, and other service connections.',
        icon: Blocks,
        searchEntries: INTEGRATIONS_PANE_SEARCH_ENTRIES
      },
      {
        id: 'stats',
        title: 'Stats & Usage',
        description: 'Orca stats and Claude usage analytics.',
        icon: BarChart3,
        searchEntries: STATS_PANE_SEARCH_ENTRIES
      },
      {
        id: 'ssh',
        title: 'SSH',
        description: 'Remote SSH connections.',
        icon: Server,
        searchEntries: SSH_PANE_SEARCH_ENTRIES
      },
      {
        id: 'experimental',
        title: 'Experimental',
        description: 'New features that are still taking shape. Give them a try.',
        icon: FlaskConical,
        searchEntries: EXPERIMENTAL_PANE_SEARCH_ENTRIES
      },
      ...repos.map((repo) => ({
        id: `repo-${repo.id}`,
        title: repo.displayName,
        description: `${getRepoKindLabel(repo)} • ${repo.path}`,
        icon: SlidersHorizontal,
        searchEntries: getRepositoryPaneSearchEntries(repo)
      }))
    ],
    [isMac, repos, terminalPaneSearchEntries]
  )

  const visibleNavSections = useMemo(
    () =>
      navSections.filter((section) =>
        matchesSettingsSearch(settingsSearchQuery, section.searchEntries)
      ),
    [navSections, settingsSearchQuery]
  )

  useEffect(() => {
    const scrollTargetId = pendingScrollTargetRef.current
    const pendingNavSectionId = pendingNavSectionRef.current
    const visibleIds = new Set(visibleNavSections.map((section) => section.id))

    if (scrollTargetId && pendingNavSectionId && visibleIds.has(pendingNavSectionId)) {
      scrollSectionIntoView(scrollTargetId, contentScrollRef.current)
      flashSectionHighlight(scrollTargetId)
      setActiveSectionId(pendingNavSectionId)
      pendingNavSectionRef.current = null
      pendingScrollTargetRef.current = null
      return
    }

    if (scrollTargetId && pendingNavSectionId && settingsSearchQuery.trim() !== '') {
      setSettingsSearchQuery('')
      return
    }

    if (!visibleIds.has(activeSectionId) && visibleNavSections.length > 0) {
      setActiveSectionId(getFallbackVisibleSection(visibleNavSections)?.id ?? activeSectionId)
    }
  }, [activeSectionId, setSettingsSearchQuery, settingsSearchQuery, visibleNavSections])

  useEffect(() => {
    const container = contentScrollRef.current
    if (!container) {
      return
    }

    const updateActiveSection = (): void => {
      const sections = Array.from(
        container.querySelectorAll<HTMLElement>('[data-settings-section]')
      )
      if (sections.length === 0) {
        return
      }

      // Why: highlight the section that the user is actually reading.
      // We pick the section whose body crosses a probe line ~40% down the
      // viewport (roughly the middle, biased slightly up toward where the
      // eye naturally focuses). Earlier logic used the first section with
      // its top near the container top, which lagged badly — a section
      // could still fill most of the viewport while the sidebar had already
      // advanced to the next one.
      const containerRect = container.getBoundingClientRect()
      const probeY = containerRect.top + containerRect.height * 0.4

      // If we've scrolled to the very bottom, force-highlight the last
      // section even when it's too short to reach the probe line.
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2

      let candidate: HTMLElement | undefined
      for (const section of sections) {
        const rect = section.getBoundingClientRect()
        if (rect.top <= probeY && rect.bottom > probeY) {
          candidate = section
          break
        }
        if (rect.top <= probeY) {
          // Last section whose heading is above the probe line — used
          // when no section straddles the probe (e.g. between sections,
          // or when the probe sits in the gutter above the first one).
          candidate = section
        }
      }
      candidate ??= atBottom ? sections.at(-1) : sections.at(0)
      if (!candidate) {
        return
      }
      setActiveSectionId(candidate.dataset.settingsSection ?? candidate.id)
    }

    let rafId: number | null = null
    const throttledUpdateActiveSection = (): void => {
      if (rafId !== null) {
        return
      }
      rafId = requestAnimationFrame(() => {
        rafId = null
        updateActiveSection()
      })
    }

    updateActiveSection()
    container.addEventListener('scroll', throttledUpdateActiveSection, { passive: true })
    return () => {
      container.removeEventListener('scroll', throttledUpdateActiveSection)
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
    }
  }, [visibleNavSections])

  const scrollToSection = useCallback(
    (
      sectionId: string,
      modifiers?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }
    ) => {
      // Why: Shift-clicking the Experimental sidebar entry unlocks a hidden
      // power-user group. Keep this scoped to the Experimental row so normal
      // shortcut combos on other rows don't accidentally flip state. The
      // unlock persists for the life of the Settings view (resets when
      // Settings is reopened).
      if (sectionId === 'experimental' && modifiers?.shiftKey) {
        setHiddenExperimentalUnlocked((previous) => !previous)
      }
      scrollSectionIntoView(sectionId, contentScrollRef.current)
      flashSectionHighlight(sectionId)
      setActiveSectionId(sectionId)
    },
    []
  )

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Loading settings...
      </div>
    )
  }

  const generalNavSections = visibleNavSections.filter((section) => !section.id.startsWith('repo-'))
  const repoNavSections = visibleNavSections
    .filter((section) => section.id.startsWith('repo-'))
    .map((section) => {
      const repo = repos.find((entry) => entry.id === section.id.replace('repo-', ''))
      return { ...section, badgeColor: repo?.badgeColor, isRemote: !!repo?.connectionId }
    })

  return (
    <div className="settings-view-shell flex min-h-0 flex-1 overflow-hidden bg-background">
      <SettingsSidebar
        activeSectionId={activeSectionId}
        generalSections={generalNavSections}
        repoSections={repoNavSections}
        hasRepos={repos.length > 0}
        searchQuery={settingsSearchQuery}
        searchInputRef={searchInputRef}
        onBack={closeSettingsPage}
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
              <>
                <SettingsSection
                  id="general"
                  title="General"
                  description="Workspace, editor, and updates."
                  searchEntries={GENERAL_PANE_SEARCH_ENTRIES}
                >
                  <GeneralPane settings={settings} updateSettings={updateSettings} />
                </SettingsSection>

                <SettingsSection
                  id="integrations"
                  title="Integrations"
                  description="GitHub, Linear, and other service connections."
                  searchEntries={INTEGRATIONS_PANE_SEARCH_ENTRIES}
                >
                  <IntegrationsPane />
                </SettingsSection>

                <SettingsSection
                  id="agents"
                  title="Agents"
                  description="Manage AI agents, set a default, and customize commands."
                  searchEntries={AGENTS_PANE_SEARCH_ENTRIES}
                >
                  <AgentsPane settings={settings} updateSettings={updateSettings} />
                </SettingsSection>

                <SettingsSection
                  id="accounts"
                  title="Agent Accounts"
                  description="Sign in and switch between Claude, Codex, Gemini, and OpenCode Go accounts."
                  searchEntries={ACCOUNTS_PANE_SEARCH_ENTRIES}
                >
                  <AccountsPane settings={settings} updateSettings={updateSettings} />
                </SettingsSection>

                <SettingsSection
                  id="git"
                  title="Git"
                  description="Branch naming and local ref behavior."
                  searchEntries={GIT_PANE_SEARCH_ENTRIES}
                >
                  <GitPane
                    settings={settings}
                    updateSettings={updateSettings}
                    displayedGitUsername={displayedGitUsername}
                  />
                </SettingsSection>

                <SettingsSection
                  id="appearance"
                  title="Appearance"
                  description="Theme and UI scaling."
                  searchEntries={APPEARANCE_PANE_SEARCH_ENTRIES}
                >
                  <AppearancePane
                    settings={settings}
                    updateSettings={updateSettings}
                    applyTheme={applyTheme}
                    fontSuggestions={fontSuggestions}
                  />
                </SettingsSection>

                <SettingsSection
                  id="terminal"
                  title="Terminal"
                  description="Terminal appearance, previews, and defaults for new panes."
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
                    wslAvailable={wslAvailable}
                    pwshAvailable={pwshAvailable}
                  />
                </SettingsSection>

                <SettingsSection
                  id="browser"
                  title="Browser"
                  description="Home page, link routing, and session cookies."
                  searchEntries={BROWSER_PANE_SEARCH_ENTRIES}
                >
                  <BrowserPane settings={settings} updateSettings={updateSettings} />
                </SettingsSection>

                <SettingsSection
                  id="notifications"
                  title="Notifications"
                  description="Native desktop notifications for agent activity and terminal events."
                  searchEntries={NOTIFICATIONS_PANE_SEARCH_ENTRIES}
                >
                  <NotificationsPane settings={settings} updateSettings={updateSettings} />
                </SettingsSection>

                <SettingsSection
                  id="orchestration"
                  title="Orchestration"
                  description="Coordinate multiple coding agents through Orca."
                  searchEntries={ORCHESTRATION_PANE_SEARCH_ENTRIES}
                >
                  <OrchestrationPane />
                </SettingsSection>

                <SettingsSection
                  id="mobile"
                  title="Mobile"
                  badge="Beta"
                  description="Control terminals and agents from your phone."
                  searchEntries={MOBILE_SETTINGS_PANE_SEARCH_ENTRIES}
                >
                  <MobileSettingsPane settings={settings} updateSettings={updateSettings} />
                </SettingsSection>

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
                              {computerUsePlatform} Computer Use is an early preview. Some apps and
                              desktop environments may behave inconsistently.
                            </span>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : null
                  }
                  description="Enable agents to control any app on your computer."
                  searchEntries={COMPUTER_USE_PANE_SEARCH_ENTRIES}
                >
                  <ComputerUsePane />
                </SettingsSection>

                <SettingsSection
                  id="voice"
                  title="Voice"
                  badge="Beta"
                  description="Local speech-to-text dictation with on-device models."
                  searchEntries={VOICE_PANE_SEARCH_ENTRIES}
                >
                  <VoicePane settings={settings} updateSettings={updateSettings} />
                </SettingsSection>

                {isMac ? (
                  <SettingsSection
                    id="developer-permissions"
                    title="Permissions"
                    description="macOS privacy access for terminal-launched developer tools."
                    searchEntries={DEVELOPER_PERMISSIONS_PANE_SEARCH_ENTRIES}
                  >
                    <DeveloperPermissionsPane />
                  </SettingsSection>
                ) : null}

                <SettingsSection
                  id="privacy"
                  title="Privacy & Telemetry"
                  description="Anonymous usage data and telemetry controls."
                  searchEntries={PRIVACY_PANE_SEARCH_ENTRIES}
                >
                  <PrivacyPane settings={settings} />
                </SettingsSection>

                <SettingsSection
                  id="shortcuts"
                  title="Shortcuts"
                  description="Keyboard shortcuts for common actions."
                  searchEntries={SHORTCUTS_PANE_SEARCH_ENTRIES}
                >
                  <ShortcutsPane />
                </SettingsSection>

                <SettingsSection
                  id="stats"
                  title="Stats"
                  description="How much Orca has helped you."
                  searchEntries={STATS_PANE_SEARCH_ENTRIES}
                >
                  <StatsPane />
                </SettingsSection>

                <SettingsSection
                  id="ssh"
                  title="SSH"
                  description="Manage remote SSH connections. Connect to remote servers to browse files, run terminals, and use git."
                  searchEntries={SSH_PANE_SEARCH_ENTRIES}
                >
                  <SshPane />
                </SettingsSection>

                <SettingsSection
                  id="experimental"
                  title="Experimental"
                  description="New features that are still taking shape. Give them a try."
                  searchEntries={EXPERIMENTAL_PANE_SEARCH_ENTRIES}
                >
                  <ExperimentalPane
                    settings={settings}
                    updateSettings={updateSettings}
                    hiddenExperimentalUnlocked={hiddenExperimentalUnlocked}
                  />
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
                      <RepositoryPane
                        repo={repo}
                        yamlHooks={repoHooksState?.hooks ?? null}
                        hasHooksFile={repoHooksState?.hasHooks ?? false}
                        mayNeedUpdate={repoHooksState?.mayNeedUpdate ?? false}
                        updateRepo={updateRepo}
                        removeRepo={removeRepo}
                      />
                    </SettingsSection>
                  )
                })}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Settings
