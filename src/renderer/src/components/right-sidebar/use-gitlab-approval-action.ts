import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import {
  type GitLabApprovalChange,
  setGitLabHostedReviewApproval
} from './hosted-review-gitlab-actions'

export function useGitLabApprovalAction({
  reviewNumber,
  repo,
  onRefreshReview,
  setActionError
}: {
  reviewNumber: number
  repo: Repo
  onRefreshReview: () => Promise<void>
  setActionError: (message: string | null) => void
}): {
  approving: boolean
  handleApproval: (approval: GitLabApprovalChange) => Promise<void>
} {
  const [approving, setApproving] = useState(false)
  const handleApproval = useCallback(
    async (approval: GitLabApprovalChange) => {
      if (approving) {
        return
      }
      setApproving(true)
      setActionError(null)
      try {
        try {
          const result = await setGitLabHostedReviewApproval({
            repo,
            mrNumber: reviewNumber,
            approval
          })
          if (!result.ok) {
            setActionError(result.error)
            toast.error(result.error)
          }
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : translate(
                  'auto.components.right.sidebar.GitLabApprovalAction.failed',
                  'Failed to update approval'
                )
          setActionError(message)
          toast.error(message)
        }
        // Why: refresh even after a failure; a lost response or an "already approved" race leaves the button stale otherwise.
        await onRefreshReview()
      } finally {
        setApproving(false)
      }
    },
    [approving, onRefreshReview, repo, reviewNumber, setActionError]
  )
  return { approving, handleApproval }
}
