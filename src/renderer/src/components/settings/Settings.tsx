/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Bell,
  Bot,
  FlaskConical,
  GitBranch,
  Globe,
  Keyboard,
  Palette,
  Server,
  SlidersHorizontal,
  SquareTerminal
} from 'lucide-react'
import type { OrcaHooks } from '../../../../shared/types'
import { getRepoKindLabel, isFolderRepo } from '../../../../shared/repo-kind'
import { useAppStore } from '../../store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { SCROLLBACK_PRESETS_MB, getFallbackTerminalFonts } from './SettingsConstants'
import { GeneralPane, GENERAL_PANE_SEARCH_ENTRIES } from './GeneralPane'
import { BrowserPane, BROWSER_PANE_SEARCH_ENTRIES } from './BrowserPane'
import { AppearancePane, APPEARANCE_PANE_SEARCH_ENTRIES } from './AppearancePane'
import { ShortcutsPane, SHORTCUTS_PANE_SEARCH_ENTRIES } from './ShortcutsPane'
import { TerminalPane } from './TerminalPane'
import { RepositoryPane, getRepositoryPaneSearchEntries } from './RepositoryPane'
import { getTerminalPaneSearchEntries } from './terminal-search'
import { GitPane, GIT_PANE_SEARCH_ENTRIES } from './GitPane'
import { NotificationsPane, NOTIFICATIONS_PANE_SEARCH_ENTRIES } from './NotificationsPane'
import { SshPane, SSH_PANE_SEARCH_ENTRIES } from './SshPane'
import { ExperimentalPane, EXPERIMENTAL_PANE_SEARCH_ENTRIES } from './ExperimentalPane'
import { AgentsPane, AGENTS_PANE_SEARCH_ENTRIES } from './AgentsPane'
import { StatsPane, STATS_PANE_SEARCH_ENTRIES } from '../stats/StatsPane'
import { SettingsSidebar } from './SettingsSidebar'
import { SettingsSection } from './SettingsSection'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'

type SettingsNavTarget =
  | 'general'
  | 'browser'
  | 'git'
  | 'appearance'
  | 'terminal'
  | 'notifications'
  | 'shortcuts'
  | 'stats'
  | 'ssh'
  | 'experimental'
  | 'agents'
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

// Why: after a sidebar jump the target section is now in the viewport center
// rather than the top, which can make it less obvious which section just
// scrolled into view. Pulsing the border for a moment reassures the user that
// their click landed on the right section.
const SECTION_FLASH_CLASS = 'settings-section-flash'
const SECTION_FLASH_DURATION_MS = 900

function scrollSectionIntoView(sectionId: string, container: HTMLElement | null): void {
  const target = document.getElementById(sectionId)
  if (!target) {
    return
  }
  // Why: centering a tall section pushes its heading above the viewport,
  // which defeats the purpose of jumping to it. Only center when the whole
  // section fits; otherwise align to the top so the title is always visible.
  const fitsInViewport = container
    ? target.getBoundingClientRect().height <= container.clientHeight
    : true
  target.scrollIntoView({ block: fitsInViewport ? 'center' : 'start' })
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
  // Why: the Terminal settings section shares one search index with the
  // sidebar. We trim platform-only entries on other platforms so search never
  // reveals controls that the renderer will intentionally hide.
  const terminalPaneSearchEntries = useMemo(
    () => getTerminalPaneSearchEntries({ isWindows, isMac }),
    [isWindows, isMac]
  )
  const [scrollbackMode, setScrollbackMode] = useState<'preset' | 'custom'>('preset')
  const [prevScrollbackBytes, setPrevScrollbackBytes] = useState(settings?.terminalScrollbackBytes)
  const [terminalFontSuggestions, setTerminalFontSuggestions] = useState<string[]>(
    getFallbackTerminalFonts()
  )
  const [activeSectionId, setActiveSectionId] = useState('general')
  const contentScrollRef = useRef<HTMLDivElement | null>(null)
  const terminalFontsLoadedRef = useRef(false)
  const pendingNavSectionRef = useRef<string | null>(null)
  const pendingScrollTargetRef = useRef<string | null>(null)

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  useEffect(
    () => () => {
      // Why: the settings search is a transient in-page filter. Leaving it behind makes the next
      // visit look partially broken because whole sections stay hidden before the user types again.
      setSettingsSearchQuery('')
    },
    [setSettingsSearchQuery]
  )

  useEffect(() => {
    if (!settingsNavigationTarget) {
      return
    }

    const paneSectionId = getSettingsSectionId(
      settingsNavigationTarget.pane as SettingsNavTarget,
      settingsNavigationTarget.repoId
    )
    pendingNavSectionRef.current = paneSectionId
    pendingScrollTargetRef.current = settingsNavigationTarget.sectionId ?? paneSectionId
    clearSettingsTarget()
  }, [clearSettingsTarget, settingsNavigationTarget])

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
        setTerminalFontSuggestions((prev) => Array.from(new Set([...fonts, ...prev])).slice(0, 320))
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
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else if (theme === 'light') {
      root.classList.remove('dark')
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      if (prefersDark) {
        root.classList.add('dark')
      } else {
        root.classList.remove('dark')
      }
    }
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
        id: 'shortcuts',
        title: 'Shortcuts',
        description: 'Keyboard shortcuts for common actions.',
        icon: Keyboard,
        searchEntries: SHORTCUTS_PANE_SEARCH_ENTRIES
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
        searchEntries: SSH_PANE_SEARCH_ENTRIES,
        badge: 'Beta'
      },
      {
        id: 'experimental',
        title: 'Experimental',
        description: 'Features that are still being stabilized. Enable at your own risk.',
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
    [repos, terminalPaneSearchEntries]
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
      if (atBottom) {
        candidate = sections.at(-1)
      } else {
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
        candidate ??= sections.at(0)
      }
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

  const scrollToSection = useCallback((sectionId: string) => {
    scrollSectionIntoView(sectionId, contentScrollRef.current)
    flashSectionHighlight(sectionId)
    setActiveSectionId(sectionId)
  }, [])

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
                  id="agents"
                  title="Agents"
                  description="Manage AI agents, set a default, and customize commands."
                  searchEntries={AGENTS_PANE_SEARCH_ENTRIES}
                >
                  <AgentsPane settings={settings} updateSettings={updateSettings} />
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
                  />
                </SettingsSection>

                <SettingsSection
                  id="terminal"
                  title="Terminal"
                  description="Terminal appearance, previews, and defaults for new panes."
                  searchEntries={terminalPaneSearchEntries}
                >
                  <TerminalPane
                    settings={settings}
                    updateSettings={updateSettings}
                    systemPrefersDark={systemPrefersDark}
                    terminalFontSuggestions={terminalFontSuggestions}
                    scrollbackMode={scrollbackMode}
                    setScrollbackMode={setScrollbackMode}
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
                  badge="Beta"
                  description="Manage remote SSH connections. Connect to remote servers to browse files, run terminals, and use git."
                  searchEntries={SSH_PANE_SEARCH_ENTRIES}
                >
                  <SshPane />
                </SettingsSection>

                <SettingsSection
                  id="experimental"
                  title="Experimental"
                  description="Features that are still being stabilized. Enable at your own risk."
                  searchEntries={EXPERIMENTAL_PANE_SEARCH_ENTRIES}
                >
                  <ExperimentalPane settings={settings} updateSettings={updateSettings} />
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
