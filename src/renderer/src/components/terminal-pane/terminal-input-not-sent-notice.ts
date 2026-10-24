import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** Says out loud that input may have died with a restarted terminal endpoint; dropping it silently
 *  made the first command after a daemon death vanish without a trace. Worded as "may": an
 *  unacknowledged write can still have reached the old shell, and retyping blindly could repeat it. */
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
