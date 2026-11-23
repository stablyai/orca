import { useEffect, useMemo, useRef, useState } from 'react'
import type { PRCheckDetail } from '../../../../../../shared/github/checks/check-types'
import type { PRComment } from '../../../../../../shared/github/comments/comment-types'
import type { AzureDevOpsPrReviewer } from '../../../../../../shared/azure-devops/azure-devops-pr-review-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  azureDevOpsChecksToPRChecks,
  azureDevOpsThreadsToPRComments
} from '../../../../../../shared/source-control/checks/azure-devops/azure-devops-pr-checks'
import { errorMessage } from '../../../../../../shared/errors/error-message'
import { fetchAzureDevOpsReviewSnapshot } from './azure-devops-review-client'

export type AzureDevOpsReviewData = {
  reviewers: AzureDevOpsPrReviewer[]
  checks: PRCheckDetail[]
  comments: PRComment[]
  loading: boolean
  error: string | null
}

/**
 * Its own state, never the panel's shared checks/comments: the GitHub effects clear those
 * whenever no GitHub PR is selected, which would wipe these rows.
 */
export function useAzureDevOpsReviewData(input: {
  repo: Repo | null
  worktree: Worktree | null
  number: number
  updatedAt: string | null | undefined
  isRefreshing: boolean
}): AzureDevOpsReviewData {
  const { repo, worktree, number, updatedAt, isRefreshing } = input
  const [state, setState] = useState<Omit<AzureDevOpsReviewData, 'loading'>>({
    reviewers: [],
    checks: [],
    comments: [],
    error: null
  })
  const [loading, setLoading] = useState(true)
  // A finished header Refresh re-reads too, so its spinner means these rows as well.
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const wasRefreshing = useRef(isRefreshing)
  useEffect(() => {
    if (wasRefreshing.current && !isRefreshing) {
      setRefreshGeneration((generation) => generation + 1)
    }
    wasRefreshing.current = isRefreshing
  }, [isRefreshing])

  useEffect(() => {
    if (!repo) {
      return
    }
    let cancelled = false
    setLoading(true)
    fetchAzureDevOpsReviewSnapshot(repo, worktree, number)
      .then((snapshot) => {
        if (cancelled) {
          return
        }
        setState({
          reviewers: snapshot.detail?.reviewers ?? [],
          checks: azureDevOpsChecksToPRChecks(snapshot.checks),
          comments: azureDevOpsThreadsToPRComments(snapshot.threads),
          error: null
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState((previous) => ({ ...previous, error: errorMessage(error) }))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repo, worktree, number, updatedAt, refreshGeneration])

  return useMemo(() => ({ ...state, loading }), [state, loading])
}
