import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { branchAutoRenameFailureReason } from '../../../../../../shared/worktree/branch-auto-rename-failure-reason'
import { autoNameFailureReasonText } from './auto-name-failure-reason-copy'
import { branchAutoRenameReasonText } from './branch-auto-rename-reason-copy'
import { canDismissAutoName, dismissAutoName } from './branch-auto-rename-actions'
import { useBranchAutoRenameRetry } from './use-branch-auto-rename-retry'

export type AutoNameFailure = {
  retrying: boolean
  canRetry: boolean
  canDismiss: boolean
  dismissing: boolean
  reason: string
  tryAgain: () => void
  dismiss: () => void
}

const noop = (): void => {}

/** A row's failed auto-name, shared by its row mark and its hover card section; null when there's none. */
export function useAutoNameFailure({
  worktreeId,
  executionHostId,
  error
}: {
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
  /** The persisted error, in any build's wording. */
  error: string | undefined
}): AutoNameFailure | null {
  const t = useTranslate()
  const hasError = Boolean(error)
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState(false)
  const [canDismiss, setCanDismiss] = useState(false)
  // Follows the row's lifetime, not the hover card's, so a retry keeps its spinner after the card closes.
  const retry = useBranchAutoRenameRetry({
    open: hasError,
    worktreeId,
    executionHostId,
    onRenamed: noop,
    onAttemptFinished: noop
  })
  useEffect(() => {
    if (!hasError) {
      return
    }
    let live = true
    void canDismissAutoName({ worktreeId, executionHostId }).then((value) => {
      if (live) {
        setCanDismiss(value)
      }
    })
    return () => {
      live = false
    }
  }, [hasError, worktreeId, executionHostId])

  const retrying = retry.running
  const dismiss = useCallback((): void => {
    if (dismissing || retrying || !error) {
      return
    }
    setDismissing(true)
    void dismissAutoName({ worktreeId, executionHostId })
      .then((result) => {
        if (result.dismissed) {
          setDismissedError(error)
        }
      })
      .catch(() => {})
      .finally(() => setDismissing(false))
  }, [dismissing, retrying, error, worktreeId, executionHostId])

  if (!error || dismissedError === error) {
    return null
  }
  // A finished retry that didn't fail (e.g. deferred) says so; otherwise the stored error does.
  const reason =
    branchAutoRenameReasonText(retry.lastOutcome, t) ??
    autoNameFailureReasonText(branchAutoRenameFailureReason(error), t)
  return {
    retrying,
    canRetry: retry.availability === 'available',
    canDismiss,
    dismissing,
    reason,
    tryAgain: retry.tryAgain,
    dismiss
  }
}
