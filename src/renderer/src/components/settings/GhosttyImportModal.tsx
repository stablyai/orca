import { FileUp } from 'lucide-react'
import type { GhosttyImportPreview } from '../../../../shared/global-settings-types'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { SETTING_LABELS } from './setting-labels'
import { translate } from '@/i18n/i18n'

type GhosttyImportModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  preview: GhosttyImportPreview | null
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
function formatPreviewEntry(preview: GhosttyImportPreview, key: string, value: unknown): string {
  const themeNames = preview.terminalThemes ?? {}
  if (key === 'terminalThemeDark' && themeNames.dark) {
    return themeNames.dark
  }
  if (key === 'terminalThemeLight' && themeNames.light) {
    return themeNames.light
  }
  if (key === 'terminalCustomThemes') {
    return [...new Set([themeNames.dark, themeNames.light].filter(Boolean))].join(', ')
  }
  return formatDiffValue(value)
}

export function GhosttyImportModal({
  open,
  onOpenChange,
  preview,
  loading,
  choosingFile = false,
  onApply,
  onChooseFile,
  applied = false,
  applyError = null
}: GhosttyImportModalProps): React.JSX.Element {
  const hasChanges = preview?.found === true && Object.keys(preview.diff).length > 0
  const configPaths =
    preview?.configPaths ?? (preview?.configPath !== undefined ? [preview.configPath] : [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.settings.GhosttyImportModal.d2f33670a9',
              'Import from Ghostty'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.settings.GhosttyImportModal.2763b0c045',
              'Review the settings that will be imported from your Ghostty config.'
            )}
          </DialogDescription>
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
                  : translate('auto.components.settings.GhosttyImportModal.273e7e81fe', 'Configs')}
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
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GhosttyImportModal.not_found_choose_file',
              'No Ghostty config found on this computer. Choose a config file to import one from another location.'
            )}
          </p>
        )}

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
