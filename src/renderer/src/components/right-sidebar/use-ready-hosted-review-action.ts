import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { markGitHubHostedReviewReadyForReview } from './hosted-review-github-actions'
import { markGitLabHostedReviewReadyForReview } from './hosted-review-gitlab-actions'

export function useReadyHostedReviewAction({
  reviewNumber,
  githubPR,
  repo,
  isGitLab,
  shortLabel,
  reviewLabel,
  onRefreshReview,
  setActionError
}: {
  reviewNumber: number
  githubPR?: PRInfo | null
  repo: Repo
  isGitLab: boolean
  shortLabel: string
  reviewLabel: string
  onRefreshReview: () => Promise<void>
  setActionError: (message: string | null) => void
}): {
  readying: boolean
  handleMarkReadyForReview: () => Promise<void>
} {
  const [readying, setReadying] = useState(false)
  const handleMarkReadyForReview = useCallback(async () => {
    if (readying) {
      return
    }
    setReadying(true)
    setActionError(null)
    try {
      const result = isGitLab
        ? await markGitLabHostedReviewReadyForReview({ repo, mrNumber: reviewNumber })
        : await markGitHubHostedReviewReadyForReview({
            repo,
            prNumber: reviewNumber,
            prRepo: githubPR?.prRepo ?? null
          })
      if (!result.ok) {
        setActionError(result.error)
        toast.error(result.error)
        return
      }
      toast.success(
        translate(
          'auto.components.right.sidebar.HostedReviewActions.readyToast',
          '{{value0}} marked ready for review',
          { value0: shortLabel }
        )
      )
      await onRefreshReview()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Failed to mark ${reviewLabel} ready for review`
      setActionError(message)
      toast.error(message)
    } finally {
      setReadying(false)
    }
  }, [
    githubPR?.prRepo,
    isGitLab,
    onRefreshReview,
    readying,
    repo,
    reviewLabel,
    reviewNumber,
    setActionError,
    shortLabel
  ])

  return { readying, handleMarkReadyForReview }
}
