import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { buildGitHubPRRefreshStateClearToken } from '@/store/github/pr-refresh-state'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import { syncChecksPanelPreRefreshGitIdentity } from './checks-panel-pre-refresh-git-identity'

import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import { recordChecksPanelPRRefreshBreadcrumb } from '../checks-panel-pr-refresh-breadcrumb'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { ChecksPanelManualRefreshInput } from './manual-refresh-dependencies'

export function useChecksPanelManualRefresh(model: ChecksPanelManualRefreshInput) {
  const {
    activeConnectionId,
    activeGitLabReview,
    activeReview,
    activeWorktreeId,
    activeWorktreePath,
    activeWorktreePushTarget,
    asyncResultKeyRef,
    branch,
    expireGitHubPRRefreshState,
    fallbackGitHubPRNumber,
    fetchBitbucketDetails,
    fetchGitLabDetails,
    fetchHostedReviewForBranch,
    fetchPRChecks,
    fetchPRComments,
    fetchPRForBranch,
    gitStatusSnapshot,
    isCurrentAsyncResult,
    isFolder,
    isGitLabReviewContext,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    linkedPR,
    ownerSettings,
    panelContextKey,
    panelContextKeyRef,
    pollIntervalRef,
    pr,
    prCacheKey,
    prNumber,
    prevChecksRef,
    refreshInFlightRef,
    refreshRequestKeyRef,
    repo,
    setChecks,
    setChecksLoading,
    setComments,
    setCommentsLoading,
    setEligibilityRefreshNonce,
    setGitStatusSnapshot,
    setIsRefreshing,
    updateWorktreeGitIdentity
  } = model
  const handleRefresh = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    if (refreshInFlightRef.current) {
      return
    }
    // Why: button isn't disabled until next render; guard a rapid double-click from starting duplicate git subprocesses.
    refreshInFlightRef.current = true
    const initialRequestKey = checksPanelAsyncResultKey(
      prCacheKey,
      branch,
      prNumber,
      pr?.prRepo,
      pr?.headSha
    )
    const refreshRequestKey = `${activeWorktreeId ?? ''}::${prCacheKey}::${branch}::${Date.now()}::${Math.random()}`
    refreshRequestKeyRef.current = refreshRequestKey
    const isCurrentRequest = (): boolean => refreshRequestKeyRef.current === refreshRequestKey
    const refreshStartedAt = Date.now()
    const isBitbucketReviewContext = Boolean(
      activeReview?.provider === 'bitbucket' || linkedBitbucketPR !== null
    )
    const refreshProvider = isGitLabReviewContext
      ? 'gitlab'
      : isBitbucketReviewContext
        ? 'bitbucket'
        : 'github'
    let refreshOutcome = 'started'
    setIsRefreshing(true)
    const recordBreadcrumb = (event: 'start' | 'done', outcome?: string): void => {
      recordChecksPanelPRRefreshBreadcrumb({
        event,
        provider: refreshProvider,
        repoId: repo.id,
        worktreeId: activeWorktreeId,
        branch,
        prCacheKey,
        prNumber:
          activeGitLabReview?.number ??
          (activeReview?.provider === 'bitbucket' ? activeReview.number : undefined) ??
          linkedBitbucketPR ??
          prNumber,
        prState:
          activeGitLabReview?.state ??
          (activeReview?.provider === 'bitbucket' ? activeReview.state : undefined) ??
          pr?.state,
        prChecksStatus: isBitbucketReviewContext ? null : pr?.checksStatus,
        refreshState: prCacheKey ? useAppStore.getState().prRefreshStates[prCacheKey] : null,
        outcome,
        durationMs: event === 'done' ? Date.now() - refreshStartedAt : undefined,
        currentRequest: isCurrentRequest()
      })
    }
    recordBreadcrumb('start')
    try {
      if (activeWorktreeId && activeWorktreePath && !isFolder) {
        const syncResult = await syncChecksPanelPreRefreshGitIdentity({
          activeConnectionId,
          activeWorktreeId,
          activeWorktreePath,
          activeWorktreePushTarget,
          branch,
          gitStatusSnapshot,
          isCurrentRequest,
          ownerSettings,
          panelContextKey,
          panelContextKeyRef,
          setGitStatusSnapshot,
          updateWorktreeGitIdentity
        })
        if (syncResult === 'branch-changed') {
          refreshOutcome = 'branch-changed'
          return
        }
      }
      const hostedReviewArgs = {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        admissionTier: 'interactive' as const,
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: fallbackGitHubPRNumber,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR
      }
      if (isGitLabReviewContext || isBitbucketReviewContext) {
        const refreshedReview = await refreshHostedReviewCard(
          fetchHostedReviewForBranch,
          hostedReviewArgs
        )
        if (!isCurrentRequest()) {
          return
        }
        if (isGitLabReviewContext) {
          const refreshedGitLabReview =
            refreshedReview?.provider === 'gitlab' ? refreshedReview : activeGitLabReview
          if (refreshedGitLabReview) {
            await fetchGitLabDetails({
              mrNumberOverride: refreshedGitLabReview.number,
              headShaOverride: refreshedGitLabReview.headSha,
              commitAsCurrent: true
            })
            refreshOutcome = 'review'
          } else {
            setChecks([])
            setComments([])
            refreshOutcome = 'no-review'
          }
        } else {
          setChecks([])
          const refreshedBitbucketReview =
            refreshedReview?.provider === 'bitbucket'
              ? refreshedReview
              : activeReview?.provider === 'bitbucket'
                ? activeReview
                : null
          if (refreshedBitbucketReview) {
            await fetchBitbucketDetails({
              prNumberOverride: refreshedBitbucketReview.number
            })
            refreshOutcome = 'review'
          } else {
            setComments([])
            refreshOutcome = 'no-review'
          }
        }
        return
      }
      const refreshStoreState = useAppStore.getState()
      const rawPRRefreshState = refreshStoreState.prRefreshStates[prCacheKey]
      const startedPRRefreshToken = buildGitHubPRRefreshStateClearToken(
        rawPRRefreshState,
        refreshStoreState.prRefreshSequences,
        prCacheKey
      )
      let refreshedPR: PRInfo | null = null
      try {
        refreshedPR = await fetchPRForBranch(repo.path, branch, {
          force: true,
          repoId: repo.id,
          worktreeId: activeWorktreeId ?? undefined,
          linkedPRNumber: linkedPR,
          fallbackPRNumber: fallbackGitHubPRNumber,
          reason: 'manual'
        })
      } finally {
        if (startedPRRefreshToken) {
          expireGitHubPRRefreshState(prCacheKey, startedPRRefreshToken)
        }
      }
      if (!isCurrentRequest()) {
        return
      }
      await refreshHostedReviewCard(fetchHostedReviewForBranch, {
        ...hostedReviewArgs,
        fallbackGitHubPR: refreshedPR?.number ?? fallbackGitHubPRNumber
      })
      if (!isCurrentRequest()) {
        return
      }
      if (refreshedPR) {
        refreshOutcome = 'pr'
        const prRequestKey = checksPanelAsyncResultKey(
          prCacheKey,
          branch,
          refreshedPR.number,
          refreshedPR.prRepo,
          refreshedPR.headSha
        )
        if (!isCurrentAsyncResult(initialRequestKey) && !isCurrentRequest()) {
          return
        }
        // Why: a forced refresh can find the PR number before React repaints from prCache; mark this refresh's checks current.
        asyncResultKeyRef.current = prRequestKey
        // Why: pass the refreshed headSha directly; fetchChecks's closure captured a stale one (force-pushes, PR-number changes).
        const isMatchingResult = (): boolean =>
          isCurrentRequest() && isCurrentAsyncResult(prRequestKey)
        const refreshedChecks = fetchPRChecks(
          repo.path,
          refreshedPR.number,
          branch,
          refreshedPR.headSha,
          refreshedPR.prRepo,
          { force: true, repoId: repo.id }
        ).then(
          (result) => {
            if (!isMatchingResult()) {
              return
            }
            setChecks(result)
            const signature = JSON.stringify(
              result.map((c) => `${c.name}:${c.status}:${c.conclusion}`)
            )
            pollIntervalRef.current =
              signature === prevChecksRef.current
                ? Math.min(pollIntervalRef.current * 2, 120_000)
                : 30_000
            prevChecksRef.current = signature
          },
          (err) => {
            if (!isMatchingResult()) {
              return
            }
            console.warn('Failed to fetch PR checks:', err)
            setChecks([])
          }
        )
        setChecksLoading(true)
        setCommentsLoading(true)
        const refreshedComments = fetchPRComments(repo.path, refreshedPR.number, {
          force: true,
          repoId: repo.id,
          prRepo: refreshedPR.prRepo
        }).then(
          (result) => {
            if (isMatchingResult()) {
              setComments(result)
            }
          },
          (err) => {
            if (!isMatchingResult()) {
              return
            }
            console.warn('Failed to fetch PR comments:', err)
            setComments([])
          }
        )
        await Promise.all([
          refreshedChecks.finally(() => {
            if (isMatchingResult()) {
              setChecksLoading(false)
            }
          }),
          refreshedComments.finally(() => {
            if (isMatchingResult()) {
              setCommentsLoading(false)
            }
          })
        ])
      } else if (isCurrentRequest()) {
        setChecks([])
        setComments([])
        refreshOutcome = 'no-pr'
      }
    } catch (error) {
      refreshOutcome = 'error'
      throw error
    } finally {
      recordBreadcrumb('done', refreshOutcome)
      if (isCurrentRequest()) {
        refreshInFlightRef.current = false
        setIsRefreshing(false)
        // Why: force fresh eligibility so a resolved auth failure clears the sticky hard error even when Git state is unchanged.
        setEligibilityRefreshNonce((value) => value + 1)
      }
    }
  }, [
    repo,
    branch,
    activeConnectionId,
    activeWorktreeId,
    activeWorktreePath,
    activeWorktreePushTarget,
    activeGitLabReview,
    activeReview,
    prNumber,
    pr?.checksStatus,
    pr?.headSha,
    pr?.prRepo,
    pr?.state,
    prCacheKey,
    linkedPR,
    fallbackGitHubPRNumber,
    fetchBitbucketDetails,
    fetchGitLabDetails,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    isFolder,
    isGitLabReviewContext,
    gitStatusSnapshot,
    panelContextKey,
    fetchPRForBranch,
    fetchPRChecks,
    fetchPRComments,
    fetchHostedReviewForBranch,
    expireGitHubPRRefreshState,
    isCurrentAsyncResult,
    ownerSettings,
    updateWorktreeGitIdentity,
    panelContextKeyRef,
    asyncResultKeyRef,
    setCommentsLoading,
    setEligibilityRefreshNonce,
    prevChecksRef,
    setIsRefreshing,
    setChecksLoading,
    refreshRequestKeyRef,
    setChecks,
    setComments,
    setGitStatusSnapshot,
    pollIntervalRef,
    refreshInFlightRef
  ])
  return { handleRefresh }
}

export type ChecksPanelRefreshState = ReturnType<typeof useChecksPanelManualRefresh>
