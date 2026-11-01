import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { buildGitHubPRRefreshStateClearToken } from '@/store/github/pr-refresh-state'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { getRuntimeGitUpstreamStatus } from '@/runtime/runtime-git-sync-client'
import { resolveWorktreeGitCopyNow } from '@/lib/worktree-git-copy'
import {
  hasChecksPanelGitStatusBranchChanged,
  readChecksPanelRefreshGitIdentitySnapshot,
  shouldCommitChecksPanelGitStatusSnapshot
} from '../checks-panel-git-status-snapshot'

import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import { recordChecksPanelPRRefreshBreadcrumb } from '../checks-panel-pr-refresh-breadcrumb'
import { getHostedReviewManualRefreshError } from '../github-refresh-error-copy'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import {
  checksPanelManualRefreshProvider,
  refreshChecksPanelHostedReview,
  refreshHostedReviewForClick,
  useChecksPanelManualRefreshFailure
} from './hosted-review-manual-refresh'
import type { ChecksPanelManualRefreshInput } from './manual-refresh-dependencies'

// The manual Refresh is a user act: it may start a stopped WSL distro (E9).
const MANUAL_STATUS_READ = { admissionTier: 'interactive', wakeWslDistro: true } as const
export function useChecksPanelManualRefresh(model: ChecksPanelManualRefreshInput) {
  const {
    activeConnectionId,
    activeGitLabReview,
    activeWorktreeId,
    activeWorktreePath,
    activeWorktreePushTarget,
    asyncResultKeyRef,
    branch,
    expireGitHubPRRefreshState,
    fallbackGitHubPRNumber,
    fetchPRChecks,
    fetchPRComments,
    fetchPRForBranch,
    gitStatusSnapshot,
    hostedReviewCacheKey,
    isCurrentAsyncResult,
    isFolder,
    linkedPR,
    ownerCopyHostId,
    ownerTarget,
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
  const { manualRefreshError, setManualFailure } = useChecksPanelManualRefreshFailure(
    panelContextKey,
    hostedReviewCacheKey
  )
  const handleRefresh = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    if (refreshInFlightRef.current) {
      return
    }
    // Latch before render disables the button so double-clicks cannot duplicate Git subprocesses.
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
    const isCurrentRequest = (): boolean =>
      refreshRequestKeyRef.current === refreshRequestKey &&
      panelContextKeyRef.current === panelContextKey
    const refreshStartedAt = Date.now()
    const refreshProvider = checksPanelManualRefreshProvider(model)
    let refreshOutcome = 'started'
    setIsRefreshing(true)
    recordChecksPanelPRRefreshBreadcrumb({
      event: 'start',
      provider: refreshProvider,
      repoId: repo.id,
      worktreeId: activeWorktreeId,
      branch,
      prCacheKey,
      prNumber: activeGitLabReview?.number ?? prNumber,
      prState: activeGitLabReview?.state ?? pr?.state,
      prChecksStatus: pr?.checksStatus,
      refreshState: prCacheKey ? useAppStore.getState().prRefreshStates[prCacheKey] : null
    })
    try {
      if (activeWorktreeId && activeWorktreePath && !isFolder && ownerTarget) {
        // Why one resolution: a same-path twin must not get this copy's transport, SSH target or answer.
        const copy = resolveWorktreeGitCopyNow(activeWorktreeId, ownerCopyHostId)
        const ownerHostId = copy?.hostId ?? null
        const snapshotIdentity = readChecksPanelRefreshGitIdentitySnapshot({
          snapshot: gitStatusSnapshot,
          contextKey: panelContextKey,
          currentBranch: branch
        })
        if (snapshotIdentity.kind === 'changed') {
          updateWorktreeGitIdentity(
            activeWorktreeId,
            { head: snapshotIdentity.head, branch: snapshotIdentity.branch },
            ownerHostId
          )
          // A discovered terminal branch switch must restart branch-keyed effects rather than refresh old PR data.
          refreshOutcome = 'branch-changed'
          return
        }
        try {
          const statusContext = {
            target: copy?.transport ?? ownerTarget,
            worktreeId: activeWorktreeId,
            worktreePath: activeWorktreePath,
            connectionId: copy ? copy.connectionId : (activeConnectionId ?? undefined)
          }
          const status = await getRuntimeGitStatus(statusContext, MANUAL_STATUS_READ)
          const observedBranch = status.branch ?? (status.head ? null : undefined)
          updateWorktreeGitIdentity(
            activeWorktreeId,
            { head: status.head, branch: observedBranch },
            ownerHostId
          )
          if (
            observedBranch !== undefined &&
            hasChecksPanelGitStatusBranchChanged({
              observedBranch,
              currentBranch: branch
            })
          ) {
            // A discovered terminal branch switch must restart branch-keyed effects rather than refresh old PR data.
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
            // Reuse this click's status read to refresh Publish/Create eligibility.
            setGitStatusSnapshot({
              contextKey: panelContextKey,
              hasUncommittedChanges: status.entries.length > 0,
              remoteStatus: freshRemoteStatus,
              gitIdentity: {
                head: status.head,
                branch: observedBranch
              }
            })
          }
        } catch (error) {
          console.warn('[ChecksPanel] pre-refresh git identity refresh failed', error)
        }
      }
      if (refreshProvider !== 'github') {
        refreshOutcome = await refreshChecksPanelHostedReview(
          model,
          refreshProvider,
          isCurrentRequest
        )
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
          reason: 'manual',
          userRefresh: true
        })
      } finally {
        if (startedPRRefreshToken) {
          expireGitHubPRRefreshState(prCacheKey, startedPRRefreshToken)
        }
      }
      // Read this click's settlement now; the key-wide slot can belong to another read after the card read.
      const prLookupFailed =
        !refreshedPR && useAppStore.getState().prRefreshStates[prCacheKey]?.status === 'error'
      if (!isCurrentRequest()) {
        return
      }
      // The PR read above owns GitHub's refresh status, checks and comments; the review card read only refreshes the card.
      await refreshHostedReviewForClick(
        model,
        repo,
        branch,
        refreshedPR?.number ?? fallbackGitHubPRNumber
      ).catch(() => null)
      if (!isCurrentRequest()) {
        return
      }
      if (prLookupFailed) {
        refreshOutcome = 'error'
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
        // Forced refresh may discover the number before React repaints; mark these checks current now.
        asyncResultKeyRef.current = prRequestKey
        // Pass fresh headSha directly; the closure predates force-pushes and PR-number changes.
        const refreshedChecks = fetchPRChecks(
          repo.path,
          refreshedPR.number,
          branch,
          refreshedPR.headSha,
          refreshedPR.prRepo,
          { force: true, repoId: repo.id, wakeWslDistro: true, userRefresh: true }
        ).then(
          (result) => {
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
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
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
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
          prRepo: refreshedPR.prRepo,
          userRefresh: true
        }).then(
          (result) => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setComments(result)
            }
          },
          (err) => {
            if (!isCurrentRequest() || !isCurrentAsyncResult(prRequestKey)) {
              return
            }
            console.warn('Failed to fetch PR comments:', err)
            setComments([])
          }
        )
        await Promise.all([
          refreshedChecks.finally(() => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setChecksLoading(false)
            }
          }),
          refreshedComments.finally(() => {
            if (isCurrentRequest() && isCurrentAsyncResult(prRequestKey)) {
              setCommentsLoading(false)
            }
          })
        ])
      } else if (isCurrentRequest()) {
        setChecks([])
        setComments([])
        refreshOutcome = 'no-pr'
      }
    } catch {
      refreshOutcome = 'error'
      // GitHub failures surface through the PR store's own classified state, which clears itself.
      if (isCurrentRequest() && refreshProvider !== 'github') {
        setManualFailure(getHostedReviewManualRefreshError(refreshProvider))
      }
    } finally {
      recordChecksPanelPRRefreshBreadcrumb({
        event: 'done',
        provider: refreshProvider,
        repoId: repo.id,
        worktreeId: activeWorktreeId,
        branch,
        prCacheKey,
        prNumber: activeGitLabReview?.number ?? prNumber,
        prState: activeGitLabReview?.state ?? pr?.state,
        prChecksStatus: pr?.checksStatus,
        refreshState: prCacheKey ? useAppStore.getState().prRefreshStates[prCacheKey] : null,
        outcome: refreshOutcome,
        durationMs: Date.now() - refreshStartedAt,
        currentRequest: isCurrentRequest()
      })
      if (isCurrentRequest()) {
        if (['review', 'no-review', 'pr', 'no-pr'].includes(refreshOutcome)) {
          setManualFailure(null)
        }
        refreshInFlightRef.current = false
        setIsRefreshing(false)
        // Rerun eligibility to clear resolved authentication errors even when Git state is unchanged.
        setEligibilityRefreshNonce((value) => value + 1)
      }
    }
  }, [
    model,
    repo,
    branch,
    activeConnectionId,
    activeWorktreeId,
    activeWorktreePath,
    activeWorktreePushTarget,
    activeGitLabReview,
    prNumber,
    pr?.checksStatus,
    pr?.headSha,
    pr?.prRepo,
    pr?.state,
    prCacheKey,
    linkedPR,
    fallbackGitHubPRNumber,
    isFolder,
    gitStatusSnapshot,
    panelContextKey,
    fetchPRForBranch,
    fetchPRChecks,
    fetchPRComments,
    expireGitHubPRRefreshState,
    isCurrentAsyncResult,
    ownerCopyHostId,
    ownerTarget,
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
    setManualFailure,
    pollIntervalRef,
    refreshInFlightRef
  ])
  return {
    handleRefresh,
    manualRefreshError
  }
}

export type ChecksPanelRefreshState = ReturnType<typeof useChecksPanelManualRefresh>
