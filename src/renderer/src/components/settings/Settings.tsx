import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, Palette, SlidersHorizontal, SquareTerminal } from 'lucide-react'
import type { OrcaHooks } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import { SCROLLBACK_PRESETS_MB, getFallbackTerminalFonts } from './SettingsConstants'
import { GeneralPane, GENERAL_PANE_SEARCH_ENTRIES } from './GeneralPane'
import { AppearancePane, APPEARANCE_PANE_SEARCH_ENTRIES } from './AppearancePane'
import { ShortcutsPane, SHORTCUTS_PANE_SEARCH_ENTRIES } from './ShortcutsPane'
import { TerminalPane, TERMINAL_PANE_SEARCH_ENTRIES } from './TerminalPane'
import { RepositoryPane, getRepositoryPaneSearchEntries } from './RepositoryPane'
import { SettingsSidebar } from './SettingsSidebar'
import { SettingsSection } from './SettingsSection'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'

type SettingsNavTarget = 'general' | 'appearance' | 'terminal' | 'shortcuts' | 'repo'

type SettingsNavSection = {
  id: string
  title: string
  description: string
  icon: typeof SlidersHorizontal
  searchEntries: SettingsSearchEntry[]
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

function Settings(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const removeRepo = useAppStore((s) => s.removeRepo)
  const settingsNavigationTarget = useAppStore((s) => s.settingsNavigationTarget)
  const clearSettingsTarget = useAppStore((s) => s.clearSettingsTarget)
  const settingsSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)

  const [repoHooksMap, setRepoHooksMap] = useState<
    Record<string, { hasHooks: boolean; hooks: OrcaHooks | null }>
  >({})
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark())
  const [scrollbackMode, setScrollbackMode] = useState<'preset' | 'custom'>('preset')
  const [prevSettings, setPrevSettings] = useState(settings)
  const [terminalFontSuggestions, setTerminalFontSuggestions] = useState<string[]>(
    getFallbackTerminalFonts()
  )
  const [activeSectionId, setActiveSectionId] = useState('general')
  const contentScrollRef = useRef<HTMLDivElement | null>(null)
  const terminalFontsLoadedRef = useRef(false)
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

    // Why: settings entry points elsewhere in the app target a section, not a
    // transient tab, so the scroll-based settings page needs an explicit anchor
    // handoff to land the user on the intended configuration block.
    pendingScrollTargetRef.current = getSettingsSectionId(
      settingsNavigationTarget.pane,
      settingsNavigationTarget.repoId
    )
    clearSettingsTarget()
  }, [clearSettingsTarget, settingsNavigationTarget])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (event: MediaQueryListEvent): void => {
      setSystemPrefersDark(event.matches)
    }
    setSystemPrefersDark(media.matches)
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

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

  if (settings !== prevSettings) {
    setPrevSettings(settings)
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
          try {
            const result = await window.api.hooks.check({ repoId: repo.id })
            return [repo.id, result] as const
          } catch {
            return [repo.id, { hasHooks: false, hooks: null }] as const
          }
        })
      )

      if (!stale) {
        setRepoHooksMap(Object.fromEntries(results))
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
        description: 'Workspace, editor, naming, and updates.',
        icon: SlidersHorizontal,
        searchEntries: GENERAL_PANE_SEARCH_ENTRIES
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
        searchEntries: TERMINAL_PANE_SEARCH_ENTRIES
      },
      {
        id: 'shortcuts',
        title: 'Shortcuts',
        description: 'Keyboard shortcuts for common actions.',
        icon: Keyboard,
        searchEntries: SHORTCUTS_PANE_SEARCH_ENTRIES
      },
      ...repos.map((repo) => ({
        id: `repo-${repo.id}`,
        title: repo.displayName,
        description: repo.path,
        icon: SlidersHorizontal,
        searchEntries: getRepositoryPaneSearchEntries(repo)
      }))
    ],
    [repos]
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
    const visibleIds = new Set(visibleNavSections.map((section) => section.id))

    if (scrollTargetId && visibleIds.has(scrollTargetId)) {
      const target = document.getElementById(scrollTargetId)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActiveSectionId(scrollTargetId)
      pendingScrollTargetRef.current = null
      return
    }

    if (scrollTargetId && settingsSearchQuery.trim() !== '') {
      // Why: keep the ref set so the *next* effect cycle (after the search clears and
      // sections become visible) can scroll to the target via the branch above.
      // The loop concern is mitigated because once the search clears, the target becomes
      // visible, the branch above consumes and clears the ref, and the cycle stops.
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

      const containerTop = container.getBoundingClientRect().top
      const candidate =
        sections.find((section) => section.getBoundingClientRect().top - containerTop >= -24) ??
        sections.at(-1)
      if (!candidate) {
        return
      }
      setActiveSectionId(candidate.dataset.settingsSection ?? candidate.id)
    }

    // Why: the scroll handler runs querySelectorAll + getBoundingClientRect for every
    // section on each scroll event (60+ fps). Wrapping it in a requestAnimationFrame
    // throttle limits it to once per frame, avoiding layout-thrashing jank.
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
    const target = document.getElementById(sectionId)
    if (!target) {
      return
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
      return { ...section, badgeColor: repo?.badgeColor }
    })

  return (
    <div className="settings-view-shell flex min-h-0 flex-1 overflow-hidden bg-background">
      <SettingsSidebar
        activeSectionId={activeSectionId}
        generalSections={generalNavSections}
        repoSections={repoNavSections}
        hasRepos={repos.length > 0}
        searchQuery={settingsSearchQuery}
        onBack={() => setActiveView('terminal')}
        onSearchChange={setSettingsSearchQuery}
        onSelectSection={scrollToSection}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border/50 bg-background/95 px-8 py-6 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold">Settings</h1>
            <p className="text-sm text-muted-foreground">
              Search across every settings section without leaving the page.
            </p>
          </div>
        </div>

        <div ref={contentScrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex w-full max-w-5xl flex-col gap-10 px-8 py-8">
            {visibleNavSections.length === 0 ? (
              <div className="flex min-h-[24rem] items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/30 text-sm text-muted-foreground">
                No settings found for &quot;{settingsSearchQuery.trim()}&quot;
              </div>
            ) : (
              <>
                <SettingsSection
                  id="general"
                  title="General"
                  description="Workspace, editor, naming, and updates."
                  searchEntries={GENERAL_PANE_SEARCH_ENTRIES}
                >
                  <GeneralPane
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
                  searchEntries={TERMINAL_PANE_SEARCH_ENTRIES}
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
                  id="shortcuts"
                  title="Shortcuts"
                  description="Keyboard shortcuts for common actions."
                  searchEntries={SHORTCUTS_PANE_SEARCH_ENTRIES}
                >
                  <ShortcutsPane />
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
