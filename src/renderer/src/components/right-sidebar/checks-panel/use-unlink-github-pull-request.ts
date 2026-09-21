import { useCallback } from 'react'
import { toast } from 'sonner'

import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorktreeSlice } from '@/store/slices/worktree-helpers'

type UseUnlinkGitHubPullRequestArgs = {
  activeReview: HostedReviewInfo | null
  activeWorktree: Worktree | null
  activeWorktreeId: string | null
  linkedPR: number | null
  updateWorktreeMeta: WorktreeSlice['updateWorktreeMeta']
}

export function useUnlinkGitHubPullRequest({
  activeReview,
  activeWorktree,
  activeWorktreeId,
  linkedPR,
  updateWorktreeMeta
}: UseUnlinkGitHubPullRequestArgs): () => Promise<void> {
  return useCallback(async () => {
    if (!activeWorktreeId || !activeWorktree || activeReview?.provider !== 'github') {
      return
    }
    const result = await updateWorktreeMeta(
      activeWorktreeId,
      { linkedPR: null, suppressedGitHubPR: linkedPR ?? activeReview.number },
      { executionHostId: activeWorktree.hostId }
    )
    if (!result.ok) {
      toast.error(result.error)
    }
  }, [activeReview, activeWorktree, activeWorktreeId, linkedPR, updateWorktreeMeta])
}
