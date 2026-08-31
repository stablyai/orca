import { showDeleteWorktreeErrorToast } from './show-delete-worktree-error-toast'

type ForceDeleteRetryResult = { ok: true } | { ok: false; error: string }

/**
 * Settle an explicit "Force Delete" retry and report a failure through the shared copy funnel.
 *
 * Why (STA-4895): three surfaces run this same retry — the failure toast, the delete dialog's
 * button, and the Space Manager — and two of them rendered `result.error` straight into a toast.
 * That put the main process's English wire anchors in front of the user on exactly the failures
 * they were written to explain. Settling here is what makes the funnel a route, not a habit.
 */
export function settleForceDeleteRetry(
  retry: Promise<ForceDeleteRetryResult>,
  options: {
    worktreeName: string
    onDeleted: () => void
    onViewChanges?: () => void
  }
): Promise<void> {
  const showFailure = (error: unknown): void => {
    showDeleteWorktreeErrorToast({
      error,
      kind: 'force-delete',
      worktreeName: options.worktreeName,
      ...(options.onViewChanges ? { onViewChanges: options.onViewChanges } : {})
    })
  }
  return retry
    .then((result) => {
      if (!result.ok) {
        showFailure(result.error)
        return
      }
      options.onDeleted()
    })
    .catch(showFailure)
}
