import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { useAppStore } from '@/store'

export type SourceControlEntryOperation = 'stage' | 'unstage' | 'discard'

const ENTRY_FAILURE_TOAST_ID = 'source-control-entry-mutation'

// Wrap nullable ownership to distinguish an empty slot from a null-owned one.
let entryFailureSlotOwner: { worktreeId: string | null } | null = null

/** Dismiss only the completing attempt's workspace slot so slow old retries cannot erase another workspace's failure. */
export function dismissSourceControlEntryFailureToast(worktreeId: string | null): void {
  if (!entryFailureSlotOwner || entryFailureSlotOwner.worktreeId !== worktreeId) {
    return
  }
  entryFailureSlotOwner = null
  toast.dismiss(ENTRY_FAILURE_TOAST_ID)
}

function entryFailureTitle(
  operation: SourceControlEntryOperation,
  filePath: string,
  deletesFile: boolean
): string {
  switch (operation) {
    case 'stage':
      return translate(
        'auto.components.right.sidebar.SourceControl.entryStageFailed',
        'Failed to stage “{{value0}}”',
        { value0: filePath }
      )
    case 'unstage':
      return translate(
        'auto.components.right.sidebar.SourceControl.entryUnstageFailed',
        'Failed to unstage “{{value0}}”',
        { value0: filePath }
      )
    case 'discard':
      return deletesFile
        ? translate(
            'auto.components.right.sidebar.SourceControl.entryDeleteFailed',
            'Failed to delete “{{value0}}”',
            { value0: filePath }
          )
        : translate(
            'auto.components.right.sidebar.SourceControl.entryDiscardFailed',
            'Failed to discard “{{value0}}”',
            { value0: filePath }
          )
  }
}

/** Report row failures after navigation with their workspace name and no stale actions; bulk callers aggregate separately. */
export function showSourceControlEntryFailureToast({
  operation,
  filePath,
  deletesFile = false,
  error,
  worktreeId,
  worktreeName,
  onRetry
}: {
  operation: SourceControlEntryOperation
  filePath: string
  /** True when this discard deletes the file rather than restoring it — see `discard-confirmation`. */
  deletesFile?: boolean
  error: unknown
  /** The worktree the failed attempt ran against. */
  worktreeId: string | null
  /** Shown only when the toast no longer belongs to the active worktree. */
  worktreeName: string | null
  onRetry?: () => void
}): void {
  const isActiveWorktree = useAppStore.getState().activeWorktreeId === worktreeId
  const title = entryFailureTitle(operation, filePath, deletesFile)
  const offerRetry = Boolean(onRetry) && isActiveWorktree
  entryFailureSlotOwner = { worktreeId }
  toast.error(
    isActiveWorktree || !worktreeName
      ? title
      : translate(
          'auto.components.right.sidebar.SourceControl.entryFailedInWorkspace',
          '{{value0}} in {{value1}}',
          { value0: title, value1: worktreeName }
        ),
    {
      id: ENTRY_FAILURE_TOAST_ID,
      description: readIpcErrorMessage(error),
      // Allow time to read the path and reach Retry before Sonner dismisses the toast.
      duration: offerRetry ? 10000 : undefined,
      action:
        offerRetry && onRetry
          ? {
              label: translate('auto.components.right.sidebar.SourceControl.286dbda4d6', 'Retry'),
              onClick: (event) => {
                // Own dismissal instead of Sonner's delayed ID removal, which could erase a fast retry failure in the same slot.
                event.preventDefault()
                if (useAppStore.getState().activeWorktreeId !== worktreeId) {
                  dismissSourceControlEntryFailureToast(worktreeId)
                  return
                }
                onRetry()
              }
            }
          : undefined
    }
  )
}
