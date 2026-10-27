import { useEffect } from 'react'
import { setBranchLineTotalMergeBase } from '../../branch-line-total-request-gate'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'

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
  // Omitting the merge-base OID skips the host’s ranged diff, keeping hidden chips free of background work.
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
