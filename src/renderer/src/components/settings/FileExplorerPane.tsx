import React, { useEffect, useMemo, useState } from 'react'
import { Download, Loader2, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'
import { useAppStore } from '../../store'
import {
  DEFAULT_ICON_THEME_ID,
  ICON_THEME_CATALOG,
  getIconThemes,
  registerUserIconTheme,
  subscribeUserIconThemes,
  unregisterUserIconTheme
} from '@/lib/icon-themes'
import { FileExplorerPreview } from './FileExplorerPreview'
import { IconThemeMarketplaceDialog } from './IconThemeMarketplaceDialog'

const ICON_SIZE_MIN = 12
const ICON_SIZE_MAX = 32
const ICON_SIZE_DEFAULT = 16

type FileExplorerPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const ICON_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Icon Theme',
    description: 'Choose which icon set the file explorer uses.',
    keywords: ['icon', 'icons', 'theme', 'material', 'lucide', 'file explorer']
  },
  {
    title: 'Size',
    description: 'Size of icons and text in the file explorer.',
    keywords: ['icon', 'size', 'font', 'text', 'file explorer', 'px']
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
  ...PREVIEW_ENTRIES
]

export function FileExplorerPane({
  settings,
  updateSettings
}: FileExplorerPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)

  const iconThemeId = settings.fileExplorerIconTheme ?? DEFAULT_ICON_THEME_ID
  const iconSize = settings.fileExplorerIconSize ?? ICON_SIZE_DEFAULT

  // Why: getIconThemes includes user-imported themes, which mutate at runtime
  // when the user clicks Import. Subscribe so the dropdown re-renders.
  const [userThemeVersion, setUserThemeVersion] = useState(0)
  useEffect(() => subscribeUserIconThemes(() => setUserThemeVersion((v) => v + 1)), [])
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- version counter triggers re-eval
  const iconThemes = useMemo(() => getIconThemes(), [userThemeVersion])

  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  // Why: the marketplace dialog needs to know which themes are already
  // installed so it can render "Installed" instead of an Install button.
  // We derive ids from the current iconThemes list — the marketplace builds
  // the same `${publisher}-${name}` id when it persists, so the set keys match.
  const installedIds = useMemo(() => new Set(iconThemes.map((t) => t.id)), [iconThemes])

  const isUserTheme = !(iconThemeId in ICON_THEME_CATALOG)

  const handleImport = async (): Promise<void> => {
    setImportError(null)
    setImporting(true)
    try {
      const result = await window.api.iconThemes.pickAndImport()
      if (!result) {
        return
      }
      const name = (result.json?.name as string | undefined) ?? result.sourceFolderName
      const registered = registerUserIconTheme({
        id: result.id,
        name,
        shape: result.json
      })
      if (!registered) {
        await window.api.iconThemes.remove(result.id)
        setImportError('Theme could not be parsed — check the JSON shape.')
        return
      }
      updateSettings({ fileExplorerIconTheme: result.id })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  const handleRemove = async (): Promise<void> => {
    if (!isUserTheme) {
      return
    }
    try {
      await window.api.iconThemes.remove(iconThemeId)
      unregisterUserIconTheme(iconThemeId)
      updateSettings({ fileExplorerIconTheme: DEFAULT_ICON_THEME_ID })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    }
  }

  const sections = [
    matchesSettingsSearch(searchQuery, ICON_ENTRIES) ? (
      <section key="icon-theme" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Icons</h3>
          <p className="text-xs text-muted-foreground">
            Choose which icon set the file explorer uses and how big icons render.
          </p>
        </div>
        <SearchableSetting
          title="Icon Theme"
          description="Choose which icon set the file explorer uses."
          keywords={['icon', 'theme', 'material', 'lucide', 'import', 'vscode']}
          className="space-y-2"
        >
          <Label>Icon Theme</Label>
          <div className="flex items-center gap-2">
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
            <IconThemeMarketplaceDialog
              installedIds={installedIds}
              onInstalled={(id) => updateSettings({ fileExplorerIconTheme: id })}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleImport}
              disabled={importing}
              title="Import a VS Code icon theme folder (icon-theme.json + /icons SVGs)."
            >
              {importing ? (
                <Loader2 className="mr-1 size-3 animate-spin" />
              ) : (
                <Download className="mr-1 size-3" />
              )}
              Import folder…
            </Button>
            {isUserTheme ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleRemove()}
                title="Remove the selected user-imported icon theme."
              >
                <Trash2 className="mr-1 size-3" />
                Remove
              </Button>
            ) : null}
          </div>
          {importError ? (
            <p className="text-xs text-destructive">{importError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Browse the Open VSX marketplace or import a local VS Code icon-theme folder. Either
              way, the JSON and SVGs are saved on this machine and persist across updates.
            </p>
          )}
        </SearchableSetting>

        <SearchableSetting
          title="Size"
          description="Size of icons and text in the file explorer."
          keywords={['icon', 'size', 'font', 'text', 'px']}
          className="space-y-2"
        >
          <Label>Size</Label>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() =>
                updateSettings({
                  fileExplorerIconSize: Math.max(ICON_SIZE_MIN, iconSize - 1)
                })
              }
              disabled={iconSize <= ICON_SIZE_MIN}
            >
              <Minus className="size-3" />
            </Button>
            <span className="w-12 text-center text-sm tabular-nums text-foreground">
              {iconSize}px
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() =>
                updateSettings({
                  fileExplorerIconSize: Math.min(ICON_SIZE_MAX, iconSize + 1)
                })
              }
              disabled={iconSize >= ICON_SIZE_MAX}
            >
              <Plus className="size-3" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateSettings({ fileExplorerIconSize: ICON_SIZE_DEFAULT })}
              disabled={iconSize === ICON_SIZE_DEFAULT}
              className="ml-1 gap-1.5"
            >
              <RotateCcw className="size-3" />
              Default
            </Button>
          </div>
        </SearchableSetting>
      </section>
    ) : null,

    matchesSettingsSearch(searchQuery, PREVIEW_ENTRIES) ? (
      <section key="preview" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Preview</h3>
          <p className="text-xs text-muted-foreground">
            Live preview of the active file explorer icon theme.
          </p>
        </div>
        <FileExplorerPreview iconThemeId={iconThemeId} iconSize={iconSize} />
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
