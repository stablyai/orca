import { useEffect } from 'react'
import { resolveChecksPanelPRRefreshRequest } from '../checks-panel-pr-refresh-request'
import {
  shouldCoalesceChecksPanelGitStatusSnapshotRefresh,
  shouldPollChecksPanelRuntimeSshStatus
} from '../checks-panel-git-status-snapshot'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'

type ChecksPanelForegroundEffectsInput = Pick<
  ChecksPanelControllerState,
  | 'activeWorktree'
  | 'activeWorktreeId'
  | 'branch'
  | 'enqueueGitHubPRRefresh'
  | 'fetchHostedReviewForBranch'
  | 'foregroundedUnrenderedReviewKeyRef'
  | 'gitStatusSnapshotInFlightContextRef'
  | 'gitStatusSnapshotRerunContextRef'
  | 'isPanelVisible'
  | 'panelContextKeyRef'
  | 'panelVisibleSinceRef'
  | 'repo'
  | 'repoConnectionId'
  | 'runtimeEnvironmentId'
  | 'setGitStatusRefreshNonce'
> &
  Pick<
    ChecksPanelContextState,
    | 'fallbackGitHubPRNumber'
    | 'isFolder'
    | 'linkedAzureDevOpsPR'
    | 'linkedBitbucketPR'
    | 'linkedGiteaPR'
    | 'linkedGitLabMR'
    | 'linkedPR'
    | 'prCachedHasPR'
  > &
  Pick<
    ChecksPanelReviewState,
    'foregroundReviewEvidenceKey' | 'isGitHubReviewContext' | 'prFetchedAt'
  >

const RUNTIME_SSH_STATUS_REFRESH_MS = 3000

export function useChecksPanelForegroundEffects(model: ChecksPanelForegroundEffectsInput) {
  const {
    activeWorktree,
    activeWorktreeId,
    branch,
    enqueueGitHubPRRefresh,
    fallbackGitHubPRNumber,
    fetchHostedReviewForBranch,
    foregroundReviewEvidenceKey,
    foregroundedUnrenderedReviewKeyRef,
    gitStatusSnapshotInFlightContextRef,
    gitStatusSnapshotRerunContextRef,
    isFolder,
    isGitHubReviewContext,
    isPanelVisible,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    linkedPR,
    panelContextKeyRef,
    panelVisibleSinceRef,
    prCachedHasPR,
    prFetchedAt,
    repo,
    repoConnectionId,
    runtimeEnvironmentId,
    setGitStatusRefreshNonce
  } = model
  useEffect(() => {
    if (foregroundReviewEvidenceKey === null || !isPanelVisible) {
      foregroundedUnrenderedReviewKeyRef.current = null
    }
    if (isPanelVisible && repo && !isFolder && branch) {
      void fetchHostedReviewForBranch(repo.path, branch, {
        repoId: repo.id,
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: fallbackGitHubPRNumber,
        currentHeadOid: activeWorktree?.head ?? null,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR,
        staleWhileRevalidate: true,
        // Why: this panel only ever renders the selected worktree, so it earns
        // the host's fast re-check tier (#11532).
        active: true
      })
      // Why: the gh-based refresh coordinator is GitHub-only; running it elsewhere gave a spurious gh_unavailable error hiding a valid composer.
      if (activeWorktreeId && isGitHubReviewContext) {
        const refreshRequest = resolveChecksPanelPRRefreshRequest({
          cachedHasPR: prCachedHasPR,
          cachedFetchedAt: prFetchedAt ?? null,
          panelVisibleSince: panelVisibleSinceRef.current,
          hasUnrenderedReviewEvidence: foregroundReviewEvidenceKey !== null,
          hasRequestedForegroundRefresh:
            foregroundReviewEvidenceKey !== null &&
            foregroundedUnrenderedReviewKeyRef.current === foregroundReviewEvidenceKey
        })
        if (refreshRequest.reason === 'active' && foregroundReviewEvidenceKey !== null) {
          foregroundedUnrenderedReviewKeyRef.current = foregroundReviewEvidenceKey
        }
        enqueueGitHubPRRefresh(activeWorktreeId, refreshRequest.reason, refreshRequest.priority)
      }
    }
  }, [
    activeWorktreeId,
    branch,
    enqueueGitHubPRRefresh,
    fallbackGitHubPRNumber,
    fetchHostedReviewForBranch,
    foregroundReviewEvidenceKey,
    isFolder,
    isGitHubReviewContext,
    isPanelVisible,
    activeWorktree?.head,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    linkedPR,
    prCachedHasPR,
    prFetchedAt,
    repo,
    panelVisibleSinceRef,
    foregroundedUnrenderedReviewKeyRef
  ])

  useEffect(() => {
    if (
      !shouldPollChecksPanelRuntimeSshStatus({
        isPanelVisible,
        runtimeEnvironmentId,
        repoConnectionId
      })
    ) {
      return undefined
    }
    let skippedInitialRun = false
    return installWindowVisibilityInterval({
      run: () => {
        if (!skippedInitialRun) {
          skippedInitialRun = true
          return
        }
        const currentContextKey = panelContextKeyRef.current
        if (
          shouldCoalesceChecksPanelGitStatusSnapshotRefresh(
            gitStatusSnapshotInFlightContextRef.current,
            currentContextKey
          )
        ) {
          gitStatusSnapshotRerunContextRef.current = currentContextKey
          return
        }
        setGitStatusRefreshNonce((value) => value + 1)
      },
      intervalMs: RUNTIME_SSH_STATUS_REFRESH_MS
    })
  }, [
    isPanelVisible,
    repoConnectionId,
    runtimeEnvironmentId,
    gitStatusSnapshotInFlightContextRef,
    gitStatusSnapshotRerunContextRef,
    setGitStatusRefreshNonce,
    panelContextKeyRef
  ])
}
