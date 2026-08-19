import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { translate } from '@/i18n/i18n'

type AppearanceUnsavedChangesDialogProps = {
  open: boolean
  saving: boolean
  saveFailed: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

export function AppearanceUnsavedChangesDialog({
  open,
  saving,
  saveFailed,
  onSave,
  onDiscard,
  onCancel
}: AppearanceUnsavedChangesDialogProps): React.JSX.Element {
  const [showSaving, setShowSaving] = useState(false)
  const saveButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!saving) {
      setShowSaving(false)
      return
    }
    const timer = window.setTimeout(() => setShowSaving(true), 750)
    return () => window.clearTimeout(timer)
  }, [saving])

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !saving && onCancel()}>
      <DialogContent
        showCloseButton={false}
        className="max-w-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          saveButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.AppearanceUnsavedChangesDialog.title',
              'Unsaved appearance changes'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.AppearanceUnsavedChangesDialog.description',
              'Save the appearance draft before leaving?'
            )}
          </DialogDescription>
        </DialogHeader>
        {saveFailed ? (
          <p className="text-sm text-destructive" role="alert">
            {translate(
              'auto.components.settings.AppearanceUnsavedChangesDialog.saveFailed',
              'Appearance settings could not be saved. The draft is still available.'
            )}
          </p>
        ) : null}
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
            {translate('auto.components.settings.AppearanceUnsavedChangesDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>
            {translate(
              'auto.components.settings.AppearanceUnsavedChangesDialog.discard',
              'Discard'
            )}
          </Button>
          <Button
            ref={saveButtonRef}
            type="button"
            size="sm"
            className="w-24"
            disabled={saving}
            onClick={onSave}
          >
            {showSaving ? <Loader2 className="size-4 animate-spin" /> : null}
            {showSaving
              ? translate(
                  'auto.components.settings.AppearanceUnsavedChangesDialog.saving',
                  'Saving…'
                )
              : translate('auto.components.settings.AppearanceUnsavedChangesDialog.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
