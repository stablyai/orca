import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { updateGitHubHostedReviewBranch } from './hosted-review-github-actions'

/** GitHub-only "Update branch" action for the right-sidebar hosted-review actions. */
export function useHostedReviewUpdateBranch({
  reviewNumber,
  githubPR,
  repo,
  isGitLab,
  onRefreshReview,
  setActionError
}: {
  reviewNumber: number
  githubPR?: PRInfo | null
  repo: Repo
  isGitLab: boolean
  onRefreshReview: () => Promise<void>
  setActionError: (message: string | null) => void
}): { updatingBranch: boolean; handleUpdateBranch: () => Promise<void> } {
  const [updatingBranch, setUpdatingBranch] = useState(false)

  const handleUpdateBranch = useCallback(async () => {
    if (isGitLab) {
      return
    }
    setUpdatingBranch(true)
    setActionError(null)
    try {
      const result = await updateGitHubHostedReviewBranch({
        repo,
        prNumber: reviewNumber,
        prRepo: githubPR?.prRepo ?? null
      })
      if (!result.ok) {
        setActionError(result.error)
        toast.error(result.error)
      } else {
        toast.success(
          translate(
            'auto.components.right.sidebar.HostedReviewActions.updateBranchSucceeded',
            'Branch update started'
          )
        )
        await onRefreshReview()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update branch'
      setActionError(message)
      toast.error(message)
    } finally {
      setUpdatingBranch(false)
    }
  }, [githubPR?.prRepo, isGitLab, onRefreshReview, repo, reviewNumber, setActionError])

  return { updatingBranch, handleUpdateBranch }
}
