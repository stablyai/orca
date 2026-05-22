/* eslint-disable max-lines -- Why: this pane is the single owner of all file-explorer theme settings UI; the alternative would scatter related controls across multiple files. */
import React, { useCallback, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'
import { useAppStore } from '../../store'
import {
  DEFAULT_FILE_EXPLORER_COLOR_THEME_DARK,
  DEFAULT_FILE_EXPLORER_COLOR_THEME_LIGHT,
  FILE_EXPLORER_COLOR_KEYS,
  type FileExplorerColorKey,
  type FileExplorerColorTheme,
  getFileExplorerColorTheme,
  getFileExplorerColorThemeNames
} from '@/lib/file-explorer-themes'
import { DEFAULT_ICON_THEME_ID, getIconThemes } from '@/lib/icon-themes'
import { FileExplorerPreview } from './FileExplorerPreview'

type FileExplorerPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const ICON_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Icon Theme',
    description: 'Choose which icon set the file explorer uses.',
    keywords: ['icon', 'icons', 'theme', 'material', 'lucide', 'file explorer']
  }
]

const COLOR_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Color Theme',
    description: 'Choose the color palette for the file explorer.',
    keywords: ['color', 'theme', 'palette', 'dark', 'light', 'file explorer']
  }
]

const OVERRIDES_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Color Overrides',
    description: 'Override individual color tokens used by the file explorer.',
    keywords: ['color', 'override', 'customize', 'file explorer']
  }
]

const PREVIEW_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Preview',
    description: 'Live preview of the active file explorer theme.',
    keywords: ['preview', 'file explorer']
  }
]

export const FILE_EXPLORER_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...ICON_ENTRIES,
  ...COLOR_ENTRIES,
  ...OVERRIDES_ENTRIES,
  ...PREVIEW_ENTRIES
]

const COLOR_KEY_LABELS: Record<FileExplorerColorKey, string> = {
  background: 'Background',
  hoverBackground: 'Hover background',
  selectedBackground: 'Selected background',
  selectedInactiveBackground: 'Selected (inactive) background',
  flashBackground: 'Flash background',
  flashRing: 'Flash ring',
  textColor: 'Text',
  selectedTextColor: 'Selected text',
  mutedTextColor: 'Muted text',
  gitIgnoredColor: 'Git-ignored text',
  fileIconColor: 'File icon',
  folderIconColor: 'Folder icon',
  gitModifiedColor: 'Git modified',
  gitAddedColor: 'Git added',
  gitDeletedColor: 'Git deleted',
  gitUntrackedColor: 'Git untracked',
  gitConflictColor: 'Git conflict',
  dropTargetBorderColor: 'Drop target border'
}

