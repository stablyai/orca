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

/** One failure on one workspace: dismiss state never outlives it, even when the same error returns. */
type FailureState = {
  failure: string | null
  /** Distinct per occurrence, so a reply for an earlier, identical error can't land on this one. */
  occurrence: number
  dismissed: boolean
  dismissing: boolean
  canDismiss: boolean
}

const noop = (): void => {}
let occurrences = 0

function freshState(failure: string | null): FailureState {
  return {
    failure,
    occurrence: ++occurrences,
    dismissed: false,
    dismissing: false,
    canDismiss: false
  }
}

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
  const failure = error ? JSON.stringify([executionHostId ?? null, worktreeId, error]) : null
  const [state, setState] = useState(() => freshState(failure))
  // A cleared error, another workspace or a new error starts over; late replies for the old one are dropped.
  const current = state.failure === failure ? state : freshState(failure)
  if (current !== state) {
    setState(current)
  }
  const update = useCallback(
    (owner: number, patch: Partial<FailureState>) =>
      setState((prev) => (prev.occurrence === owner ? { ...prev, ...patch } : prev)),
    []
  )
  // Follows the row's lifetime, not the hover card's, so a retry keeps its spinner after the card closes.
  const retry = useBranchAutoRenameRetry({
    open: failure !== null,
    worktreeId,
    executionHostId,
    onRenamed: noop,
    onAttemptFinished: noop
  })
  const { occurrence } = current
  useEffect(() => {
    if (failure === null) {
      return
    }
    void canDismissAutoName({ worktreeId, executionHostId }).then((canDismiss) =>
      update(occurrence, { canDismiss })
    )
  }, [failure, occurrence, update, worktreeId, executionHostId])

  const retrying = retry.running
  const { dismissed, dismissing } = current
  const dismiss = useCallback((): void => {
    if (failure === null || dismissing || retrying) {
      return
    }
    update(occurrence, { dismissing: true })
    void dismissAutoName({ worktreeId, executionHostId })
      .then((result) => update(occurrence, { dismissed: result.dismissed, dismissing: false }))
      .catch(() => update(occurrence, { dismissing: false }))
  }, [failure, occurrence, dismissing, retrying, update, worktreeId, executionHostId])

  if (!error || dismissed) {
    return null
  }
  // A finished retry that didn't fail (e.g. deferred) says so; otherwise the stored error does.
  const reason =
    branchAutoRenameReasonText(retry.lastOutcome, t) ??
    autoNameFailureReasonText(branchAutoRenameFailureReason(error), t)
  return {
    retrying,
    canRetry: retry.availability === 'available',
    canDismiss: current.canDismiss,
    dismissing,
    reason,
    tryAgain: retry.tryAgain,
    dismiss
  }
}
