import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { OPERATION_RUN_CHANGED_ERROR } from '../../../../../../shared/git/status/git-status-types'

/**
 * An abort refused because the paused run changed is a safety stop, not a failure: say nothing
 * was aborted, in the user's language. Returns false for any other error.
 */
export function toastIfOperationRunChanged(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes(OPERATION_RUN_CHANGED_ERROR)) {
    return false
  }
  toast.warning(
    translate(
      'auto.components.right.sidebar.SourceControl.operationRunChangedTitle',
      'Nothing was aborted'
    ),
    {
      description: translate(
        'auto.components.right.sidebar.SourceControl.operationRunChangedDescription',
        'The operation changed after Abort was chosen. Check its current state and try again.'
      )
    }
  )
  return true
}
