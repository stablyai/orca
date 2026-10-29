import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** Disclose input lost during endpoint replacement; say may because unacknowledged writes can reach the old shell and retyping could duplicate them. */
export function notifyTerminalInputNotSent(tabId: string): void {
  toast.info(
    translate(
      'terminal.restartedInputNotSent',
      'The terminal restarted while you were typing, so some input may not have reached it. Check the new shell before typing it again.'
    ),
    // Why an id: every pane of a tab can report the same loss.
    { id: `terminal-input-not-sent:${tabId}` }
  )
}
