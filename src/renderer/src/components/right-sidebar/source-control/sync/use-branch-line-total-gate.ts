import { useEffect } from 'react'
import { setBranchLineTotalMergeBase } from '../../branch-line-total-request-gate'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'

/**
 * Publishes the merge base the visible branch view wants a line total for, and withdraws it on
 * unmount or worktree switch.
 */
export function useSourceControlBranchLineTotalGate({
  activeWorktreeId,
  branchSummary,
  isBranchVisible,
  isFolder
}: {
  activeWorktreeId: string | null
  branchSummary: SourceControlWorktreeContext['branchSummary']
  isBranchVisible: boolean
  isFolder: boolean
}): void {
  // Why: the merge base IS the request gate — no OID on the status request means
  // the host runs no ranged diff, so a hidden chip costs a background worktree nothing.
  const requestedBranchLineTotalMergeBase =
    isBranchVisible && !isFolder && branchSummary?.status === 'ready'
      ? branchSummary.mergeBase
      : null
  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }
    setBranchLineTotalMergeBase(activeWorktreeId, requestedBranchLineTotalMergeBase)
    return () => {
      setBranchLineTotalMergeBase(activeWorktreeId, null)
    }
  }, [activeWorktreeId, requestedBranchLineTotalMergeBase])
}
