import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { isFolderRepo } from '../../../../../shared/repo-kind'
import { getGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { selectReviewCacheEntry } from '../review-cache-entry-selection'
import { selectChecksPanelReview, type ChecksPanelReview } from '../checks-panel-review'
import { isGitLabChecksPanelReview } from './gitlab-review-client'
import { clearPendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import {
  buildGitHubPRRefreshStateClearToken,
  getGitHubPRRefreshStateExpiryAt
} from '@/store/github/pr-refresh-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import { recordChecksPanelPRRefreshBreadcrumb } from '../checks-panel-pr-refresh-breadcrumb'
import { isChecksPanelHardRefreshErrorType } from '../checks-panel-review-creation'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { PRRefreshErrorType } from '../../../../../shared/github/pull-request-refresh-types'

type ChecksPanelContextStateInput = Pick<
  ChecksPanelControllerState,
  | 'activeWorktree'
  | 'activeWorktreeId'
  | 'branch'
  | 'claimedCommentResolutionRef'
  | 'commentResolutionLaunchAcceptedRef'
  | 'conflictSummaryRefreshKeyRef'
  | 'createPrInFlightRef'
  | 'isPanelVisible'
  | 'panelContextKey'
  | 'panelContextKeyRef'
  | 'panelVisibleSinceRef'
  | 'pendingCommentResolutionRef'
  | 'pollIntervalRef'
  | 'prevChecksRef'
  | 'refreshContextKeyRef'
  | 'refreshInFlightRef'
  | 'refreshRequestKeyRef'
  | 'repo'
  | 'settings'
  | 'setAgentComposerState'
  | 'setChecks'
  | 'setChecksLoading'
  | 'setCommentResolutionAckBusyNow'
  | 'setComments'
  | 'setCommentsLoading'
  | 'setConflictDetailsRefreshing'
  | 'setCreatePrError'
  | 'setEditingTitle'
  | 'setEmptyRefreshing'
  | 'setGitStatusProbeErrorContextKey'
  | 'setGitStatusRefreshNonce'
  | 'setGitStatusSnapshot'
  | 'setHardRefreshError'
  | 'setHostedReviewCreationSnapshot'
  | 'setIsCreatingPr'
  | 'setIsPublishingBranch'
  | 'setIsRefreshing'
  | 'setTitleDraft'
  | 'setTitleSaving'
  | 'titleInputFocusTimerRef'
  | 'gitStatusSnapshotRetryTimerRef'
>

export function useChecksPanelContextState(model: ChecksPanelContextStateInput) {
  const {
    activeWorktree,
    activeWorktreeId,
    branch,
    claimedCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    conflictSummaryRefreshKeyRef,
    createPrInFlightRef,
    isPanelVisible,
    panelContextKey,
    panelContextKeyRef,
    panelVisibleSinceRef,
    pendingCommentResolutionRef,
    pollIntervalRef,
    prevChecksRef,
    refreshContextKeyRef,
    refreshInFlightRef,
    refreshRequestKeyRef,
    repo,
    settings,
    setAgentComposerState,
    setChecks,
    setChecksLoading,
    setCommentResolutionAckBusyNow,
    setComments,
    setCommentsLoading,
    setConflictDetailsRefreshing,
    setCreatePrError,
    setEditingTitle,
    setEmptyRefreshing,
    setGitStatusProbeErrorContextKey,
    setGitStatusRefreshNonce,
    setGitStatusSnapshot,
    setHardRefreshError,
    setHostedReviewCreationSnapshot,
    setIsCreatingPr,
    setIsPublishingBranch,
    setIsRefreshing,
    setTitleDraft,
    setTitleSaving,
    titleInputFocusTimerRef,
    gitStatusSnapshotRetryTimerRef
  } = model
  const clearTitleInputFocusTimer = useCallback((): void => {
    if (titleInputFocusTimerRef.current !== null) {
      clearTimeout(titleInputFocusTimerRef.current)
      titleInputFocusTimerRef.current = null
    }
  }, [titleInputFocusTimerRef])

  const setChecksPanelContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) {
        clearTitleInputFocusTimer()
      }
    },
    [clearTitleInputFocusTimer]
  )

  // Why: no key={worktreeId} remount (caused an IPC storm on Windows); reset branch-specific state during render (not useEffect) so it lands on the same paint.
  const [prevPanelContextKey, setPrevPanelContextKey] = useState(panelContextKey)
  const [prRefreshStateNow, setPrRefreshStateNow] = useState(() => Date.now())
  if (panelContextKey !== prevPanelContextKey) {
    setPrevPanelContextKey(panelContextKey)
    setEditingTitle(false)
    setTitleDraft('')
    setTitleSaving(false)
    clearTitleInputFocusTimer()
    setChecks([])
    setChecksLoading(false)
    setComments([])
    setCommentsLoading(false)
    setIsRefreshing(false)
    setEmptyRefreshing(false)
    setConflictDetailsRefreshing(false)
    setPrRefreshStateNow(Date.now())
    createPrInFlightRef.current = null
    setIsCreatingPr(false)
    setCreatePrError(null)
    setIsPublishingBranch(false)
    setAgentComposerState(null)
    // Why: an accepted launch owns its snapshotted payload; only unaccepted queues drop here.
    // Ref clears run in the panelContextKey effect below (React render must stay pure).
    if (!commentResolutionLaunchAcceptedRef.current) {
      setCommentResolutionAckBusyNow(false)
      clearPendingPRCommentAiAck()
    }
    setHostedReviewCreationSnapshot(null)
    setHardRefreshError(null)
    setGitStatusSnapshot(null)
    setGitStatusProbeErrorContextKey(null)
    setGitStatusRefreshNonce((value) => value + 1)
    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    conflictSummaryRefreshKeyRef.current = null
    refreshInFlightRef.current = false
    refreshRequestKeyRef.current = null
    if (gitStatusSnapshotRetryTimerRef.current) {
      clearTimeout(gitStatusSnapshotRetryTimerRef.current)
      gitStatusSnapshotRetryTimerRef.current = null
    }
  }

  const isFolder = repo ? isFolderRepo(repo) : false
  const prCacheKey =
    repo && branch
      ? getGitHubPRCacheKey(
          repo.path,
          repo.id,
          branch,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const hostedReviewCacheKey =
    repo && branch
      ? getHostedReviewCacheKey(
          repo.path,
          branch,
          settings,
          repo.id,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const refreshContextKey = `${activeWorktreeId ?? ''}::${prCacheKey}::${branch}`
  if (refreshContextKey !== refreshContextKeyRef.current) {
    refreshContextKeyRef.current = refreshContextKey
    refreshRequestKeyRef.current = null
  }
  // Why: background PR refreshes replace the cache map; Checks only renders the entry for the active repo and branch.
  const prCacheEntry = useAppStore((s) => selectReviewCacheEntry(s.prCache, prCacheKey || null))
  const pr: PRInfo | null = prCacheEntry?.data ?? null
  const prCachedHasPR = prCacheEntry ? prCacheEntry.data !== null : null
  const hostedReview = useAppStore((s) =>
    hostedReviewCacheKey ? (s.hostedReviewCache[hostedReviewCacheKey]?.data ?? null) : null
  )
  const linkedReviewNumber =
    activeWorktree?.linkedPR ??
    activeWorktree?.linkedGitLabMR ??
    activeWorktree?.linkedBitbucketPR ??
    activeWorktree?.linkedAzureDevOpsPR ??
    activeWorktree?.linkedGiteaPR ??
    null
  // Why: branch lookup is lossy for fork/deleted-head PRs; reuse a known PR number from metadata or cache whenever we have one.
  const linkedPR = activeWorktree?.linkedPR ?? null
  const fallbackGitHubPRNumber = linkedPR == null ? (pr?.number ?? null) : null
  const linkedGitLabMR = activeWorktree?.linkedGitLabMR ?? null
  const linkedBitbucketPR = activeWorktree?.linkedBitbucketPR ?? null
  const linkedAzureDevOpsPR = activeWorktree?.linkedAzureDevOpsPR ?? null
  const linkedGiteaPR = activeWorktree?.linkedGiteaPR ?? null
  const activeReview: ChecksPanelReview | null = selectChecksPanelReview({
    hostedReview,
    pr,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR
  })
  const activeGitLabReview = isGitLabChecksPanelReview(activeReview) ? activeReview : null
  const isGitLabReviewContext = Boolean(activeGitLabReview || linkedGitLabMR !== null)
  const activeConflictReview = activeReview?.mergeable === 'CONFLICTING' ? activeReview : null
  const prRefreshState = useAppStore((s) =>
    prCacheKey ? s.getEffectiveGitHubPRRefreshState(prCacheKey, prRefreshStateNow) : undefined
  )
  const rawPRRefreshState = useAppStore((s) =>
    prCacheKey ? s.prRefreshStates[prCacheKey] : undefined
  )
  const prNumber = pr?.number ?? null

  useEffect(() => {
    const expiryAt = getGitHubPRRefreshStateExpiryAt(rawPRRefreshState)
    if (!prCacheKey || expiryAt === null) {
      return
    }
    const timeout = window.setTimeout(
      () => {
        setPrRefreshStateNow(Date.now())
        const storeState = useAppStore.getState()
        const rawState = storeState.prRefreshStates[prCacheKey]
        const token = buildGitHubPRRefreshStateClearToken(
          rawState,
          storeState.prRefreshSequences,
          prCacheKey
        )
        if (!token) {
          return
        }
        // Why: time alone doesn't publish Zustand updates; this timeout clears abandoned refresh UI without treating expiry as no-PR evidence.
        recordChecksPanelPRRefreshBreadcrumb({
          event: 'stale_cleared',
          provider: 'github',
          repoId: repo?.id,
          worktreeId: activeWorktreeId,
          branch,
          prCacheKey,
          prNumber,
          prState: pr?.state,
          prChecksStatus: pr?.checksStatus,
          refreshState: rawState
        })
        storeState.expireGitHubPRRefreshState(prCacheKey, token)
      },
      Math.max(0, expiryAt - Date.now() + 1)
    )
    return () => window.clearTimeout(timeout)
  }, [
    activeWorktreeId,
    branch,
    pr?.checksStatus,
    pr?.state,
    prCacheKey,
    prNumber,
    rawPRRefreshState,
    repo?.id
  ])

  useEffect(() => {
    if (!isPanelVisible) {
      panelVisibleSinceRef.current = null
      return
    }
    panelVisibleSinceRef.current = Date.now()
  }, [isPanelVisible, panelContextKey, panelVisibleSinceRef])

  // Why: drop unaccepted launch payloads when the panel switches context (refs stay pure in render).
  useEffect(() => {
    if (commentResolutionLaunchAcceptedRef.current) {
      return
    }
    pendingCommentResolutionRef.current = null
    claimedCommentResolutionRef.current = null
  }, [
    panelContextKey,
    claimedCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    pendingCommentResolutionRef
  ])

  // Record the latest hard refresh error, kept sticky so a background auto-retry can't silently re-enable Create while lookup is impossible.
  useEffect(() => {
    const errorType = prRefreshState?.status === 'error' ? prRefreshState.errorType : undefined
    if (!isChecksPanelHardRefreshErrorType(errorType)) {
      return
    }
    const observedAt = prRefreshState?.updatedAt ?? Date.now()
    const contextKey = panelContextKeyRef.current
    setHardRefreshError((prev) => {
      if (prev && prev.contextKey === contextKey && prev.observedAt >= observedAt) {
        return prev
      }
      return { observedAt, errorType: errorType as PRRefreshErrorType, contextKey }
    })
  }, [prRefreshState, setHardRefreshError, panelContextKeyRef])
  return {
    clearTitleInputFocusTimer,
    setChecksPanelContentRef,
    prevPanelContextKey,
    prRefreshStateNow,
    setPrRefreshStateNow,
    isFolder,
    prCacheKey,
    hostedReviewCacheKey,
    refreshContextKey,
    prCacheEntry,
    pr,
    prCachedHasPR,
    hostedReview,
    linkedReviewNumber,
    linkedPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    activeReview,
    activeGitLabReview,
    isGitLabReviewContext,
    activeConflictReview,
    prRefreshState,
    rawPRRefreshState,
    prNumber
  }
}

export type ChecksPanelContextState = ReturnType<typeof useChecksPanelContextState>