export function FileExplorerPane({
  settings,
  updateSettings
}: FileExplorerPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)

  const iconThemeId = settings.fileExplorerIconTheme ?? DEFAULT_ICON_THEME_ID
  const darkThemeId = settings.fileExplorerColorThemeDark ?? DEFAULT_FILE_EXPLORER_COLOR_THEME_DARK
  const lightThemeId =
    settings.fileExplorerColorThemeLight ?? DEFAULT_FILE_EXPLORER_COLOR_THEME_LIGHT
  const useSeparateLight = settings.fileExplorerUseSeparateLightTheme ?? true
  const overridesDark = settings.fileExplorerColorOverridesDark ?? null
  const overridesLight = settings.fileExplorerColorOverridesLight ?? null

  // Why: the preview should reflect what the user is editing. We default to
  // the dark theme (most users), but switching mode here is purely cosmetic —
  // saved settings are split by mode regardless.
  const [previewMode, setPreviewMode] = useState<'dark' | 'light'>('dark')

  const iconThemes = useMemo(() => getIconThemes(), [])
  const darkThemes = useMemo(() => getFileExplorerColorThemeNames('dark'), [])
  const lightThemes = useMemo(() => getFileExplorerColorThemeNames('light'), [])

  const previewColorTheme: FileExplorerColorTheme = useMemo(() => {
    const id = previewMode === 'dark' ? darkThemeId : useSeparateLight ? lightThemeId : darkThemeId
    return (
      getFileExplorerColorTheme(id) ??
      getFileExplorerColorTheme(
        previewMode === 'dark'
          ? DEFAULT_FILE_EXPLORER_COLOR_THEME_DARK
          : DEFAULT_FILE_EXPLORER_COLOR_THEME_LIGHT
      )!
    )
  }, [previewMode, darkThemeId, lightThemeId, useSeparateLight])

  const activeOverrides = previewMode === 'dark' ? overridesDark : overridesLight

  const setOverride = useCallback(
    (mode: 'dark' | 'light', key: FileExplorerColorKey, value: string) => {
      const current = mode === 'dark' ? overridesDark : overridesLight
      const next = { ...current, [key]: value }
      updateSettings(
        mode === 'dark'
          ? { fileExplorerColorOverridesDark: next }
          : { fileExplorerColorOverridesLight: next }
      )
    },
    [overridesDark, overridesLight, updateSettings]
  )

  const clearOverride = useCallback(
    (mode: 'dark' | 'light', key: FileExplorerColorKey) => {
      const current = mode === 'dark' ? overridesDark : overridesLight
      if (!current) {
        return
      }
      const { [key]: _removed, ...rest } = current
      const next = Object.keys(rest).length === 0 ? null : rest
      updateSettings(
        mode === 'dark'
          ? { fileExplorerColorOverridesDark: next }
          : { fileExplorerColorOverridesLight: next }
      )
    },
    [overridesDark, overridesLight, updateSettings]
  )

  const resetAllOverrides = useCallback(
    (mode: 'dark' | 'light') => {
      updateSettings(
        mode === 'dark'
          ? { fileExplorerColorOverridesDark: null }
          : { fileExplorerColorOverridesLight: null }
      )
    },
    [updateSettings]
  )

  const sections = [
    matchesSettingsSearch(searchQuery, ICON_ENTRIES) ? (
      <section key="icon-theme" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Icon Theme</h3>
          <p className="text-xs text-muted-foreground">
            Choose which icon set the file explorer uses to render files and folders.
          </p>
        </div>
        <SearchableSetting
          title="Icon Theme"
          description="Choose which icon set the file explorer uses."
          keywords={['icon', 'theme', 'material', 'lucide']}
        >
          <Select
            value={iconThemeId}
            onValueChange={(value) => updateSettings({ fileExplorerIconTheme: value })}
          >
            <SelectTrigger className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {iconThemes.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SearchableSetting>
      </section>
    ) : null,

    matchesSettingsSearch(searchQuery, COLOR_ENTRIES) ? (
      <section key="color-theme" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Color Theme</h3>
          <p className="text-xs text-muted-foreground">
            Pick a built-in color palette for the file explorer. Dark and light modes can be set
            independently.
          </p>
        </div>

        <SearchableSetting
          title="Dark mode theme"
          description="Theme applied while the app is in dark mode."
          keywords={['color', 'dark', 'theme']}
        >
          <Select
            value={darkThemeId}
            onValueChange={(value) => updateSettings({ fileExplorerColorThemeDark: value })}
          >
            <SelectTrigger className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {darkThemes.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SearchableSetting>

        <SearchableSetting
          title="Use separate light theme"
          description="When off, the dark theme is used in light mode too."
          keywords={['light', 'separate', 'mode']}
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={useSeparateLight}
              onChange={(e) =>
                updateSettings({ fileExplorerUseSeparateLightTheme: e.target.checked })
              }
              className="size-4"
            />
            <span className="text-xs text-muted-foreground">
              Use a separate theme when Orca is in light mode.
            </span>
          </label>
        </SearchableSetting>

        {useSeparateLight ? (
          <SearchableSetting
            title="Light mode theme"
            description="Theme applied while the app is in light mode."
            keywords={['color', 'light', 'theme']}
          >
            <Select
              value={lightThemeId}
              onValueChange={(value) => updateSettings({ fileExplorerColorThemeLight: value })}
            >
              <SelectTrigger className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {lightThemes.map((theme) => (
                  <SelectItem key={theme.id} value={theme.id}>
                    {theme.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SearchableSetting>
        ) : null}
      </section>
    ) : null,

    matchesSettingsSearch(searchQuery, PREVIEW_ENTRIES) ? (
      <section key="preview" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Preview</h3>
          <p className="text-xs text-muted-foreground">
            Live preview of the active file explorer theme. Use the toggle to compare dark and light
            modes.
          </p>
        </div>
        <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
          {(['dark', 'light'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setPreviewMode(option)}
              className={`rounded-sm px-3 py-1 text-xs capitalize transition-colors ${
                previewMode === option
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        <FileExplorerPreview
          iconThemeId={iconThemeId}
          colorTheme={previewColorTheme}
          overrides={activeOverrides}
        />
      </section>
    ) : null,

    matchesSettingsSearch(searchQuery, OVERRIDES_ENTRIES) ? (
      <section key="overrides" className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Color Overrides ({previewMode} mode)</h3>
            <p className="text-xs text-muted-foreground">
              Override individual color tokens. Empty fields fall through to the base theme.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!activeOverrides}
            onClick={() => resetAllOverrides(previewMode)}
          >
            <RotateCcw className="mr-1 size-3" />
            Reset {previewMode} overrides
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {FILE_EXPLORER_COLOR_KEYS.map((key) => {
            const overridden = activeOverrides?.[key]
            const baseValue = previewColorTheme[key]
            return (
              <div key={key} className="flex items-center gap-2">
                <Label className="w-44 text-xs text-muted-foreground">
                  {COLOR_KEY_LABELS[key]}
                </Label>
                <input
                  type="text"
                  value={overridden ?? ''}
                  placeholder={baseValue}
                  onChange={(e) =>
                    e.target.value
                      ? setOverride(previewMode, key, e.target.value)
                      : clearOverride(previewMode, key)
                  }
                  className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs font-mono"
                />
              </div>
            )
          })}
        </div>
      </section>
    ) : null
  ]

  const visible = sections.filter(Boolean)
  if (visible.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No file explorer settings match your search.</p>
    )
  }
  return <div className="space-y-8">{visible}</div>
}
