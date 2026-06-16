import { FileUp, FolderOpen, Loader2 } from 'lucide-react'
import type { WarpThemeImportPreviewTheme } from '../../../../shared/terminal-custom-themes'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { ScrollArea } from '../ui/scroll-area'
import { SettingsBadge } from './SettingsFormControls'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type WarpThemeImportModalProps = Pick<
  UseWarpThemeImportReturn,
  | 'open'
  | 'mode'
  | 'preview'
  | 'loading'
  | 'desktopOnly'
  | 'applyError'
  | 'selectedThemeIds'
  | 'handlePreviewSource'
  | 'handleToggleTheme'
  | 'handleToggleAll'
  | 'handleApply'
  | 'handleOpenChange'
>

function ThemeSwatches({ theme }: { theme: WarpThemeImportPreviewTheme }): React.JSX.Element {
  const colors = [
    theme.terminal.black,
    theme.terminal.red,
    theme.terminal.green,
    theme.terminal.yellow,
    theme.terminal.blue,
    theme.terminal.magenta,
    theme.terminal.cyan,
    theme.terminal.white
  ]
  return (
    <span className="flex shrink-0 overflow-hidden rounded-sm border border-border/60">
      {colors.map((color, index) => (
        <span
          key={index}
          className="h-3 w-2.5"
          style={{ backgroundColor: color ?? 'transparent' }}
        />
      ))}
    </span>
  )
}

