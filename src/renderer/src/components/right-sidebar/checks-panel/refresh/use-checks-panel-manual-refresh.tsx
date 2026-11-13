import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { useCallback, useRef } from 'react'
import { useAppStore } from '@/store/index'
import type { PRRefreshErrorType } from '../../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  manualRefreshResult,
  manualRetryPRHint,
  reportedManualRefresh,
  type ChecksPanelManualRefreshResult
} from './checks-panel-manual-refresh-result'
import { buildGitHubPRRefreshStateClearToken } from '@/store/github/refresh/pr-refresh-state'
import { getRuntimeGitStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import { readManualRefreshRemoteStatus } from './manual-refresh-remote-status'
import { resolveWorktreeGitCopyNow } from '@/lib/workspace/ownership/worktree-git-copy'
import {
  hasChecksPanelGitStatusBranchChanged,
  readChecksPanelRefreshGitIdentitySnapshot,
  shouldCommitChecksPanelGitStatusSnapshot
} from './checks-panel-git-status-snapshot'

import { checksPanelAsyncResultKey } from './checks-panel-async-result-key'
import { recordChecksPanelPRRefreshBreadcrumb } from './checks-panel-pr-refresh-breadcrumb'
import { getHostedReviewManualRefreshError } from '../../hosted-review/provider-actions/github-refresh-error-copy'
import type { PRInfo } from '../../../../../../shared/github/pull-requests/pull-request-types'
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
    checksPanelReviewLookupResult,
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
  const retryHint = manualRetryPRHint(
    linkedPR,
    fallbackGitHubPRNumber,
    checksPanelReviewLookupResult
  )
  const lastRefreshRef = useRef<ChecksPanelManualRefreshResult>({ kind: 'skipped' })
  const runRefresh = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    const repoOptions = { repoId: repo.id, repoOwnerExecutionHostId: getRepoExecutionHostId(repo) }
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
    let failedErrorType: PRRefreshErrorType | undefined
    setIsRefreshing(true)
    const breadcrumb = (
      fields: Pick<Parameters<typeof recordChecksPanelPRRefreshBreadcrumb>[0], 'event'> &
        Partial<Parameters<typeof recordChecksPanelPRRefreshBreadcrumb>[0]>
    ): void =>
      recordChecksPanelPRRefreshBreadcrumb({
        provider: refreshProvider,
        repoId: repo.id,
        worktreeId: activeWorktreeId,
        branch,
        prCacheKey,
        prNumber: activeGitLabReview?.number ?? prNumber,
        prState: activeGitLabReview?.state ?? pr?.state,
        prChecksStatus: pr?.checksStatus,
        refreshState: prCacheKey ? useAppStore.getState().prRefreshStates[prCacheKey] : null,
        ...fields
      })
    breadcrumb({ event: 'start' })
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
          const freshRemoteStatus = await readManualRefreshRemoteStatus(
            statusContext,
            status.upstreamStatus,
            activeWorktreePushTarget
          )
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
      const startedPRRefreshToken = buildGitHubPRRefreshStateClearToken(
        refreshStoreState.prRefreshStates[prCacheKey],
        refreshStoreState.prRefreshSequences,
        prCacheKey
      )
      let refreshedPR: PRInfo | null = null
      try {
        refreshedPR = await fetchPRForBranch(repo.path, branch, {
          force: true,
          ...repoOptions,
          worktreeId: activeWorktreeId ?? undefined,
          linkedPRNumber: linkedPR,
          ...retryHint,
          reason: 'manual',
          userRefresh: true
        })
      } finally {
        if (startedPRRefreshToken) {
          expireGitHubPRRefreshState(prCacheKey, startedPRRefreshToken)
        }
      }
      // Read this click's settlement now; the key-wide slot can belong to another read after the card read.
      const prLookupState = useAppStore.getState().prRefreshStates[prCacheKey]
      const prLookupFailed = !refreshedPR && prLookupState?.status === 'error'
      failedErrorType = prLookupFailed ? prLookupState?.errorType : undefined
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
          { force: true, ...repoOptions, wakeWslDistro: true, userRefresh: true }
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
          ...repoOptions,
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
      lastRefreshRef.current = manualRefreshResult(
        refreshOutcome,
        isCurrentRequest(),
        failedErrorType
      )
      breadcrumb({
        event: 'done',
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
    retryHint,
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
  const handleRefresh = useCallback(
    () => reportedManualRefresh(runRefresh, lastRefreshRef),
    [runRefresh]
  )
  return {
    handleRefresh,
    manualRefreshError
  }
}

export type ChecksPanelRefreshState = ReturnType<typeof useChecksPanelManualRefresh>
