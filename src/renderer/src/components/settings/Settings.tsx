import { useEffect, useState, useCallback, useRef } from 'react'
import type { OrcaHooks } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { ScrollArea } from '../ui/scroll-area'
import { Button } from '../ui/button'
import { ArrowLeft, Palette, SlidersHorizontal, SquareTerminal } from 'lucide-react'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import { SCROLLBACK_PRESETS_MB, getFallbackTerminalFonts } from './SettingsConstants'
import { GeneralPane } from './GeneralPane'
import { AppearancePane } from './AppearancePane'
import { TerminalPane } from './TerminalPane'
import { RepositoryPane } from './RepositoryPane'

function Settings(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const removeRepo = useAppStore((s) => s.removeRepo)

  const [selectedPane, setSelectedPane] = useState<'general' | 'appearance' | 'terminal' | 'repo'>(
    'general'
  )
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [repoHooksMap, setRepoHooksMap] = useState<
    Record<string, { hasHooks: boolean; hooks: OrcaHooks | null }>
  >({})
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark())
  const [scrollbackMode, setScrollbackMode] = useState<'preset' | 'custom'>('preset')
  const [prevSettings, setPrevSettings] = useState(settings)
  const [terminalFontSuggestions, setTerminalFontSuggestions] = useState<string[]>(
    getFallbackTerminalFonts()
  )
  const terminalFontsLoadedRef = useRef(false)

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

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
    if (selectedPane !== 'terminal' || terminalFontsLoadedRef.current) {
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
  }, [selectedPane])

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
    const checkHooks = async () => {
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
      checkHooks()
    } else {
      setRepoHooksMap({})
    }

    return () => {
      stale = true
    }
  }, [repos])

  // Validate selectedRepoId against current repos (adjusting state during render)
  if (repos.length === 0) {
    if (selectedRepoId !== null) {
      setSelectedRepoId(null)
      if (selectedPane === 'repo') {
        setSelectedPane('general')
      }
    }
  } else if (!selectedRepoId || !repos.some((repo) => repo.id === selectedRepoId)) {
    setSelectedRepoId(repos[0].id)
  }

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

  const selectedRepo = repos.find((repo) => repo.id === selectedRepoId) ?? null
  const selectedYamlHooks = selectedRepo ? (repoHooksMap[selectedRepo.id]?.hooks ?? null) : null
  const showGeneralPane = selectedPane === 'general'
  const showAppearancePane = selectedPane === 'appearance'
  const showTerminalPane = selectedPane === 'terminal'
  const showRepoPane = selectedPane === 'repo' && !!selectedRepo
  const displayedGitUsername = (selectedRepo ?? repos[0])?.gitUsername ?? ''

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Loading settings...
      </div>
    )
  }

  const contentClassName = 'w-full max-w-5xl px-8'
  const pageHeader = showGeneralPane ? (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold">General</h1>
      <p className="text-sm text-muted-foreground">Workspace, naming, and updates.</p>
    </div>
  ) : showAppearancePane ? (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold">Appearance</h1>
      <p className="text-sm text-muted-foreground">Theme and UI scaling.</p>
    </div>
  ) : showTerminalPane ? (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold">Terminal</h1>
      <p className="text-sm text-muted-foreground">
        Terminal appearance, previews, and defaults for new panes.
      </p>
    </div>
  ) : selectedRepo ? (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <span
          className="size-3 rounded-full"
          style={{ backgroundColor: selectedRepo.badgeColor }}
        />
        <h1 className="text-2xl font-semibold">{selectedRepo.displayName}</h1>
      </div>
      <p className="font-mono text-xs text-muted-foreground">{selectedRepo.path}</p>
    </div>
  ) : (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold">Repository Settings</h1>
      <p className="text-sm text-muted-foreground">Select a repository to edit its settings.</p>
    </div>
  )

  return (
    <div className="settings-view-shell flex min-h-0 flex-1 overflow-hidden bg-background">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-border/50 bg-card/40">
        <div className="border-b border-border/50 px-3 py-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActiveView('terminal')}
            className="w-full justify-start gap-2 text-muted-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to app
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 px-3 py-4">
            <div className="space-y-1">
              <button
                onClick={() => setSelectedPane('general')}
                className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  showGeneralPane
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                <SlidersHorizontal className="mr-2 size-4" />
                General
              </button>
              <button
                onClick={() => setSelectedPane('appearance')}
                className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  showAppearancePane
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                <Palette className="mr-2 size-4" />
                Appearance
              </button>
              <button
                onClick={() => setSelectedPane('terminal')}
                className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  showTerminalPane
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                <SquareTerminal className="mr-2 size-4" />
                Terminal
              </button>
            </div>

            <div className="space-y-2">
              <p className="px-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Repositories
              </p>

              {repos.length === 0 ? (
                <p className="px-3 text-xs text-muted-foreground">No repositories added yet.</p>
              ) : (
                <div className="space-y-1">
                  {repos.map((repo) => (
                    <button
                      key={repo.id}
                      onClick={() => {
                        setSelectedRepoId(repo.id)
                        setSelectedPane('repo')
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        showRepoPane && selectedRepoId === repo.id
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      }`}
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: repo.badgeColor }}
                      />
                      <span className="truncate">{repo.displayName}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="sticky top-0 z-10 border-b border-border/50 bg-background/95 py-6 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className={contentClassName}>{pageHeader}</div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className={`${contentClassName} py-8`}>
            {showGeneralPane ? (
              <GeneralPane
                settings={settings}
                updateSettings={updateSettings}
                displayedGitUsername={displayedGitUsername}
              />
            ) : showAppearancePane ? (
              <AppearancePane
                settings={settings}
                updateSettings={updateSettings}
                applyTheme={applyTheme}
              />
            ) : showTerminalPane ? (
              <TerminalPane
                settings={settings}
                updateSettings={updateSettings}
                systemPrefersDark={systemPrefersDark}
                terminalFontSuggestions={terminalFontSuggestions}
                scrollbackMode={scrollbackMode}
                setScrollbackMode={setScrollbackMode}
              />
            ) : selectedRepo ? (
              <RepositoryPane
                repo={selectedRepo}
                yamlHooks={selectedYamlHooks}
                updateRepo={updateRepo}
                removeRepo={removeRepo}
              />
            ) : (
              <div className="flex min-h-[24rem] items-center justify-center text-sm text-muted-foreground">
                Select a repository to edit its settings.
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

export default Settings
