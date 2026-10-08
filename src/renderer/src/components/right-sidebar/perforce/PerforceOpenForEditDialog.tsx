import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { answerOpenForEditPrompt } from '@/lib/perforce-open-for-edit-prompt'
import { useAppStore } from '@/store'

/** The `perforce-open-for-edit` modal: saving a read-only Perforce file first opens it for edit. */
export default function PerforceOpenForEditDialog() {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const path = typeof modalData.path === 'string' ? modalData.path : ''
  const decide = (open: boolean): void => {
    answerOpenForEditPrompt(open)
    closeModal()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && decide(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('perforce.ui.openForEditBeforeSaveTitle', 'Open for edit in Perforce?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'perforce.ui.saveNeedsOpenForEdit',
              '{{path}} is not opened for edit in Perforce. Open it for edit and save?',
              { path }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => decide(false)}>
            {translate('perforce.ui.cancel', 'Cancel')}
          </Button>
          <Button autoFocus onClick={() => decide(true)}>
            {translate('perforce.ui.openForEdit', 'Open for edit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
