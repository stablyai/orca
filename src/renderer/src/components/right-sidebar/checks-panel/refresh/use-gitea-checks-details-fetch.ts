import { useCallback, useRef, type RefObject } from 'react'
import type { ChecksDetailPollingPolicy } from '../../../../../../shared/github/checks/checks-detail-polling-policy'
import { checksPanelHostedReviewAsyncResultKey } from './checks-panel-async-result-key'
import { checksPanelLoadErrorMessage } from '../review-data/checks-panel-forge-owner'
import {
  fetchGiteaReviewDataForChecks,
  giteaPipelineJobsToPRChecks,
  giteaPRCommentsToPRComments
} from '../review-data/gitea-review-client'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/source-control/forge/forge-credential-target'
import { isWslDistroNotRunningRefusal } from '../../../../../../shared/remote-runtime/wsl-hosts/wsl-distro-not-running-refusal'
import type { ChecksPanelPollingInput } from './use-checks-panel-polling'

export function useGiteaChecksDetailsFetch(
  modelRef: RefObject<ChecksPanelPollingInput>,
  policy: ChecksDetailPollingPolicy
) {
  const loadingGenerationRef = useRef(0)
  return useCallback(
    async ({
      prNumberOverride,
      headShaOverride,
      commitAsCurrent = false,
      isRequestCurrent,
      background = false
    }: {
      prNumberOverride?: number | null
      headShaOverride?: string | null
      commitAsCurrent?: boolean
      isRequestCurrent?: () => boolean
      /** A poll or tab entry: refused rather than booting a stopped WSL distro. */
      background?: boolean
    } = {}) => {
      const {
        activeGiteaReview,
        repo,
        branch,
        hostedReviewCacheKey,
        asyncResultKeyRef,
        activeWorktree,
        isCurrentAsyncResult,
        setChecks,
        setChecksError,
        setChecksLoading,
        setComments,
        setCommentsError,
        setCommentsLoading,
        pollIntervalRef,
        prevChecksRef
      } = modelRef.current
      const targetPRNumber = prNumberOverride ?? activeGiteaReview?.number ?? null
      const targetHeadSha =
        headShaOverride === undefined ? (activeGiteaReview?.headSha ?? null) : headShaOverride
      if (!repo || !targetPRNumber) {
        return
      }
      const requestKey = checksPanelHostedReviewAsyncResultKey(
        hostedReviewCacheKey,
        branch,
        'gitea',
        targetPRNumber,
        targetHeadSha
      )
      if (isRequestCurrent?.() === false) {
        return
      }
      if (commitAsCurrent) {
        asyncResultKeyRef.current = requestKey
      }
      const loadingGeneration = loadingGenerationRef.current + 1
      loadingGenerationRef.current = loadingGeneration
      setChecksLoading(true)
      setCommentsLoading(true)
      try {
        const details = await fetchGiteaReviewDataForChecks({
          repoPath: repo.path,
          repoId: repo.id,
          number: targetPRNumber,
          repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(repo, activeWorktree),
          background
        })
        if (isRequestCurrent?.() === false || !isCurrentAsyncResult(requestKey)) {
          return
        }
        if (details === null) {
          throw new Error('Gitea PR details are unavailable')
        }
        const result = giteaPipelineJobsToPRChecks(details.pipelineJobs ?? [])
        setChecks(result)
        setComments(giteaPRCommentsToPRComments(details.comments))
        const signature = policy.accept(result)
        pollIntervalRef.current =
          signature === prevChecksRef.current
            ? Math.min(pollIntervalRef.current * 2, 120_000)
            : 60_000
        prevChecksRef.current = signature
      } catch (err) {
        if (isRequestCurrent?.() === false || !isCurrentAsyncResult(requestKey)) {
          return
        }
        if (!isWslDistroNotRunningRefusal(err)) {
          console.warn('Failed to fetch Gitea PR checks:', err)
        }
        // One PR details request contains both Actions jobs and discussion; report failure for both.
        const message = checksPanelLoadErrorMessage(
          err,
          forgeOwnerHostIdForWorkspace(repo, activeWorktree)
        )
        setChecksError(message)
        setCommentsError(message)
        policy.fail()
        pollIntervalRef.current = Math.min(Math.max(60_000, pollIntervalRef.current * 2), 900_000)
      } finally {
        if (
          loadingGenerationRef.current === loadingGeneration &&
          isCurrentAsyncResult(requestKey)
        ) {
          setChecksLoading(false)
          setCommentsLoading(false)
        }
      }
    },
    [modelRef, policy]
  )
}
