import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { compactIpcErrorMessage } from '@/lib/ipc-error'
import type { ComposerDropFailure } from './composer-drop-result'
import { describeDropSkipReason } from '@/lib/drop-skip-reason-copy'

// Own slot, not Source Control's: a drop failure must not erase an unread stage/discard failure.
const DROP_FAILURE_TOAST_ID = 'composer-drop-failure'

function failureDescription(failure: ComposerDropFailure): string | undefined {
  if (failure.status === 'failed') {
    return failure.reason ? compactIpcErrorMessage(failure.reason) : undefined
  }
  return describeDropSkipReason(failure.reason)
}

export function showComposerDropFailureToast({
  failureCount,
  total,
  commonFailure
}: {
  failureCount: number
  total: number
  commonFailure?: ComposerDropFailure
}): void {
  toast.error(
    translate(
      'auto.hooks.useComposerState.dropPartiallyAttached',
      '{{failureCount}} of {{count}} items could not be attached.',
      { failureCount, count: total }
    ),
    {
      id: DROP_FAILURE_TOAST_ID,
      description: commonFailure ? failureDescription(commonFailure) : undefined
    }
  )
}
