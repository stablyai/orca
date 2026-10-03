import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { updateGitHubHostedReviewBranch } from './hosted-review-github-actions'

export function useUpdatePullRequestBranch({
  repo,
  prNumber,
  githubPR,
  onRefreshReview,
  setActionError
}: {
  repo: Repo
  prNumber: number
  githubPR?: PRInfo | null
  onRefreshReview: () => Promise<void>
  setActionError: (message: string | null) => void
}) {
  const [updatingBranch, setUpdatingBranch] = useState(false)
  const inFlight = useRef(false)

  const handleUpdateBranch = useCallback(async () => {
    if (inFlight.current || !githubPR?.headSha) {
      return
    }
    inFlight.current = true
    setUpdatingBranch(true)
    setActionError(null)
    try {
      const result = await updateGitHubHostedReviewBranch({
        repo,
        prNumber,
        prRepo: githubPR.prRepo ?? null,
        expectedHeadSha: githubPR.headSha
      })
      if (!result.ok) {
        setActionError(result.error)
        return
      }
      toast.success(
        translate('auto.components.right.sidebar.UpdateBranch.requested', 'Branch update requested')
      )
      await onRefreshReview()
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Could not update the pull request branch.'
      )
    } finally {
      inFlight.current = false
      setUpdatingBranch(false)
    }
  }, [githubPR?.headSha, githubPR?.prRepo, onRefreshReview, prNumber, repo, setActionError])

  return { updatingBranch, handleUpdateBranch }
}
