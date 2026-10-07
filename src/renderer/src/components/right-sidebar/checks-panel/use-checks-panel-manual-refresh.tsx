import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { buildGitHubPRRefreshStateClearToken } from '@/store/github/pr-refresh-state'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import { getRuntimeGitStatus, getRuntimeGitUpstreamStatus } from '@/runtime/runtime-git-client'
import {
  hasChecksPanelGitStatusBranchChanged,
  readChecksPanelRefreshGitIdentitySnapshot,
  shouldCommitChecksPanelGitStatusSnapshot
} from '../checks-panel-git-status-snapshot'

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
    const refreshProvider = isGitLabReviewContext ? 'gitlab' : 'github'
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
        prNumber: activeGitLabReview?.number ?? prNumber,
        prState: activeGitLabReview?.state ?? pr?.state,
        prChecksStatus: pr?.checksStatus,
        refreshState: prCacheKey ? useAppStore.getState().prRefreshStates[prCacheKey] : null,
        outcome,
        durationMs: event === 'done' ? Date.now() - refreshStartedAt : undefined,
        currentRequest: isCurrentRequest()
      })
    }
    recordBreadcrumb('start')
    try {
      if (activeWorktreeId && activeWorktreePath && !isFolder) {
        const snapshotIdentity = readChecksPanelRefreshGitIdentitySnapshot({
          snapshot: gitStatusSnapshot,
          contextKey: panelContextKey,
          currentBranch: branch
        })
        if (snapshotIdentity.kind === 'changed') {
          updateWorktreeGitIdentity(activeWorktreeId, {
            head: snapshotIdentity.head,
            branch: snapshotIdentity.branch
          })
          // Why: this click discovered a terminal branch switch; let branch-keyed render/effects restart instead of refreshing old PR data.
          refreshOutcome = 'branch-changed'
          return
        }
        try {
          const statusContext = {
            settings: ownerSettings,
            worktreeId: activeWorktreeId,
            worktreePath: activeWorktreePath,
            connectionId: activeConnectionId ?? undefined
          }
          const status = await getRuntimeGitStatus(statusContext, {
            admissionTier: 'interactive'
          })
          const observedBranch = status.branch ?? (status.head ? null : undefined)
          updateWorktreeGitIdentity(activeWorktreeId, {
            head: status.head,
            branch: observedBranch
          })
          if (
            observedBranch !== undefined &&
            hasChecksPanelGitStatusBranchChanged({ observedBranch, currentBranch: branch })
          ) {
            // Why: this click discovered a terminal branch switch; let branch-keyed render/effects restart instead of refreshing old PR data.
            refreshOutcome = 'branch-changed'
            return
          }
          let freshRemoteStatus = status.upstreamStatus
          if (activeWorktreePushTarget) {
            freshRemoteStatus = await getRuntimeGitUpstreamStatus(
              statusContext,
              activeWorktreePushTarget
            )
          } else if (
            !freshRemoteStatus ||
            (freshRemoteStatus.ahead > 0 &&
              freshRemoteStatus.behind > 0 &&
              freshRemoteStatus.behindCommitsArePatchEquivalent === undefined)
          ) {
            freshRemoteStatus = await getRuntimeGitUpstreamStatus(statusContext)
          }
          if (
            isCurrentRequest() &&
            shouldCommitChecksPanelGitStatusSnapshot(panelContextKeyRef.current, panelContextKey)
          ) {
            // Why: the Refresh click already paid for this status read; commit it so empty-state Publish/Create eligibility is fresh.
            setGitStatusSnapshot({
              contextKey: panelContextKey,
              hasUncommittedChanges: status.entries.length > 0,
              remoteStatus: freshRemoteStatus,
              gitIdentity: { head: status.head, branch: observedBranch }
            })
          }
        } catch (error) {
          console.warn('[ChecksPanel] pre-refresh git identity refresh failed', error)
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
      const isBitbucketReviewContext = Boolean(
        activeReview?.provider === 'bitbucket' || linkedBitbucketPR !== null
      )
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
          setComments([])
          refreshOutcome = refreshedReview?.provider === 'bitbucket' ? 'review' : 'no-review'
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
    activeReview?.provider,
    prNumber,
    pr?.checksStatus,
    pr?.headSha,
    pr?.prRepo,
    pr?.state,
    prCacheKey,
    linkedPR,
    fallbackGitHubPRNumber,
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
