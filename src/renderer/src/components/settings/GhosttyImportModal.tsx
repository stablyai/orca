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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Import from Ghostty</DialogTitle>
          <DialogDescription className="text-xs">
            Review the settings that will be imported from your Ghostty config.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading preview…</p>
        ) : preview == null ? null : preview.found ? (
          <div className="space-y-3">
            {preview.configPath && !applied && (
              <p className="text-xs text-muted-foreground break-all">
                Config: {preview.configPath}
              </p>
            )}
            {applied ? (
              <div>
                <p className="text-xs font-medium text-green-600 mb-1">Import complete</p>
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
                <p className="text-xs font-medium mb-1">Settings to update</p>
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
                No new settings to import — your current settings already match.
              </p>
            )}

            {!applied && applyError && <p className="text-xs text-red-500">{applyError}</p>}

            {!applied && preview.unsupportedKeys.length > 0 && (
              <div>
                <p className="text-xs font-medium mb-1">Unsupported keys</p>
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
          <p className="text-xs text-muted-foreground">No Ghostty config found on this system.</p>
        )}

        <DialogFooter>
          {applied ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {hasChanges && <Button onClick={() => void onApply()}>Apply Changes</Button>}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
