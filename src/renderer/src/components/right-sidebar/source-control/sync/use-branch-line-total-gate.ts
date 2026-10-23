import { useEffect } from 'react'
import { setBranchLineTotalComparisonBase } from '../../branch-line-total-request-gate'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'

/** Registers the visible comparison revision until it changes or the view unmounts. */
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
  // Why: the comparison revision is the request gate — no OID on the status request means
  // the host runs no ranged diff, so a hidden chip costs a background worktree nothing.
  const comparisonBaseOid =
    isBranchVisible && !isFolder && branchSummary?.status === 'ready'
      ? branchSummary.mergeBase
      : null
  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }
    setBranchLineTotalComparisonBase(activeWorktreeId, comparisonBaseOid)
    return () => {
      setBranchLineTotalComparisonBase(activeWorktreeId, null)
    }
  }, [activeWorktreeId, comparisonBaseOid])
}
