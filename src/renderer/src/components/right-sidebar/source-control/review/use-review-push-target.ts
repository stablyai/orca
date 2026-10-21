import { useEffect } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'

export function useSourceControlReviewPushTarget({
  activeWorktree,
  activeWorktreeId,
  ensureHostedReviewPushTarget,
  hasResolvableReviewPushTargetLink,
  isBranchVisible,
  isFolder
}: {
  activeWorktree: SourceControlWorktreeContext['activeWorktree']
  activeWorktreeId: string | null
  ensureHostedReviewPushTarget: SourceControlStoreActions['ensureHostedReviewPushTarget']
  hasResolvableReviewPushTargetLink: boolean
  isBranchVisible: boolean
  isFolder: boolean
}): void {
  useEffect(() => {
    if (
      !isWindowVisible() ||
      !isBranchVisible ||
      isFolder ||
      !activeWorktreeId ||
      activeWorktree?.pushTarget ||
      !hasResolvableReviewPushTargetLink
    ) {
      return
    }
    void ensureHostedReviewPushTarget(activeWorktreeId)
  }, [
    activeWorktree?.pushTarget,
    activeWorktreeId,
    ensureHostedReviewPushTarget,
    hasResolvableReviewPushTargetLink,
    isBranchVisible,
    isFolder
  ])
}
