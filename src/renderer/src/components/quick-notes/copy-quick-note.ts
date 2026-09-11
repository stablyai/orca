import { toast } from 'sonner'
import type { QuickNote } from '../../../../shared/quick-note-types'
import { translate } from '@/i18n/i18n'

/** Copy a quick note's body to the system clipboard, with toast feedback. */
export async function copyQuickNoteToClipboard(note: QuickNote): Promise<boolean> {
  try {
    await window.api.ui.writeClipboardText(note.body)
    toast.success(
      translate('auto.components.quick.notes.copyQuickNote.copied', '"{{value0}}" copied', {
        value0: note.label
      })
    )
    return true
  } catch {
    toast.error(
      translate('auto.components.quick.notes.copyQuickNote.failed', 'Failed to copy note')
    )
    return false
  }
}
