import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { OrcaHooks, Repo, RepoHookSettings } from '../../../shared/types'
import { REPO_COLORS, getDefaultRepoHookSettings } from '../../../shared/constants'
import { useAppStore } from '../store'
import { ScrollArea } from './ui/scroll-area'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { TerminalThemePreview } from './settings/TerminalThemePreview'
import {
  BUILTIN_TERMINAL_THEME_NAMES,
  clampNumber,
  getSystemPrefersDark,
  normalizeColor,
  resolvePaneStyleOptions,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import {
  ArrowLeft,
  Check,
  ChevronsUpDown,
  CircleX,
  FolderOpen,
  Minus,
  Plus,
  SlidersHorizontal,
  RotateCcw,
  SquareTerminal,
  Trash2
} from 'lucide-react'

type HookName = keyof OrcaHooks['scripts']
const DEFAULT_REPO_HOOK_SETTINGS = getDefaultRepoHookSettings()
const MAX_THEME_RESULTS = 80
const MAX_FONT_RESULTS = 12
const SCROLLBACK_PRESETS_MB = [10, 25, 50, 100, 250] as const
const ZOOM_STEP = 0.5
const ZOOM_MIN = -3
const ZOOM_MAX = 5

function zoomLevelToPercent(level: number): number {
  return Math.round(100 * Math.pow(1.2, level))
}

function UIZoomControl(): React.JSX.Element {
  const [zoomLevel, setZoomLevel] = useState(() => window.api.ui.getZoomLevel())

  useEffect(() => {
    return window.api.ui.onTerminalZoom((direction) => {
      setZoomLevel(window.api.ui.getZoomLevel())
      // Small delay to read after the level is actually applied
      setTimeout(() => setZoomLevel(window.api.ui.getZoomLevel()), 50)
    })
  }, [])

  const applyZoom = useCallback((level: number) => {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level))
    window.api.ui.setZoomLevel(clamped)
    setZoomLevel(clamped)
  }, [])

  const percent = zoomLevelToPercent(zoomLevel)

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => applyZoom(zoomLevel - ZOOM_STEP)}
        disabled={zoomLevel <= ZOOM_MIN}
      >
        <Minus className="size-3" />
      </Button>
      <span className="w-14 text-center text-sm tabular-nums text-foreground">{percent}%</span>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => applyZoom(zoomLevel + ZOOM_STEP)}
        disabled={zoomLevel >= ZOOM_MAX}
      >
        <Plus className="size-3" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => applyZoom(0)}
        disabled={zoomLevel === 0}
        className="ml-1 gap-1.5"
      >
        <RotateCcw className="size-3" />
        Reset
      </Button>
    </div>
  )
}

function getFallbackTerminalFonts(): string[] {
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { userAgentData?: { platform?: string } })
      : null
  const platform = nav ? (nav.userAgentData?.platform ?? nav.platform ?? '') : ''
  const normalizedPlatform = platform.toLowerCase()

  if (normalizedPlatform.includes('mac')) {
    return ['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code']
  }

  if (normalizedPlatform.includes('win')) {
    return ['Cascadia Mono', 'Consolas', 'Lucida Console', 'JetBrains Mono', 'Fira Code']
  }

  return [
    'JetBrains Mono',
    'Fira Code',
    'DejaVu Sans Mono',
    'Liberation Mono',
    'Ubuntu Mono',
    'Noto Sans Mono'
  ]
}

type ThemePickerProps = {
  label: string
  description: string
  selectedTheme: string
  query: string
  onQueryChange: (value: string) => void
  onSelectTheme: (theme: string) => void
}

type ColorFieldProps = {
  label: string
  description: string
  value: string
  fallback: string
  onChange: (value: string) => void
}

