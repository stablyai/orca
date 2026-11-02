import { useChecksDetailTimer } from './use-checks-detail-timer'
import { ChecksDetailPollingPolicy } from './checks-detail-polling-policy'
import { useCallback, useEffect, useRef, useState } from 'react'
import { gitLabPipelineJobsToPRChecks } from '../../../../../shared/gitlab-pipeline-checks'
import {
  checksPanelAsyncResultKey,
  checksPanelHostedReviewAsyncResultKey
} from '../checks-panel-async-result-key'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'
import { fetchGitLabMRDetailsForChecks, gitLabMRCommentsToPRComments } from './gitlab-review-client'
import { checksPanelLoadErrorMessage } from './checks-panel-forge-owner'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'

export type ChecksPanelPollingInput = Pick<
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
    | 'setChecks'
    | 'setChecksError'
    | 'setChecksLoading'
    | 'setComments'
    | 'setCommentsError'
    | 'setCommentsLoading'
    | 'gitLabProjectRefRef'
  > &
  Pick<ChecksPanelComposerState, 'isCurrentAsyncResult'>

export function useChecksPanelPolling(model: ChecksPanelPollingInput) {
  const modelRef = useRef(model)
  const [policy] = useState(() => new ChecksDetailPollingPolicy())
  const policyRef = useRef(policy)
  useEffect(() => {
    modelRef.current = model
  })
  const { activeGitLabReview, pr, prNumber, prCacheKey, branch, repo, hostedReviewCacheKey } = model
  const requestIdentity = JSON.stringify([
    repo?.id,
    repo?.path,
    repo?.executionHostId,
    repo?.connectionId,
    model.activeWorktree?.hostId,
    branch,
    activeGitLabReview ? 'gitlab' : 'github',
    activeGitLabReview?.number ?? prNumber,
    activeGitLabReview?.headSha ?? pr?.headSha,
    pr?.prRepo?.owner,
    pr?.prRepo?.repo,
    pr?.prRepo?.host,
    activeGitLabReview ? hostedReviewCacheKey : prCacheKey
  ])
  const gitLabDetailsLoadingGenerationRef = useRef(0)
  // Fetch checks via cached store method
  const fetchChecks = useCallback(
    async ({
      force = false,
      prNumberOverride
    }: { force?: boolean; prNumberOverride?: number | null } = {}) => {
      const {
        repo,
        prNumber,
        branch,
        pr,
        prCacheKey,
        fetchPRChecks,
        isCurrentAsyncResult,
        activeWorktree,
        setChecksLoading,
        setChecks,
        setChecksError,
        pollIntervalRef,
        prevChecksRef
      } = modelRef.current
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
            throwOnError: true,
            repoId: repo.id
          }
        )
        if (!isCurrentAsyncResult(requestKey)) {
          return
        }
        setChecks(result)

        // Unchanged details back off; a changed result restores the selected cadence.
        const signature = policyRef.current.accept(result)
        pollIntervalRef.current =
          signature === prevChecksRef.current
            ? Math.min(pollIntervalRef.current * 2, 120_000)
            : 60_000
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
        setChecksError(
          checksPanelLoadErrorMessage(err, forgeOwnerHostIdForWorkspace(repo, activeWorktree))
        )
        policyRef.current.fail()
        pollIntervalRef.current = Math.min(Math.max(60_000, pollIntervalRef.current * 2), 900_000)
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
    []
  )

  const fetchGitLabDetails = useCallback(
    async ({
      mrNumberOverride,
      headShaOverride,
      commitAsCurrent = false,
      isRequestCurrent
    }: {
      mrNumberOverride?: number | null
      headShaOverride?: string | null
      commitAsCurrent?: boolean
      isRequestCurrent?: () => boolean
    } = {}) => {
      const {
        activeGitLabReview,
        repo,
        branch,
        hostedReviewCacheKey,
        asyncResultKeyRef,
        activeWorktree,
        isCurrentAsyncResult,
        gitLabProjectRefRef,
        setChecks,
        setChecksError,
        setChecksLoading,
        setComments,
        setCommentsError,
        setCommentsLoading,
        pollIntervalRef,
        prevChecksRef
      } = modelRef.current
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
          iid: targetMRNumber,
          repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(repo, activeWorktree)
        })
        if (isRequestCurrent?.() === false || !isCurrentAsyncResult(requestKey)) {
          return
        }
        if (details === null) {
          throw new Error('GitLab MR details are unavailable')
        }
        gitLabProjectRefRef.current = details.item.projectRef ?? null
        const result = gitLabPipelineJobsToPRChecks(details?.pipelineJobs ?? [])
        setChecks(result)
        setComments(gitLabMRCommentsToPRComments(details?.comments))
        const signature = policyRef.current.accept(result)
        pollIntervalRef.current =
          signature === prevChecksRef.current
            ? Math.min(pollIntervalRef.current * 2, 120_000)
            : 60_000
        prevChecksRef.current = signature
      } catch (err) {
        if (isRequestCurrent?.() === false || !isCurrentAsyncResult(requestKey)) {
          return
        }
        console.warn('Failed to fetch GitLab MR checks:', err)
        // Why: one MR details read carries both the pipeline and the discussion.
        const message = checksPanelLoadErrorMessage(
          err,
          forgeOwnerHostIdForWorkspace(repo, activeWorktree)
        )
        setChecksError(message)
        setCommentsError(message)
        policyRef.current.fail()
        pollIntervalRef.current = Math.min(Math.max(60_000, pollIntervalRef.current * 2), 900_000)
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
    []
  )

  useChecksDetailTimer({
    model,
    modelRef,
    policyRef,
    requestIdentity,
    fetchChecks,
    fetchGitLabDetails
  })

  return { fetchChecks, fetchGitLabDetails }
}

export type ChecksPanelPollingState = ReturnType<typeof useChecksPanelPolling>
