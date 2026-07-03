import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

let hasShownTerminalClipboardCopyFailedToast = false

export function showTerminalClipboardCopyFailedToast(): void {
  if (hasShownTerminalClipboardCopyFailedToast) {
    return
  }
  hasShownTerminalClipboardCopyFailedToast = true

  toast.error(
    translate(
      'auto.components.terminal.pane.terminal.clipboard.copy.failure.toast.title',
      'Terminal copy failed'
    ),
    {
      description: translate(
        'auto.components.terminal.pane.terminal.clipboard.copy.failure.toast.description',
        'The system clipboard did not update. Your selection is still highlighted.'
      ),
      duration: 12_000
    }
  )
}