function ThemePicker({
  label,
  description,
  selectedTheme,
  query,
  onQueryChange,
  onSelectTheme
}: ThemePickerProps): React.JSX.Element {
  const normalizedQuery = query.trim().toLowerCase()
  const filteredThemes = BUILTIN_TERMINAL_THEME_NAMES.filter((theme) =>
    theme.toLowerCase().includes(normalizedQuery)
  ).slice(0, MAX_THEME_RESULTS)

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search builtin themes"
      />
      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
          <span>Selected: {selectedTheme}</span>
          <span>
            Showing {filteredThemes.length}
            {normalizedQuery
              ? ` matching "${query.trim()}"`
              : ` of ${BUILTIN_TERMINAL_THEME_NAMES.length}`}
          </span>
        </div>
        <ScrollArea className="h-64">
          <div className="space-y-1 p-2">
            {filteredThemes.map((theme) => (
              <button
                key={theme}
                onClick={() => onSelectTheme(theme)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  selectedTheme === theme
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'hover:bg-muted/60'
                }`}
              >
                <span className="truncate">{theme}</span>
                {selectedTheme === theme ? (
                  <span className="ml-3 shrink-0 text-[11px] uppercase tracking-[0.16em]">
                    Current
                  </span>
                ) : null}
              </button>
            ))}
            {filteredThemes.length === 0 ? (
              <div className="px-3 py-6 text-sm text-muted-foreground">No themes found.</div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

function ColorField({
  label,
  description,
  value,
  fallback,
  onChange
}: ColorFieldProps): React.JSX.Element {
  const normalized = normalizeColor(value, fallback)

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="color"
          value={normalized}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 rounded-md border border-input bg-transparent p-1"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={fallback}
          className="max-w-xs font-mono text-xs"
        />
      </div>
    </div>
  )
}

type NumberFieldProps = {
  label: string
  description: string
  value: number
  defaultValue?: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  suffix?: string
}

type FontAutocompleteProps = {
  value: string
  suggestions: string[]
  onChange: (value: string) => void
}

function NumberField({
  label,
  description,
  value,
  defaultValue,
  min,
  max,
  step = 1,
  onChange,
  suffix
}: NumberFieldProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-3">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? String(value) : ''}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (!Number.isFinite(next)) return
            onChange(next)
          }}
          className="number-input-clean w-28 tabular-nums"
        />
        {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Current: {value}
        {defaultValue !== undefined ? ` · Default: ${defaultValue}` : ''}
      </p>
    </div>
  )
}

function FontAutocomplete({
  value,
  suggestions,
  onChange
}: FontAutocompleteProps): React.JSX.Element {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setQuery(value)
  }, [value])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const normalizedQuery = query.trim().toLowerCase()
  const filteredSuggestions = useMemo(() => {
    const startsWith = suggestions.filter((font) => font.toLowerCase().startsWith(normalizedQuery))
    const includes = suggestions.filter(
      (font) =>
        !font.toLowerCase().startsWith(normalizedQuery) &&
        font.toLowerCase().includes(normalizedQuery)
    )
    const ordered = normalizedQuery ? [...startsWith, ...includes] : suggestions
    return ordered.slice(0, MAX_FONT_RESULTS)
  }, [suggestions, normalizedQuery])

  const commitValue = (nextValue: string): void => {
    setQuery(nextValue)
    onChange(nextValue)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative max-w-sm">
      <div className="relative">
        <Input
          value={query}
          onChange={(e) => {
            const next = e.target.value
            setQuery(next)
            onChange(next)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder="SF Mono"
          className="pr-18"
        />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                onChange('')
                setOpen(true)
              }}
              className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Clear font selection"
              title="Clear"
            >
              <CircleX className="size-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Toggle font suggestions"
            title="Fonts"
          >
            <ChevronsUpDown className="size-3.5" />
          </button>
        </div>
      </div>

      {open ? (
        <div className="absolute top-full z-20 mt-2 w-full overflow-hidden rounded-md border bg-popover shadow-md">
          <ScrollArea className="max-h-64">
            <div className="p-1">
              {filteredSuggestions.length > 0 ? (
                filteredSuggestions.map((font) => (
                  <button
                    key={font}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitValue(font)}
                    className={`flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors ${
                      font === value ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60'
                    }`}
                  >
                    <span className="truncate">{font}</span>
                    {font === value ? <Check className="ml-3 size-4 shrink-0" /> : null}
                  </button>
                ))
              ) : (
                <div className="px-3 py-3 text-sm text-muted-foreground">No matching fonts.</div>
              )}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}

function Settings(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const removeRepo = useAppStore((s) => s.removeRepo)

  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [selectedPane, setSelectedPane] = useState<'general' | 'terminal' | 'repo'>('general')
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [repoHooksMap, setRepoHooksMap] = useState<
    Record<string, { hasHooks: boolean; hooks: OrcaHooks | null }>
  >({})
  const [defaultBaseRef, setDefaultBaseRef] = useState('origin/main')
  const [baseRefQuery, setBaseRefQuery] = useState('')
  const [baseRefResults, setBaseRefResults] = useState<string[]>([])
  const [isSearchingBaseRefs, setIsSearchingBaseRefs] = useState(false)
  const [themeSearchDark, setThemeSearchDark] = useState('')
  const [themeSearchLight, setThemeSearchLight] = useState('')
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark())
  const [scrollbackMode, setScrollbackMode] = useState<'preset' | 'custom'>('preset')
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
    if (selectedPane !== 'terminal' || terminalFontsLoadedRef.current) return

    let stale = false

    const loadFontSuggestions = async (): Promise<void> => {
      try {
        const fonts = await window.api.settings.listFonts()
        if (stale || fonts.length === 0) return
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

  useEffect(() => {
    if (!settings) return

    const scrollbackMb = Math.max(1, Math.round(settings.terminalScrollbackBytes / 1_000_000))
    setScrollbackMode(
      SCROLLBACK_PRESETS_MB.includes(scrollbackMb as (typeof SCROLLBACK_PRESETS_MB)[number])
        ? 'preset'
        : 'custom'
    )
  }, [settings])

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

  useEffect(() => {
    let stale = false

    const loadDefaultBaseRef = async (repoId: string) => {
      try {
        const result = await window.api.repos.getBaseRefDefault({ repoId })
        if (stale) return
        setDefaultBaseRef(result)
      } catch {
        if (stale) return
        setDefaultBaseRef('origin/main')
      }
    }

    if (!selectedRepoId) {
      setDefaultBaseRef('origin/main')
      setBaseRefQuery('')
      setBaseRefResults([])
    } else {
      setBaseRefQuery('')
      setBaseRefResults([])
      void loadDefaultBaseRef(selectedRepoId)
    }

    return () => {
      stale = true
    }
  }, [selectedRepoId])

  useEffect(() => {
    if (!selectedRepoId) return

    const trimmedQuery = baseRefQuery.trim()
    if (trimmedQuery.length < 2) {
      setBaseRefResults([])
      setIsSearchingBaseRefs(false)
      return
    }

    let stale = false
    setIsSearchingBaseRefs(true)

    const timer = window.setTimeout(() => {
      void window.api.repos
        .searchBaseRefs({
          repoId: selectedRepoId,
          query: trimmedQuery,
          limit: 20
        })
        .then((results) => {
          if (!stale) {
            setBaseRefResults(results)
          }
        })
        .catch(() => {
          if (!stale) {
            setBaseRefResults([])
          }
        })
        .finally(() => {
          if (!stale) {
            setIsSearchingBaseRefs(false)
          }
        })
    }, 200)

    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [selectedRepoId, baseRefQuery])

  useEffect(() => {
    if (repos.length === 0) {
      setSelectedRepoId(null)
      setSelectedPane('general')
      return
    }

    if (!selectedRepoId || !repos.some((repo) => repo.id === selectedRepoId)) {
      setSelectedRepoId(repos[0].id)
    }
  }, [repos, selectedRepoId])

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

  const handleBrowseWorkspace = async () => {
    const path = await window.api.repos.pickFolder()
    if (path) {
      updateSettings({ workspaceDir: path })
    }
  }

  const handleRemoveRepo = (repoId: string) => {
    if (confirmingRemove === repoId) {
      removeRepo(repoId)
      setConfirmingRemove(null)
      return
    }

    setConfirmingRemove(repoId)
  }

  const selectedRepo = repos.find((repo) => repo.id === selectedRepoId) ?? null
  const selectedYamlHooks = selectedRepo ? (repoHooksMap[selectedRepo.id]?.hooks ?? null) : null
  const showGeneralPane = selectedPane === 'general'
  const showTerminalPane = selectedPane === 'terminal'
  const showRepoPane = selectedPane === 'repo' && !!selectedRepo
  const displayedGitUsername = (selectedRepo ?? repos[0])?.gitUsername ?? ''
  const effectiveBaseRef = selectedRepo?.worktreeBaseRef ?? defaultBaseRef

  const updateSelectedRepoHookSettings = (
    repo: Repo,
    updates: Omit<Partial<RepoHookSettings>, 'scripts'> & {
      scripts?: Partial<RepoHookSettings['scripts']>
    }
  ) => {
    const nextSettings: RepoHookSettings = {
      ...DEFAULT_REPO_HOOK_SETTINGS,
      ...repo.hookSettings,
      ...updates,
      scripts: {
        ...DEFAULT_REPO_HOOK_SETTINGS.scripts,
        ...repo.hookSettings?.scripts,
        ...updates.scripts
      }
    }

    updateRepo(repo.id, {
      hookSettings: nextSettings
    })
  }

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Loading settings...
      </div>
    )
  }

  const darkPreviewAppearance = resolveEffectiveTerminalAppearance(
    {
      ...settings,
      theme: 'dark'
    },
    systemPrefersDark
  )
  const lightPreviewAppearance = resolveEffectiveTerminalAppearance(
    {
      ...settings,
      theme: 'light'
    },
    systemPrefersDark
  )
  const paneStyleOptions = resolvePaneStyleOptions(settings)
  const scrollbackMb = Math.max(1, Math.round(settings.terminalScrollbackBytes / 1_000_000))
  const scrollbackPresetSelection = SCROLLBACK_PRESETS_MB.includes(
    scrollbackMb as (typeof SCROLLBACK_PRESETS_MB)[number]
  )
    ? `${scrollbackMb}`
    : 'custom'
  const scrollbackToggleValue = scrollbackMode === 'custom' ? 'custom' : scrollbackPresetSelection
  const contentClassName = 'w-full max-w-5xl px-8'
  const pageHeader = showGeneralPane ? (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold">General</h1>
      <p className="text-sm text-muted-foreground">Workspace, naming, and appearance defaults.</p>
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
      <aside className="flex w-[260px] shrink-0 flex-col border-r bg-card/40">
        <div className="border-b px-3 py-3">
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
        <div className="sticky top-0 z-10 border-b bg-background/95 py-6 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className={contentClassName}>{pageHeader}</div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className={`${contentClassName} py-8`}>
            {showGeneralPane ? (
              <div className="space-y-8">
                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">Workspace</h2>
                    <p className="text-xs text-muted-foreground">
                      Configure where new worktrees are created.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm">Workspace Directory</Label>
                    <div className="flex gap-2">
                      <Input
                        value={settings.workspaceDir}
                        onChange={(e) => updateSettings({ workspaceDir: e.target.value })}
                        className="flex-1 font-mono text-xs"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleBrowseWorkspace}
                        className="shrink-0 gap-1.5"
                      >
                        <FolderOpen className="size-3.5" />
                        Browse
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Root directory where worktree folders are created.
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-4 px-1 py-2">
                    <div className="space-y-0.5">
                      <Label className="text-sm">Nest Workspaces</Label>
                      <p className="text-xs text-muted-foreground">
                        Create worktrees inside a repo-named subfolder.
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={settings.nestWorkspaces}
                      onClick={() =>
                        updateSettings({
                          nestWorkspaces: !settings.nestWorkspaces
                        })
                      }
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                        settings.nestWorkspaces ? 'bg-foreground' : 'bg-muted-foreground/30'
                      }`}
                    >
                      <span
                        className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                          settings.nestWorkspaces ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                </section>

                <Separator />

                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">Branch Naming</h2>
                    <p className="text-xs text-muted-foreground">
                      Prefix added to branch names when creating worktrees.
                    </p>
                  </div>

                  <div className="flex w-fit gap-1 rounded-md border p-1">
                    {(['git-username', 'custom', 'none'] as const).map((option) => (
                      <button
                        key={option}
                        onClick={() => updateSettings({ branchPrefix: option })}
                        className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                          settings.branchPrefix === option
                            ? 'bg-accent font-medium text-accent-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {option === 'git-username'
                          ? 'Git Username'
                          : option === 'custom'
                            ? 'Custom'
                            : 'None'}
                      </button>
                    ))}
                  </div>
                  {(settings.branchPrefix === 'custom' ||
                    settings.branchPrefix === 'git-username') && (
                    <Input
                      value={
                        settings.branchPrefix === 'git-username'
                          ? displayedGitUsername
                          : settings.branchPrefixCustom
                      }
                      onChange={(e) => updateSettings({ branchPrefixCustom: e.target.value })}
                      placeholder={
                        settings.branchPrefix === 'git-username'
                          ? 'No git username configured'
                          : 'e.g. feature'
                      }
                      className="max-w-xs"
                      readOnly={settings.branchPrefix === 'git-username'}
                    />
                  )}
                </section>

                <Separator />

                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">Appearance</h2>
                    <p className="text-xs text-muted-foreground">
                      Choose how Orca looks in the app window.
                    </p>
                  </div>

                  <div className="flex w-fit gap-1 rounded-md border p-1">
                    {(['system', 'dark', 'light'] as const).map((option) => (
                      <button
                        key={option}
                        onClick={() => {
                          updateSettings({ theme: option })
                          applyTheme(option)
                        }}
                        className={`rounded-sm px-3 py-1 text-sm capitalize transition-colors ${
                          settings.theme === option
                            ? 'bg-accent font-medium text-accent-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </section>

                <Separator />

                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">UI Zoom</h2>
                    <p className="text-xs text-muted-foreground">
                      Scale the entire application interface. Use{' '}
                      <kbd className="rounded border px-1 py-0.5 text-[10px]">⌘+</kbd> /{' '}
                      <kbd className="rounded border px-1 py-0.5 text-[10px]">⌘-</kbd> when not in a
                      terminal pane.
                    </p>
                  </div>

                  <UIZoomControl />
                </section>
              </div>
            ) : showTerminalPane ? (
              <div className="space-y-8">
                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">Typography</h2>
                    <p className="text-xs text-muted-foreground">
                      Default terminal typography for new panes and live updates.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm">Font Size</Label>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon-sm"
                        onClick={() => {
                          const next = Math.max(10, settings.terminalFontSize - 1)
                          updateSettings({ terminalFontSize: next })
                        }}
                        disabled={settings.terminalFontSize <= 10}
                      >
                        <Minus className="size-3" />
                      </Button>
                      <Input
                        type="number"
                        min={10}
                        max={24}
                        value={settings.terminalFontSize}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!Number.isNaN(value) && value >= 10 && value <= 24) {
                            updateSettings({ terminalFontSize: value })
                          }
                        }}
                        className="w-16 text-center tabular-nums"
                      />
                      <Button
                        variant="outline"
                        size="icon-sm"
                        onClick={() => {
                          const next = Math.min(24, settings.terminalFontSize + 1)
                          updateSettings({ terminalFontSize: next })
                        }}
                        disabled={settings.terminalFontSize >= 24}
                      >
                        <Plus className="size-3" />
                      </Button>
                      <span className="text-xs text-muted-foreground">px</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm">Font Family</Label>
                    <FontAutocomplete
                      value={settings.terminalFontFamily}
                      suggestions={terminalFontSuggestions}
                      onChange={(value) => updateSettings({ terminalFontFamily: value })}
                    />
                  </div>
                </section>

                <Separator />

                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">Cursor</h2>
                    <p className="text-xs text-muted-foreground">
                      Default cursor appearance for Orca terminal panes.
                    </p>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label className="text-sm">Cursor Shape</Label>
                      <div className="flex w-fit gap-1 rounded-md border p-1">
                        {(['bar', 'block', 'underline'] as const).map((option) => (
                          <button
                            key={option}
                            onClick={() => updateSettings({ terminalCursorStyle: option })}
                            className={`rounded-sm px-3 py-1 text-sm capitalize transition-colors ${
                              settings.terminalCursorStyle === option
                                ? 'bg-accent font-medium text-accent-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-4 px-1 py-2">
                      <div className="space-y-0.5">
                        <Label className="text-sm">Blinking Cursor</Label>
                        <p className="text-xs text-muted-foreground">
                          Uses the blinking variant of the selected cursor shape.
                        </p>
                      </div>
                      <button
                        role="switch"
                        aria-checked={settings.terminalCursorBlink}
                        onClick={() =>
                          updateSettings({
                            terminalCursorBlink: !settings.terminalCursorBlink
                          })
                        }
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                          settings.terminalCursorBlink ? 'bg-foreground' : 'bg-muted-foreground/30'
                        }`}
                      >
                        <span
                          className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                            settings.terminalCursorBlink ? 'translate-x-4' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                </section>

                <Separator />

                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">Pane Styling</h2>
                    <p className="text-xs text-muted-foreground">
                      Control inactive pane dimming, divider thickness, and transition timing.
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <NumberField
                      label="Inactive Pane Opacity"
                      description="Opacity applied to panes that are not currently active."
                      value={paneStyleOptions.inactivePaneOpacity}
                      defaultValue={0.8}
                      min={0}
                      max={1}
                      step={0.05}
                      suffix="0 to 1"
                      onChange={(value) =>
                        updateSettings({
                          terminalInactivePaneOpacity: clampNumber(value, 0, 1)
                        })
                      }
                    />
                    <NumberField
                      label="Divider Thickness"
                      description="Thickness of the pane divider line."
                      value={paneStyleOptions.dividerThicknessPx}
                      defaultValue={1}
                      min={1}
                      max={32}
                      step={1}
                      suffix="px"
                      onChange={(value) =>
                        updateSettings({
                          terminalDividerThicknessPx: clampNumber(value, 1, 32)
                        })
                      }
                    />
                  </div>
                </section>

                <Separator />

                <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
                  <div className="space-y-6">
                    <ThemePicker
                      label="Dark Theme"
                      description="Choose the terminal theme used in dark mode."
                      selectedTheme={settings.terminalThemeDark}
                      query={themeSearchDark}
                      onQueryChange={setThemeSearchDark}
                      onSelectTheme={(theme) => updateSettings({ terminalThemeDark: theme })}
                    />

                    <ColorField
                      label="Dark Divider Color"
                      description="Controls the split divider line between panes in dark mode."
                      value={settings.terminalDividerColorDark}
                      fallback="#3f3f46"
                      onChange={(value) => updateSettings({ terminalDividerColorDark: value })}
                    />
                  </div>

                  <TerminalThemePreview
                    title="Dark Mode Preview"
                    description={
                      settings.theme === 'system'
                        ? `System mode is currently ${systemPrefersDark ? 'Dark' : 'Light'}.`
                        : `Orca is currently in ${settings.theme} mode.`
                    }
                    appearance={darkPreviewAppearance}
                    dividerThicknessPx={paneStyleOptions.dividerThicknessPx}
                    inactivePaneOpacity={paneStyleOptions.inactivePaneOpacity}
                    activePaneOpacity={paneStyleOptions.activePaneOpacity}
                  />
                </section>

                <Separator />

                <section className="space-y-4">
                  <div className="flex items-center justify-between gap-4 px-1 py-2">
                    <div className="space-y-0.5">
                      <Label className="text-sm">Use Separate Theme In Light Mode</Label>
                      <p className="text-xs text-muted-foreground">
                        When disabled, light mode reuses the dark terminal theme.
                      </p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={settings.terminalUseSeparateLightTheme}
                      onClick={() =>
                        updateSettings({
                          terminalUseSeparateLightTheme: !settings.terminalUseSeparateLightTheme
                        })
                      }
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                        settings.terminalUseSeparateLightTheme
                          ? 'bg-foreground'
                          : 'bg-muted-foreground/30'
                      }`}
                    >
                      <span
                        className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                          settings.terminalUseSeparateLightTheme
                            ? 'translate-x-4'
                            : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>

                  <div
                    className={`grid overflow-hidden transition-all duration-300 ease-out ${
                      settings.terminalUseSeparateLightTheme
                        ? 'grid-rows-[1fr] opacity-100'
                        : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="min-h-0">
                      <div className="grid gap-6 pt-2 xl:grid-cols-[minmax(0,1fr)_360px]">
                        <div className="space-y-6">
                          <ThemePicker
                            label="Light Theme"
                            description="Choose the theme used when Orca is in light mode."
                            selectedTheme={settings.terminalThemeLight}
                            query={themeSearchLight}
                            onQueryChange={setThemeSearchLight}
                            onSelectTheme={(theme) => updateSettings({ terminalThemeLight: theme })}
                          />

                          <ColorField
                            label="Light Divider Color"
                            description="Controls the split divider line between panes in light mode."
                            value={settings.terminalDividerColorLight}
                            fallback="#d4d4d8"
                            onChange={(value) =>
                              updateSettings({ terminalDividerColorLight: value })
                            }
                          />
                        </div>

                        <TerminalThemePreview
                          title="Light Mode Preview"
                          description="Updates live as you change the light theme or divider color."
                          appearance={lightPreviewAppearance}
                          dividerThicknessPx={paneStyleOptions.dividerThicknessPx}
                          inactivePaneOpacity={paneStyleOptions.inactivePaneOpacity}
                          activePaneOpacity={paneStyleOptions.activePaneOpacity}
                        />
                      </div>
                    </div>
                  </div>
                </section>

                <Separator />

                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">Advanced</h2>
                    <p className="text-xs text-muted-foreground">
                      Scrollback is bounded for stability. This setting applies to new terminal
                      panes.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label className="text-sm">Scrollback Size</Label>
                    <ToggleGroup
                      type="single"
                      value={scrollbackToggleValue}
                      onValueChange={(value) => {
                        if (!value) return
                        if (value === 'custom') {
                          setScrollbackMode('custom')
                          return
                        }

                        setScrollbackMode('preset')
                        updateSettings({
                          terminalScrollbackBytes: Number(value) * 1_000_000
                        })
                      }}
                      variant="outline"
                      size="sm"
                      className="h-8 flex-wrap"
                    >
                      {SCROLLBACK_PRESETS_MB.map((preset) => (
                        <ToggleGroupItem
                          key={preset}
                          value={`${preset}`}
                          className="h-8 px-3 text-xs"
                          aria-label={`${preset} megabytes`}
                        >
                          {preset} MB
                        </ToggleGroupItem>
                      ))}
                      <ToggleGroupItem
                        value="custom"
                        className="h-8 px-3 text-xs"
                        aria-label="Custom"
                      >
                        Custom
                      </ToggleGroupItem>
                    </ToggleGroup>

                    {scrollbackMode === 'custom' ? (
                      <NumberField
                        label="Custom Scrollback"
                        description="Maximum terminal scrollback buffer size."
                        value={scrollbackMb}
                        defaultValue={10}
                        min={1}
                        max={256}
                        step={1}
                        suffix="MB"
                        onChange={(value) =>
                          updateSettings({
                            terminalScrollbackBytes: clampNumber(value, 1, 256) * 1_000_000
                          })
                        }
                      />
                    ) : null}
                  </div>
                </section>
              </div>
            ) : selectedRepo ? (
              <div className="space-y-8">
                <section className="space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <h2 className="text-sm font-semibold">Identity</h2>
                      <p className="text-xs text-muted-foreground">
                        Repo-specific display details for the sidebar and tabs.
                      </p>
                    </div>

                    <Button
                      variant={confirmingRemove === selectedRepo.id ? 'destructive' : 'outline'}
                      size="sm"
                      onClick={() => handleRemoveRepo(selectedRepo.id)}
                      onBlur={() => setConfirmingRemove(null)}
                      className="gap-2"
                    >
                      <Trash2 className="size-3.5" />
                      {confirmingRemove === selectedRepo.id ? 'Confirm Remove' : 'Remove Repo'}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm">Display Name</Label>
                    <Input
                      value={selectedRepo.displayName}
                      onChange={(e) =>
                        updateRepo(selectedRepo.id, {
                          displayName: e.target.value
                        })
                      }
                      className="h-9 text-sm"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm">Badge Color</Label>
                    <div className="flex flex-wrap gap-2">
                      {REPO_COLORS.map((color) => (
                        <button
                          key={color}
                          onClick={() => updateRepo(selectedRepo.id, { badgeColor: color })}
                          className={`size-7 rounded-full transition-all ${
                            selectedRepo.badgeColor === color
                              ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                              : 'hover:ring-1 hover:ring-muted-foreground hover:ring-offset-2 hover:ring-offset-background'
                          }`}
                          style={{ backgroundColor: color }}
                          title={color}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm">Default Worktree Base</Label>
                    <div className="rounded-xl border bg-background/80 p-4 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium text-foreground">
                            {effectiveBaseRef}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {selectedRepo.worktreeBaseRef
                              ? 'Pinned for this repo'
                              : `Following primary branch (${defaultBaseRef})`}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setBaseRefQuery('')
                            setBaseRefResults([])
                            updateRepo(selectedRepo.id, {
                              worktreeBaseRef: undefined
                            })
                          }}
                          disabled={!selectedRepo.worktreeBaseRef}
                        >
                          Use Primary
                        </Button>
                      </div>

                      <div className="mt-4 space-y-2">
                        <Input
                          value={baseRefQuery}
                          onChange={(e) => setBaseRefQuery(e.target.value)}
                          placeholder="Search branches by name..."
                          className="max-w-md"
                        />
                        <p className="text-xs text-muted-foreground">Type at least 2 characters.</p>
                      </div>

                      {isSearchingBaseRefs ? (
                        <p className="mt-3 text-xs text-muted-foreground">Searching branches...</p>
                      ) : null}

                      {!isSearchingBaseRefs && baseRefQuery.trim().length >= 2 ? (
                        baseRefResults.length > 0 ? (
                          <ScrollArea className="mt-3 h-48 rounded-md border">
                            <div className="p-1">
                              {baseRefResults.map((ref) => (
                                <button
                                  key={ref}
                                  onClick={() => {
                                    setBaseRefQuery(ref)
                                    setBaseRefResults([])
                                    updateRepo(selectedRepo.id, {
                                      worktreeBaseRef: ref
                                    })
                                  }}
                                  className={`flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 ${
                                    selectedRepo.worktreeBaseRef === ref
                                      ? 'bg-accent text-accent-foreground'
                                      : 'text-foreground'
                                  }`}
                                >
                                  <span className="truncate">{ref}</span>
                                  {selectedRepo.worktreeBaseRef === ref ? (
                                    <span className="text-[10px] uppercase tracking-[0.18em]">
                                      Current
                                    </span>
                                  ) : null}
                                </button>
                              ))}
                            </div>
                          </ScrollArea>
                        ) : (
                          <p className="mt-3 text-xs text-muted-foreground">
                            No matching branches found.
                          </p>
                        )
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      New worktrees default to the repo primary branch unless you pin a different
                      base here.
                    </p>
                  </div>
                </section>

                <Separator />

                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">Hook Source</h2>
                    <p className="text-xs text-muted-foreground">
                      Auto prefers `orca.yaml` when present, then falls back to the UI script.
                      Override ignores YAML and only uses the UI script.
                    </p>
                  </div>

                  <div className="flex w-fit gap-1 rounded-xl border p-1">
                    {(['auto', 'override'] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => updateSelectedRepoHookSettings(selectedRepo, { mode })}
                        className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                          selectedRepo.hookSettings?.mode === mode
                            ? 'bg-accent font-medium text-accent-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {mode === 'auto' ? 'Use YAML First' : 'Override in UI'}
                      </button>
                    ))}
                  </div>

                  <div className="rounded-xl border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                    {selectedYamlHooks ? (
                      <div className="space-y-2">
                        <p className="font-medium text-foreground">
                          YAML hooks detected in `orca.yaml`
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {(['setup', 'archive'] as HookName[]).map((hookName) =>
                            selectedYamlHooks.scripts[hookName] ? (
                              <span
                                key={hookName}
                                className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300"
                              >
                                {hookName}
                              </span>
                            ) : null
                          )}
                        </div>
                      </div>
                    ) : (
                      <p>No YAML hooks detected for this repo.</p>
                    )}
                  </div>
                </section>

                <Separator />

                <section className="space-y-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">Lifecycle Hooks</h2>
                    <p className="text-xs text-muted-foreground">
                      Write scripts directly in the UI. Each repo stores its own setup and archive
                      hook script.
                    </p>
                  </div>

                  <div className="space-y-4">
                    {(['setup', 'archive'] as HookName[]).map((hookName) => (
                      <HookEditor
                        key={hookName}
                        hookName={hookName}
                        repo={selectedRepo}
                        yamlHooks={selectedYamlHooks}
                        onScriptChange={(script) =>
                          updateSelectedRepoHookSettings(selectedRepo, {
                            scripts: hookName === 'setup' ? { setup: script } : { archive: script }
                          })
                        }
                      />
                    ))}
                  </div>
                </section>
              </div>
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

function HookEditor({
  hookName,
  repo,
  yamlHooks,
  onScriptChange
}: {
  hookName: HookName
  repo: Repo
  yamlHooks: OrcaHooks | null
  onScriptChange: (script: string) => void
}): React.JSX.Element {
  const uiScript = repo.hookSettings?.scripts[hookName] ?? ''
  const yamlScript = yamlHooks?.scripts[hookName]
  const effectiveSource =
    repo.hookSettings?.mode === 'auto' && yamlScript ? 'yaml' : uiScript.trim() ? 'ui' : 'none'

  return (
    <div className="space-y-3 rounded-2xl border bg-background/80 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h5 className="text-sm font-semibold capitalize">{hookName}</h5>
          <p className="text-xs text-muted-foreground">
            {hookName === 'setup'
              ? 'Runs after a worktree is created.'
              : 'Runs before a worktree is archived.'}
          </p>
        </div>

        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${
            effectiveSource === 'yaml'
              ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : effectiveSource === 'ui'
                ? 'border border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                : 'border bg-muted text-muted-foreground'
          }`}
        >
          {effectiveSource === 'yaml'
            ? 'Honoring YAML'
            : effectiveSource === 'ui'
              ? 'Using UI'
              : 'Inactive'}
        </span>
      </div>

      {yamlScript && (
        <div className="space-y-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">
              YAML Script
            </Label>
            <span className="text-[10px] text-muted-foreground">Read-only from `orca.yaml`</span>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-3 font-mono text-[11px] leading-5 text-foreground">
            {yamlScript}
          </pre>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            UI Script
          </Label>
          <span className="text-[10px] text-muted-foreground">
            {repo.hookSettings?.mode === 'auto' && yamlScript
              ? 'Stored as fallback until you switch to override.'
              : 'Editable script stored with this repo.'}
          </span>
        </div>
        <textarea
          value={uiScript}
          onChange={(e) => onScriptChange(e.target.value)}
          placeholder={
            hookName === 'setup'
              ? 'pnpm install\npnpm generate'
              : 'echo "Cleaning up before archive"'
          }
          spellCheck={false}
          className="min-h-[12rem] w-full resize-y rounded-xl border bg-background px-3 py-3 font-mono text-[12px] leading-5 outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        />
      </div>
    </div>
  )
}

export default Settings
