import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Why its own id: this follows a send, not a Clear; neither outcome may take down the other's message.
const SENT_NOTES_STILL_LISTED_TOAST_ID = 'sent-notes-still-listed'

/** The agent has the notes, but the host kept them; Remove asks the host again. */
export function showSentNotesStillListedToast(remove: () => void): void {
  toast.error(
    translate(
      'components.notes.sendButton.sentNotesStillListed',
      "Notes sent, but they're still in the list."
    ),
    {
      id: SENT_NOTES_STILL_LISTED_TOAST_ID,
      action: {
        label: translate('components.notes.sendButton.removeSentNotes', 'Remove'),
        onClick: remove
      }
    }
  )
}

export function dismissSentNotesStillListedToast(): void {
  toast.dismiss(SENT_NOTES_STILL_LISTED_TOAST_ID)
}
