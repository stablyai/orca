import { FileUp } from 'lucide-react'
import type {
  TerminalConfigImportFormat,
  TerminalConfigImportPreview
} from '../../../../../../shared/terminal/appearance/terminal-config-import-preview'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { SETTING_LABELS } from '../../search/setting-labels'
import { normalizeTerminalCustomThemes } from '../../../../../../shared/terminal-themes/terminal-custom-themes'
import { translate } from '@/i18n/i18n'

type TerminalConfigImportModalProps = {
  format: TerminalConfigImportFormat
  open: boolean
  onOpenChange: (open: boolean) => void
  preview: TerminalConfigImportPreview | null
  loading: boolean
  choosingFile?: boolean
  onApply: () => void | Promise<void>
  onChooseFile: () => void | Promise<void>
  applied?: boolean
  applyError?: string | null
}

function formatDiffValue(value: unknown): string {
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    return entries.length === 0
      ? translate('auto.components.settings.GhosttyImportModal.cleared', 'Cleared')
      : entries.map(([k, v]) => `${k}: ${String(v)}`).join(', ')
  }
  return String(value)
}

// Theme selections are opaque IDs, so show the theme names the import resolved instead.
function formatPreviewEntry(
  preview: TerminalConfigImportPreview,
  key: string,
  value: unknown
): string {
  const themeNames = preview.terminalThemes ?? {}
  if (key === 'terminalThemeDark' && themeNames.dark) {
    return themeNames.dark
  }
  if (key === 'terminalThemeLight' && themeNames.light) {
    return themeNames.light
  }
  if (key === 'terminalCustomThemes') {
    const names = new Set([themeNames.dark, themeNames.light])
    return normalizeTerminalCustomThemes(value)
      .filter((theme) => theme.source === 'ghostty' && names.has(theme.name))
      .map((theme) => theme.name)
      .join(', ')
  }
  return formatDiffValue(value)
}

// Static branches keep every string visible to localization extraction.
function importCopy(format: TerminalConfigImportFormat): {
  title: string
  description: string
  notFound: string
} {
  if (format === 'kitty') {
    return {
      title: translate(
        'auto.components.settings.TerminalConfigImportModal.kitty_title',
        'Import from Kitty'
      ),
      description: translate(
        'auto.components.settings.TerminalConfigImportModal.kitty_description',
        'Review the settings that will be imported from your kitty.conf and the files it includes.'
      ),
      notFound: translate(
        'auto.components.settings.TerminalConfigImportModal.kitty_not_found',
        'No kitty.conf found on this computer. Choose a config file to import one from another location.'
      )
    }
  }
  return {
    title: translate(
      'auto.components.settings.GhosttyImportModal.d2f33670a9',
      'Import from Ghostty'
    ),
    description: translate(
      'auto.components.settings.GhosttyImportModal.2763b0c045',
      'Review the settings that will be imported from your Ghostty config.'
    ),
    notFound: translate(
      'auto.components.settings.GhosttyImportModal.not_found_choose_file',
      'No Ghostty config found on this computer. Choose a config file to import one from another location.'
    )
  }
}

export function TerminalConfigImportModal({
  format,
  open,
  onOpenChange,
  preview,
  loading,
  choosingFile = false,
  onApply,
  onChooseFile,
  applied = false,
  applyError = null
}: TerminalConfigImportModalProps): React.JSX.Element {
  const copy = importCopy(format)
  const hasChanges = preview?.found === true && Object.keys(preview.diff).length > 0
  const configPaths =
    preview?.configPaths ?? (preview?.configPath !== undefined ? [preview.configPath] : [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-3rem)] max-w-sm flex-col sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        {!applied ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={loading || choosingFile}
              onClick={() => void onChooseFile()}
            >
              <FileUp className="size-4" />
              {translate(
                'auto.components.settings.GhosttyImportModal.choose_file',
                'Choose Config File'
              )}
            </Button>
          </div>
        ) : null}

        {/* Long previews (many unsupported keys) scroll here so the header and actions stay on screen. */}
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 scrollbar-sleek empty:hidden">
          {loading ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.GhosttyImportModal.023a52c1f7',
                'Loading preview…'
              )}
            </p>
          ) : preview == null ? null : preview.found ? (
            <div className="space-y-3">
              {configPaths.length > 0 && !applied && (
                <p className="text-xs text-muted-foreground break-all">
                  {configPaths.length === 1
                    ? translate('auto.components.settings.GhosttyImportModal.1f744a72f4', 'Config')
                    : translate(
                        'auto.components.settings.GhosttyImportModal.273e7e81fe',
                        'Configs'
                      )}
                  : {configPaths.join(', ')}
                </p>
              )}
              {applied ? (
                <div>
                  <p className="text-xs font-medium text-green-600 mb-1">
                    {translate(
                      'auto.components.settings.GhosttyImportModal.4466f4cdaa',
                      'Import complete'
                    )}
                  </p>
                  <ul className="text-xs space-y-1">
                    {Object.entries(preview.diff).map(([key, value]) => (
                      <li key={key} className="flex justify-between gap-2">
                        <span className="text-muted-foreground">{SETTING_LABELS[key] ?? key}</span>
                        <span className="font-mono">{formatPreviewEntry(preview, key, value)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : hasChanges ? (
                <div>
                  <p className="text-xs font-medium mb-1">
                    {translate(
                      'auto.components.settings.GhosttyImportModal.a4c5dec640',
                      'Settings to update'
                    )}
                  </p>
                  <ul className="text-xs space-y-1">
                    {Object.entries(preview.diff).map(([key, value]) => (
                      <li key={key} className="flex justify-between gap-2">
                        <span className="text-muted-foreground">{SETTING_LABELS[key] ?? key}</span>
                        <span className="font-mono">{formatPreviewEntry(preview, key, value)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.GhosttyImportModal.674b5ccd6b',
                    'No new settings to import — your current settings already match.'
                  )}
                </p>
              )}

              {!applied && applyError && <p className="text-xs text-red-500">{applyError}</p>}

              {!applied && preview.unsupportedKeys.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-1">
                    {translate(
                      'auto.components.settings.GhosttyImportModal.b58d4c9051',
                      'Unsupported keys'
                    )}
                  </p>
                  <ul className="text-xs space-y-1">
                    {preview.unsupportedKeys.map((key) => (
                      <li key={key} className="text-muted-foreground">
                        {key}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : preview.error ? (
            <p className="text-xs text-red-500">{preview.error}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{copy.notFound}</p>
          )}
        </div>

        <DialogFooter>
          {applied ? (
            <Button onClick={() => onOpenChange(false)}>
              {translate('auto.components.settings.GhosttyImportModal.b7ddae600c', 'Done')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {translate('auto.components.settings.GhosttyImportModal.f96688b6bc', 'Cancel')}
              </Button>
              {hasChanges && (
                <Button disabled={choosingFile} onClick={() => void onApply()}>
                  {translate(
                    'auto.components.settings.GhosttyImportModal.9d3e56ca36',
                    'Apply Changes'
                  )}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