export function WarpThemeImportModal({
  open,
  mode,
  preview,
  loading,
  desktopOnly,
  applyError,
  selectedThemeIds,
  handlePreviewSource,
  handleToggleTheme,
  handleToggleAll,
  handleApply,
  handleOpenChange
}: WarpThemeImportModalProps): React.JSX.Element {
  const themes = preview?.themes ?? []
  const allSelected = themes.length > 0 && themes.every((theme) => selectedThemeIds.has(theme.id))
  const selectedCount = selectedThemeIds.size
  const skippedCount = preview?.skippedFiles.length ?? 0

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {mode === 'yaml'
              ? translate(
                  'auto.components.settings.WarpThemeImportModal.yaml_title',
                  'Import theme YAML'
                )
              : translate(
                  'auto.components.settings.WarpThemeImportModal.title',
                  'Import themes from Warp'
                )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {mode === 'yaml'
              ? translate(
                  'auto.components.settings.WarpThemeImportModal.yaml_description',
                  'Import theme YAML files (Warp format) as Orca terminal themes.'
                )
              : translate(
                  'auto.components.settings.WarpThemeImportModal.description',
                  'Import Warp themes as Orca terminal themes.'
                )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!desktopOnly ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={loading}
                onClick={() => void handlePreviewSource({ kind: 'chooseFile' })}
              >
                <FileUp className="size-4" />
                {translate(
                  'auto.components.settings.WarpThemeImportModal.choose_file',
                  'Choose File'
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={loading}
                onClick={() => void handlePreviewSource({ kind: 'chooseFolder' })}
              >
                <FolderOpen className="size-4" />
                {translate(
                  'auto.components.settings.WarpThemeImportModal.choose_folder',
                  'Choose Folder'
                )}
              </Button>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {translate(
                'auto.components.settings.WarpThemeImportModal.loading',
                'Loading Warp themes...'
              )}
            </div>
          ) : preview == null ? null : preview.found ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {preview.themes.length === 1
                    ? translate(
                        'auto.components.settings.WarpThemeImportModal.found_theme_one',
                        'Found 1 theme'
                      )
                    : translate(
                        'auto.components.settings.WarpThemeImportModal.found_theme_other',
                        'Found {{value0}} themes',
                        { value0: preview.themes.length }
                      )}
                  {preview.sourceLabel
                    ? translate(
                        'auto.components.settings.WarpThemeImportModal.found_in_source',
                        ' in {{value0}}',
                        { value0: preview.sourceLabel }
                      )
                    : ''}
                </span>
                <button
                  type="button"
                  className="text-xs font-medium text-foreground hover:underline"
                  onClick={() => handleToggleAll(!allSelected)}
                >
                  {allSelected
                    ? translate(
                        'auto.components.settings.WarpThemeImportModal.clear_all',
                        'Clear all'
                      )
                    : translate(
                        'auto.components.settings.WarpThemeImportModal.select_all',
                        'Select all'
                      )}
                </button>
              </div>

              <div className="rounded-lg border border-border/50">
                <ScrollArea className="h-72">
                  <div className="space-y-1 p-2">
                    {themes.map((theme) => {
                      const selected = selectedThemeIds.has(theme.id)
                      return (
                        <button
                          type="button"
                          key={theme.id}
                          aria-pressed={selected}
                          onClick={() => handleToggleTheme(theme.id)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors',
                            selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              'flex size-4 shrink-0 items-center justify-center rounded-sm border text-[10px] leading-none',
                              selected
                                ? 'border-accent-foreground bg-accent-foreground text-accent'
                                : 'border-border bg-background'
                            )}
                          >
                            {selected ? '✓' : null}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium">{theme.name}</span>
                              {theme.mode !== 'unknown' ? (
                                <SettingsBadge tone="muted">{theme.mode}</SettingsBadge>
                              ) : null}
                            </div>
                            {theme.unsupportedFeatures?.length ? (
                              <p className="truncate text-xs text-muted-foreground">
                                {theme.unsupportedFeatures.join(', ')}
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                {translate(
                                  'auto.components.settings.WarpThemeImportModal.colors_only',
                                  'Colors only'
                                )}
                              </p>
                            )}
                          </div>
                          <ThemeSwatches theme={theme} />
                        </button>
                      )
                    })}
                  </div>
                </ScrollArea>
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                {preview.error ??
                  (mode === 'yaml'
                    ? translate(
                        'auto.components.settings.WarpThemeImportModal.yaml_no_themes_found',
                        'No themes found in the selected files.'
                      )
                    : translate(
                        'auto.components.settings.WarpThemeImportModal.no_themes_found',
                        'No custom Warp themes found.'
                      ))}
              </p>
              {!preview.error && mode !== 'yaml' ? (
                <p>
                  {translate(
                    'auto.components.settings.WarpThemeImportModal.builtin_themes_hint',
                    "Warp's preloaded themes are part of the Warp app and can't be read from disk. Orca already includes most of them, like Dracula, Gruvbox, Solarized, and Tokyo Night."
                  )}
                </p>
              ) : null}
              {!preview.error && mode !== 'yaml' ? (
                <p>
                  {translate(
                    'auto.components.settings.WarpThemeImportModal.custom_theme_yaml_hint',
                    "Custom and community themes need to exist as YAML files in a Warp themes folder before auto-import can find them. If you cloned Warp's public themes repo, use Choose Folder to import that checkout."
                  )}
                </p>
              ) : null}
              {!desktopOnly ? (
                <p>
                  {translate(
                    'auto.components.settings.WarpThemeImportModal.choose_manually',
                    'Choose a theme YAML file or folder to import manually.'
                  )}
                </p>
              ) : null}
            </div>
          )}

          {!loading && preview && skippedCount > 0 ? (
            <div className="rounded-lg border border-border/50 p-3">
              <p className="mb-2 text-xs font-medium">
                {translate(
                  'auto.components.settings.WarpThemeImportModal.skipped_files',
                  'Skipped files'
                )}
              </p>
              <ul className="scrollbar-sleek max-h-24 space-y-1 overflow-auto text-xs text-muted-foreground">
                {preview.skippedFiles.slice(0, 8).map((file) => (
                  <li key={`${file.label}:${file.reason}`} className="flex gap-2">
                    <span className="shrink-0 font-medium text-foreground/80">{file.label}</span>
                    <span>{file.reason}</span>
                  </li>
                ))}
                {preview.skippedFiles.length > 8 ? (
                  <li>
                    {translate(
                      'auto.components.settings.WarpThemeImportModal.more_skipped_files',
                      '{{value0}} more skipped files.',
                      { value0: preview.skippedFiles.length - 8 }
                    )}
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {applyError ? <p className="text-xs text-destructive">{applyError}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {translate('auto.components.settings.WarpThemeImportModal.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={!preview?.found || selectedCount === 0 || loading}
            onClick={() => void handleApply()}
          >
            {selectedCount === 1
              ? translate(
                  'auto.components.settings.WarpThemeImportModal.import_theme_one',
                  'Import 1 Theme'
                )
              : selectedCount > 0
                ? translate(
                    'auto.components.settings.WarpThemeImportModal.import_theme_other',
                    'Import {{value0}} Themes',
                    { value0: selectedCount }
                  )
                : translate(
                    'auto.components.settings.WarpThemeImportModal.import_themes',
                    'Import Themes'
                  )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
