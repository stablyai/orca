import { useCallback, useEffect, useRef } from 'react'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-visibility-timeout-poller'
import { gitLabPipelineJobsToPRChecks } from '../../../../../shared/gitlab-pipeline-checks'
import {
  checksPanelAsyncResultKey,
  checksPanelHostedReviewAsyncResultKey
} from '../checks-panel-async-result-key'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'
import { fetchGitLabMRDetailsForChecks, gitLabMRCommentsToPRComments } from './gitlab-review-client'

type ChecksPanelPollingInput = Pick<
  ChecksPanelContextState,
  'activeGitLabReview' | 'hostedReviewCacheKey' | 'pr' | 'prCacheKey' | 'prNumber'
> &
  Pick<
    ChecksPanelControllerState,
    | 'asyncResultKeyRef'
    | 'activeWorktree'
    | 'branch'
    | 'fetchPRChecks'
    | 'isPanelVisible'
    | 'pollIntervalRef'
    | 'prevChecksRef'
    | 'repo'
    | 'settings'
    | 'setChecks'
    | 'setChecksLoading'
    | 'setComments'
    | 'setCommentsLoading'
    | 'gitLabProjectRefRef'
  > &
  Pick<ChecksPanelComposerState, 'isCurrentAsyncResult'>

export function useChecksPanelPolling(model: ChecksPanelPollingInput) {
  const {
    activeWorktree,
    activeGitLabReview,
    asyncResultKeyRef,
    branch,
    fetchPRChecks,
    hostedReviewCacheKey,
    isCurrentAsyncResult,
    isPanelVisible,
    pollIntervalRef,
    pr,
    prCacheKey,
    prNumber,
    prevChecksRef,
    repo,
    settings,
    setChecks,
    setChecksLoading,
    setComments,
    setCommentsLoading,
    gitLabProjectRefRef
  } = model
  const gitLabDetailsLoadingGenerationRef = useRef(0)
  // Fetch checks via cached store method
  const fetchChecks = useCallback(
    async ({
      force = false,
      prNumberOverride
    }: { force?: boolean; prNumberOverride?: number | null } = {}) => {
      const targetPRNumber = prNumberOverride ?? prNumber
      if (!repo || !targetPRNumber) {
        return
      }
      setChecksLoading(true)
      try {
        const requestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          targetPRNumber,
          pr?.prRepo,
          pr?.headSha
        )
        const result = await fetchPRChecks(
          repo.path,
          targetPRNumber,
          branch,
          pr?.headSha,
          pr?.prRepo,
          {
            force,
            repoId: repo.id
          }
        )
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
        setChecks(result)

        // Exponential backoff: unchanged checks double the interval (cap 120s), changes reset to 30s.
        const signature = JSON.stringify(result.map((c) => `${c.name}:${c.status}:${c.conclusion}`))
        pollIntervalRef.current =
          signature === prevChecksRef.current
            ? Math.min(pollIntervalRef.current * 2, 120_000)
            : 30_000
        prevChecksRef.current = signature
      } catch (err) {
        if (
          !isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, pr?.prRepo, pr?.headSha)
          )
        ) {
          return
        }
        console.warn('Failed to fetch PR checks:', err)
        setChecks([])
      } finally {
        if (
          isCurrentAsyncResult(
            checksPanelAsyncResultKey(prCacheKey, branch, targetPRNumber, pr?.prRepo, pr?.headSha)
          )
        ) {
          setChecksLoading(false)
        }
      }
    },
    [
      repo,
      prNumber,
      branch,
      pr?.headSha,
      pr?.prRepo,
      prCacheKey,
      fetchPRChecks,
      isCurrentAsyncResult,
      prevChecksRef,
      setChecksLoading,
      pollIntervalRef,
      setChecks
    ]
  )

  const fetchGitLabDetails = useCallback(
    async ({
      mrNumberOverride,
      headShaOverride,
      commitAsCurrent = false,
      settingsOverride,
      isRequestCurrent
    }: {
      mrNumberOverride?: number | null
      headShaOverride?: string | null
      commitAsCurrent?: boolean
      settingsOverride?: ChecksPanelControllerState['settings']
      isRequestCurrent?: () => boolean
    } = {}) => {
      const targetMRNumber = mrNumberOverride ?? activeGitLabReview?.number ?? null
      const targetHeadSha =
        headShaOverride === undefined ? (activeGitLabReview?.headSha ?? null) : headShaOverride
      if (!repo || !targetMRNumber) {
        return
      }
      const requestKey = checksPanelHostedReviewAsyncResultKey(
        hostedReviewCacheKey,
        branch,
        'gitlab',
        targetMRNumber,
        targetHeadSha
      )
      if (isRequestCurrent?.() === false) {
        return
      }
      if (commitAsCurrent) {
        asyncResultKeyRef.current = requestKey
      }
      const loadingGeneration = gitLabDetailsLoadingGenerationRef.current + 1
      gitLabDetailsLoadingGenerationRef.current = loadingGeneration
      setChecksLoading(true)
      setCommentsLoading(true)
      try {
        const details = await fetchGitLabMRDetailsForChecks({
          repoPath: repo.path,
          repoId: repo.id,
          settings: settingsOverride ?? settings,
          iid: targetMRNumber,
          repoOwnerExecutionHostId: activeWorktree?.hostId
        })
        if (isRequestCurrent?.() === false || !isCurrentAsyncResult(requestKey)) {
          return
        }
        gitLabProjectRefRef.current = details?.item.projectRef ?? null
        const result = gitLabPipelineJobsToPRChecks(details?.pipelineJobs ?? [])
        setChecks(result)
        setComments(gitLabMRCommentsToPRComments(details?.comments))
        const signature = JSON.stringify(result.map((c) => `${c.name}:${c.status}:${c.conclusion}`))
        pollIntervalRef.current =
          signature === prevChecksRef.current
            ? Math.min(pollIntervalRef.current * 2, 120_000)
            : 30_000
        prevChecksRef.current = signature
      } catch (err) {
        if (isRequestCurrent?.() === false || !isCurrentAsyncResult(requestKey)) {
          return
        }
        console.warn('Failed to fetch GitLab MR checks:', err)
        setChecks([])
        setComments([])
      } finally {
        if (
          gitLabDetailsLoadingGenerationRef.current === loadingGeneration &&
          isCurrentAsyncResult(requestKey)
        ) {
          setChecksLoading(false)
          setCommentsLoading(false)
        }
      }
    },
    [
      activeGitLabReview?.headSha,
      activeGitLabReview?.number,
      activeWorktree?.hostId,
      branch,
      hostedReviewCacheKey,
      isCurrentAsyncResult,
      repo,
      settings,
      asyncResultKeyRef,
      setChecksLoading,
      prevChecksRef,
      pollIntervalRef,
      setCommentsLoading,
      setChecks,
      setComments,
      gitLabProjectRefRef
    ]
  )

  // Fetch checks on mount + poll with exponential backoff
  useEffect(() => {
    if (activeGitLabReview) {
      return
    }
    if (!prNumber || !isPanelVisible) {
      setChecks([])
      return
    }

    // Reset backoff state on PR change
    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    // Why: check status is user-visible; keep visible unfocused windows fresh but stop timers/API work while hidden.
    return installWindowVisibilityTimeoutPoller({
      run: () => fetchChecks(),
      getDelayMs: () => pollIntervalRef.current
    })
  }, [
    activeGitLabReview,
    fetchChecks,
    isPanelVisible,
    prNumber,
    pollIntervalRef,
    prevChecksRef,
    setChecks
  ])

  useEffect(() => {
    if (!activeGitLabReview || !isPanelVisible) {
      return
    }

    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    return installWindowVisibilityTimeoutPoller({
      run: () => fetchGitLabDetails(),
      getDelayMs: () => pollIntervalRef.current
    })
  }, [activeGitLabReview, fetchGitLabDetails, isPanelVisible, pollIntervalRef, prevChecksRef])
  return { fetchChecks, fetchGitLabDetails }
}

export type ChecksPanelPollingState = ReturnType<typeof useChecksPanelPolling>
