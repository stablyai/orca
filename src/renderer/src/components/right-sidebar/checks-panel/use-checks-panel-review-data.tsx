import { useCallback, useEffect } from 'react'
import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import { loadGitLabJobLogDetails } from '@/runtime/gitlab-job-trace-client'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'

import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'

type ChecksPanelReviewDataInput = Pick<
  ChecksPanelContextState,
  'activeGitLabReview' | 'activeReview' | 'pr' | 'prCacheKey' | 'prNumber'
> &
  Pick<
    ChecksPanelControllerState,
    | 'activeWorktree'
    | 'branch'
    | 'fetchPRCheckDetails'
    | 'fetchPRComments'
    | 'gitLabProjectRefRef'
    | 'isPanelVisible'
    | 'repo'
    | 'settings'
    | 'setComments'
    | 'setCommentsLoading'
  > &
  Pick<ChecksPanelComposerState, 'isCurrentAsyncResult'>

export function useChecksPanelReviewData(model: ChecksPanelReviewDataInput) {
  const {
    activeGitLabReview,
    activeReview,
    activeWorktree,
    branch,
    fetchPRCheckDetails,
    fetchPRComments,
    gitLabProjectRefRef,
    isCurrentAsyncResult,
    isPanelVisible,
    pr,
    prCacheKey,
    prNumber,
    repo,
    settings,
    setComments,
    setCommentsLoading
  } = model
  // Fetch comments once when PR changes (no polling — comments change infrequently).
  const fetchComments = useCallback(
    async ({
      force = false,
      prNumberOverride,
      prRepoOverride
    }: {
      force?: boolean
      prNumberOverride?: number | null
      prRepoOverride?: PRInfo['prRepo'] | null
    } = {}) => {
      if (activeReview?.provider === 'bitbucket') {
        const targetPRNumber = prNumberOverride ?? activeReview.number
        if (!repo || !targetPRNumber) {
          return
        }
        setCommentsLoading(true)
        try {
          const result = await window.api.bitbucket.getPRComments({
            repoPath: repo.path,
            prNumber: targetPRNumber,
            executionHostId: activeWorktree?.hostId
          })
          if (activeReview?.provider === 'bitbucket' && activeReview.number === targetPRNumber) {
            setComments(result)
          }
        } catch (err) {
          console.warn('Failed to fetch Bitbucket PR comments:', err)
          if (activeReview?.provider === 'bitbucket' && activeReview.number === targetPRNumber) {
            setComments([])
          }
        } finally {
          if (activeReview?.provider === 'bitbucket' && activeReview.number === targetPRNumber) {
            setCommentsLoading(false)
          }
        }
        return
      }
      const targetPRNumber = prNumberOverride ?? prNumber
      const targetPRRepo = prRepoOverride ?? pr?.prRepo
      if (!repo || !targetPRNumber) {
        return
      }
      setCommentsLoading(true)
      try {
        const requestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          targetPRNumber,
          targetPRRepo,
          pr?.headSha
        )
        const result = await fetchPRComments(repo.path, targetPRNumber, {
          force,
          repoId: repo.id,
          prRepo: targetPRRepo
        })
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
        setComments(result)
      } catch (err) {
        if (
          !isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, targetPRRepo, pr?.headSha)
          )
        ) {
          return
        }
        console.warn('Failed to fetch PR comments:', err)
        setComments([])
      } finally {
        if (
          isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, targetPRRepo, pr?.headSha)
          )
        ) {
          setCommentsLoading(false)
        }
      }
    },
    [
      activeReview?.number,
      activeReview?.provider,
      activeWorktree?.hostId,
      repo,
      prNumber,
      pr?.headSha,
      pr?.prRepo,
      prCacheKey,
      fetchPRComments,
      branch,
      isCurrentAsyncResult,
      setCommentsLoading,
      setComments
    ]
  )

  const handleLoadCheckDetails = useCallback(
    (check: PRCheckDetail) => {
      if (!repo) {
        return Promise.resolve(null)
      }
      if (check.gitlabJobId) {
        // Why: `settings` (not ownerSettings) is what fetched the job list, so the
        // job id and its trace always resolve against the same host.
        return loadGitLabJobLogDetails({
          repoPath: repo.path,
          repoId: repo.id,
          settings,
          check,
          projectRef: gitLabProjectRefRef.current
        })
      }
      return fetchPRCheckDetails(
        repo.path,
        {
          checkRunId: check.checkRunId,
          workflowRunId: check.workflowRunId,
          checkName: check.name,
          url: check.url,
          prRepo: pr?.prRepo ?? null
        },
        { repoId: repo.id }
      )
    },
    [fetchPRCheckDetails, pr?.prRepo, repo, settings, gitLabProjectRefRef]
  )

  // Why: read at call time — the ref is filled by an async MR fetch, so a value prop would be stale.
  const getGitLabProjectRef = useCallback(() => gitLabProjectRefRef.current, [gitLabProjectRefRef])

  useEffect(() => {
    if (activeGitLabReview) {
      return
    }
    if (activeReview?.provider === 'bitbucket') {
      if (!repo || !activeReview.number || !isPanelVisible) {
        setComments([])
        return
      }
      let cancelled = false
      setCommentsLoading(true)
      void window.api.bitbucket
        .getPRComments({
          repoPath: repo.path,
          prNumber: activeReview.number,
          executionHostId: activeWorktree?.hostId
        })
        .then(
          (result) => {
            if (!cancelled) {
              setComments(result)
              setCommentsLoading(false)
            }
          },
          () => {
            if (!cancelled) {
              setComments([])
              setCommentsLoading(false)
            }
          }
        )
      return () => {
        cancelled = true
      }
    }
    if (!repo || !prNumber || !isPanelVisible) {
      setComments([])
      return
    }
    let cancelled = false
    const requestKey = checksPanelAsyncResultKey(
      prCacheKey,
      branch,
      prNumber,
      pr?.prRepo,
      pr?.headSha
    )
    setCommentsLoading(true)
    void fetchPRComments(repo.path, prNumber, { repoId: repo.id, prRepo: pr?.prRepo }).then(
      (result) => {
        if (!cancelled && isCurrentAsyncResult(requestKey)) {
          setComments(result)
          setCommentsLoading(false)
        }
      },
      () => {
        if (!cancelled && isCurrentAsyncResult(requestKey)) {
          setComments([])
          setCommentsLoading(false)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [
    activeGitLabReview,
    activeReview?.number,
    activeReview?.provider,
    activeWorktree?.hostId,
    repo,
    prNumber,
    pr?.headSha,
    pr?.prRepo,
    prCacheKey,
    branch,
    isPanelVisible,
    fetchPRComments,
    isCurrentAsyncResult,
    setComments,
    setCommentsLoading
  ])

  useEffect(() => {
    if (
      activeGitLabReview ||
      activeReview?.provider === 'bitbucket' ||
      !repo ||
      !prNumber ||
      !isPanelVisible
    ) {
      return undefined
    }
    return window.api.gh.onWorkItemMutated((payload) => {
      const sameRepo =
        payload.repoId != null ? payload.repoId === repo.id : payload.repoPath === repo.path
      if (!sameRepo || payload.type !== 'pr' || payload.number !== prNumber) {
        return
      }
      void fetchComments({ force: true })
    })
  }, [activeGitLabReview, activeReview?.provider, fetchComments, isPanelVisible, prNumber, repo])
  return { fetchComments, handleLoadCheckDetails, getGitLabProjectRef }
}

export type ChecksPanelReviewDataState = ReturnType<typeof useChecksPanelReviewData>
