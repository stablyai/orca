import type { GhosttyImportPreview } from '../../../../shared/types'
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
  onApply: () => void | Promise<void>
  applied?: boolean
  applyError?: string | null
}

function formatDiffValue(value: unknown): string {
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ')
  }
  return String(value)
}

export function GhosttyImportModal({
  open,
  onOpenChange,
  preview,
  loading,
  onApply,
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
                      <span className="font-mono">{formatDiffValue(value)}</span>
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
                      <span className="font-mono">{formatDiffValue(value)}</span>
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
              'auto.components.settings.GhosttyImportModal.e4bda7ce6f',
              'No Ghostty config found on this system.'
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
                <Button onClick={() => void onApply()}>
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
