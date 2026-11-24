// @protected-copy: the Clear notes failure belongs to a destructive confirmation; keep its wording.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Why one id: repeat failures replace each other, and a later successful clear can take it down.
const CLEAR_NOTES_FAILED_TOAST_ID = 'clear-notes-failed'

/** With `retry`, the toast offers it; sent notes that could not be removed use this. */
export function showClearNotesFailedToast(retry?: () => void): void {
  toast.error(
    translate('auto.components.right.sidebar.SourceControl.eae7a1da5f', 'Failed to clear notes.'),
    {
      id: CLEAR_NOTES_FAILED_TOAST_ID,
      ...(retry
        ? {
            action: {
              label: translate('components.notes.sendButton.retryClear', 'Retry'),
              onClick: retry
            }
          }
        : {})
    }
  )
}

export function dismissClearNotesFailedToast(): void {
  toast.dismiss(CLEAR_NOTES_FAILED_TOAST_ID)
}
