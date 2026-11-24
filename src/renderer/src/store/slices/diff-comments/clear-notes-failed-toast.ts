// @protected-copy: the Clear notes failure belongs to a destructive confirmation; keep its wording.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Why one id: repeat failures replace each other, and a later successful clear can take it down.
const CLEAR_NOTES_FAILED_TOAST_ID = 'clear-notes-failed'

export function showClearNotesFailedToast(): void {
  toast.error(
    translate('auto.components.right.sidebar.SourceControl.eae7a1da5f', 'Failed to clear notes.'),
    { id: CLEAR_NOTES_FAILED_TOAST_ID }
  )
}

export function dismissClearNotesFailedToast(): void {
  toast.dismiss(CLEAR_NOTES_FAILED_TOAST_ID)
}
