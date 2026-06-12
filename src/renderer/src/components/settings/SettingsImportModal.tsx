import { Loader2 } from 'lucide-react'
import type { SettingsImportPreview } from '../../../../shared/settings-portability'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { PortableSettingsChangeSummary } from './PortableSettingsChangeSummary'
import { translate } from '@/i18n/i18n'

type SettingsImportModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  preview: SettingsImportPreview | null
  applying: boolean
  applyError: string | null
  onApply: () => void | Promise<void>
}

export function SettingsImportModal({
  open,
  onOpenChange,
  preview,
  applying,
  applyError,
  onApply
}: SettingsImportModalProps): React.JSX.Element {
  const hasChanges =
    (preview?.changedSettingKeys.length ?? 0) > 0 || preview?.changedKeybindings === true

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.settings.SettingsImportModal.3772e1968c',
              'Import Settings'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.settings.SettingsImportModal.ce0d60225c',
              'Review what will change before applying.'
            )}
          </DialogDescription>
        </DialogHeader>

        {preview == null ? null : (
          <div className="space-y-3">
            <PortableSettingsChangeSummary preview={preview} />
            {applyError && <p className="text-xs text-destructive">{applyError}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.settings.SettingsImportModal.b0ba6b1dbb', 'Cancel')}
          </Button>
          {hasChanges && (
            <Button onClick={() => void onApply()} disabled={applying} className="gap-1.5">
              {applying && <Loader2 className="size-3.5 animate-spin" />}
              {translate('auto.components.settings.SettingsImportModal.5896752bad', 'Import')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
