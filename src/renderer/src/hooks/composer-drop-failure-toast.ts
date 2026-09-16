import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { compactIpcErrorMessage } from '@/lib/ipc-error'
import type { ComposerDropFailure } from './composer-drop-result'
import type { ImportSkipReason } from '../../../shared/filesystem-import-result-types'

// Own slot, not Source Control's: a drop failure must not erase an unread stage/discard failure.
const DROP_FAILURE_TOAST_ID = 'composer-drop-failure'

const SKIP_REASON_COPY: Record<ImportSkipReason, { key: string; fallback: string }> = {
  missing: {
    key: 'auto.hooks.useComposerState.attachSkipMissing',
    fallback: 'No longer at its original path.'
  },
  symlink: {
    key: 'auto.hooks.useComposerState.attachSkipSymlink',
    fallback: 'Symbolic links cannot be attached.'
  },
  'permission-denied': {
    key: 'auto.hooks.useComposerState.attachSkipPermissionDenied',
    fallback: 'Permission denied.'
  },
  unsupported: {
    key: 'auto.hooks.useComposerState.attachSkipUnsupported',
    fallback: 'Unsupported file type.'
  }
}

function failureDescription(failure: ComposerDropFailure): string | undefined {
  if (failure.status === 'failed') {
    return failure.reason ? compactIpcErrorMessage(failure.reason) : undefined
  }
  const copy = SKIP_REASON_COPY[failure.reason]
  return copy ? translate(copy.key, copy.fallback) : undefined
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
