import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'
import React, { useCallback, useEffect, useRef } from 'react'
import { ENTRY_REFRESH_GRACE_MS, shouldEntryRefresh } from '../checks-entry-refresh'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import { toast } from 'sonner'

import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import type { ChecksPanelPollingState } from './use-checks-panel-polling'
import type { ChecksPanelReviewDataState } from './use-checks-panel-review-data'
import { codeHostErrorText } from '@/lib/code-host-error-copy'

type ChecksPanelEntryRefreshAndTitleActionsInput = Pick<
  ChecksPanelContextState,
  | 'activeGitLabReview'
  | 'activeReview'
  | 'clearTitleInputFocusTimer'
  | 'fallbackGitHubPRNumber'
  | 'hostedReviewCacheKey'
  | 'isFolder'
  | 'isGitLabReviewContext'
  | 'linkedAzureDevOpsPR'
  | 'linkedBitbucketPR'
  | 'linkedGiteaPR'
  | 'linkedGitLabMR'
  | 'linkedPR'
  | 'pr'
  | 'prCacheKey'
  | 'prNumber'
> &
  Pick<
    ChecksPanelControllerState,
    | 'activeWorktree'
    | 'activeWorktreeId'
    | 'branch'
    | 'enqueueGitHubPRRefresh'
    | 'fetchHostedReviewForBranch'
    | 'fetchPRForBranch'
    | 'isPanelVisible'
    | 'mountedRef'
    | 'pollIntervalRef'
    | 'prevChecksRef'
    | 'repo'
    | 'setEditingTitle'
    | 'setTitleDraft'
    | 'setTitleSaving'
    | 'titleDraft'
    | 'titleInputFocusTimerRef'
    | 'titleInputRef'
  > &
  Pick<ChecksPanelReviewState, 'checksFetchedAt' | 'commentsFetchedAt' | 'prFetchedAt'> &
  Pick<ChecksPanelPollingState, 'fetchChecks' | 'fetchGitLabDetails'> &
  Pick<ChecksPanelReviewDataState, 'fetchComments'>

export function useChecksPanelEntryRefreshAndTitleActions(
  model: ChecksPanelEntryRefreshAndTitleActionsInput
) {
  const {
    activeGitLabReview,
    activeReview,
    activeWorktree,
    activeWorktreeId,
    branch,
    checksFetchedAt,
    clearTitleInputFocusTimer,
    commentsFetchedAt,
    enqueueGitHubPRRefresh,
    fallbackGitHubPRNumber,
    fetchChecks,
    fetchComments,
    fetchGitLabDetails,
    fetchHostedReviewForBranch,
    fetchPRForBranch,
    hostedReviewCacheKey,
    isFolder,
    isGitLabReviewContext,
    isPanelVisible,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    linkedPR,
    mountedRef,
    pollIntervalRef,
    pr,
    prCacheKey,
    prFetchedAt,
    prNumber,
    prevChecksRef,
    repo,
    setEditingTitle,
    setTitleDraft,
    setTitleSaving,
    titleDraft,
    titleInputFocusTimerRef,
    titleInputRef
  } = model
  const handleEntryRefresh = useCallback(
    (options: { refreshChecks: boolean; refreshComments: boolean }) => {
      if (!repo || !branch || !activeWorktreeId) {
        return
      }
      // Tab entry is automatic: preserve rate-limit guards and force only panes already known stale.
      if (isGitLabReviewContext) {
        void fetchHostedReviewForBranch(repo.path, branch, {
          force: true,
          repoId: repo.id,
          linkedGitHubPR: linkedPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          currentHeadOid: activeWorktree?.head ?? null,
          linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR,
          linkedGiteaPR
        })
        // Entering the tab is a user act: it may start a stopped WSL distro (E9).
        if (activeGitLabReview) {
          void fetchGitLabDetails()
        }
        return
      }
      enqueueGitHubPRRefresh(activeWorktreeId, 'active', 80)
      if (options.refreshChecks) {
        void fetchChecks({ force: true, wakeWslDistro: true })
      }
      if (options.refreshComments) {
        void fetchComments({ force: true })
      }
    },
    [
      activeGitLabReview,
      activeWorktree?.head,
      activeWorktreeId,
      branch,
      enqueueGitHubPRRefresh,
      fallbackGitHubPRNumber,
      fetchChecks,
      fetchComments,
      fetchGitLabDetails,
      fetchHostedReviewForBranch,
      isGitLabReviewContext,
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGiteaPR,
      linkedGitLabMR,
      linkedPR,
      repo
    ]
  )

  // Check freshness on tab entry to catch external changes before TTL expiry; see docs/refresh-on-checks-tab.md.
  const entryKey =
    isPanelVisible && repo && !isFolder && branch
      ? `${activeWorktreeId ?? ''}::${activeGitLabReview ? hostedReviewCacheKey : prCacheKey}`
      : ''
  const lastEntryKeyRef = useRef<string>('')
  useEffect(() => {
    if (!entryKey) {
      // Reset on hide so closing/reopening the same PR still reevaluates freshness.
      lastEntryKeyRef.current = ''
      return
    }
    if (lastEntryKeyRef.current === entryKey) {
      return
    }
    lastEntryKeyRef.current = entryKey

    const now = Date.now()
    const stale = shouldEntryRefresh({
      prFetchedAt,
      checksFetchedAt,
      commentsFetchedAt,
      prNumber,
      now,
      graceMs: ENTRY_REFRESH_GRACE_MS
    })
    if (!stale) {
      return
    }
    const cutoff = now - ENTRY_REFRESH_GRACE_MS
    const refreshChecks =
      prNumber !== null && (checksFetchedAt === undefined || checksFetchedAt < cutoff)
    const refreshComments =
      prNumber !== null && (commentsFetchedAt === undefined || commentsFetchedAt < cutoff)

    // Reset the previous PR's backoff so this forced fetch establishes its own baseline.
    pollIntervalRef.current = 30_000
    prevChecksRef.current = ''
    handleEntryRefresh({ refreshChecks, refreshComments })
  }, [
    entryKey,
    prFetchedAt,
    checksFetchedAt,
    commentsFetchedAt,
    prNumber,
    handleEntryRefresh,
    pollIntervalRef,
    prevChecksRef
  ])

  const refreshHostedReviewAfterMutation = useCallback(async () => {
    if (!repo || !branch) {
      return
    }
    // The read must start after the write rather than join an older poll; its failure is not the write's.
    if (activeReview?.provider === 'gitlab') {
      const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        userRefresh: true,
        linkedGitHubPR: linkedPR,
        fallbackGitHubPR: fallbackGitHubPRNumber,
        linkedGitLabMR,
        linkedBitbucketPR,
        linkedAzureDevOpsPR,
        linkedGiteaPR
      }).catch(() => null)
      const refreshedGitLabReview =
        refreshedReview?.provider === 'gitlab' ? refreshedReview : activeGitLabReview
      if (refreshedGitLabReview) {
        await fetchGitLabDetails({
          mrNumberOverride: refreshedGitLabReview.number,
          headShaOverride: refreshedGitLabReview.headSha,
          commitAsCurrent: true
        })
      }
      return
    }
    const refreshedPR = await fetchPRForBranch(repo.path, branch, {
      force: true,
      repoId: repo.id,
      worktreeId: activeWorktreeId ?? undefined,
      linkedPRNumber: linkedPR,
      fallbackPRNumber: fallbackGitHubPRNumber
    })
    await refreshHostedReviewCard(fetchHostedReviewForBranch, {
      repoPath: repo.path,
      repoId: repo.id,
      branch,
      userRefresh: true,
      linkedGitHubPR: linkedPR,
      fallbackGitHubPR: refreshedPR?.number ?? fallbackGitHubPRNumber,
      linkedGitLabMR,
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR
    }).catch(() => null)
  }, [
    activeGitLabReview,
    activeReview?.provider,
    activeWorktreeId,
    branch,
    fallbackGitHubPRNumber,
    fetchGitLabDetails,
    fetchHostedReviewForBranch,
    fetchPRForBranch,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    linkedPR,
    repo
  ])

  const handleStartEdit = useCallback(() => {
    if (!activeReview) {
      return
    }
    setTitleDraft(activeReview.title)
    setEditingTitle(true)
    clearTitleInputFocusTimer()
    titleInputFocusTimerRef.current = setTimeout(() => {
      titleInputFocusTimerRef.current = null
      titleInputRef.current?.focus()
    }, 0)
  }, [
    activeReview,
    clearTitleInputFocusTimer,
    setEditingTitle,
    titleInputFocusTimerRef,
    setTitleDraft,
    titleInputRef.current
  ])

  const handleCancelEdit = useCallback(() => {
    clearTitleInputFocusTimer()
    setEditingTitle(false)
    setTitleDraft('')
  }, [clearTitleInputFocusTimer, setEditingTitle, setTitleDraft])

  const handleSaveTitle = useCallback(async () => {
    const nextTitle = titleDraft.trim()
    if (!repo || !activeReview || !nextTitle || nextTitle === activeReview.title) {
      clearTitleInputFocusTimer()
      setEditingTitle(false)
      return
    }
    setTitleSaving(true)
    try {
      if (activeReview.provider === 'gitlab') {
        const selector = {
          repoPath: repo.path,
          repoId: repo.id,
          repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(repo, activeWorktree)
        }
        const result = await gitLabApiFor(selector).updateMR({
          ...selector,
          iid: activeReview.number,
          updates: { title: nextTitle }
        })
        if (!result.ok) {
          toast.error(codeHostErrorText(result))
          return
        }
        await refreshHostedReviewAfterMutation()
      } else {
        if (!pr) {
          return
        }
        const ok = await window.api.gh.updatePRTitle({
          repoPath: repo.path,
          repoId: repo.id,
          prNumber: pr.number,
          title: nextTitle,
          prRepo: pr.prRepo ?? null
        })
        if (ok) {
          await refreshHostedReviewAfterMutation()
        }
      }
    } finally {
      clearTitleInputFocusTimer()
      if (mountedRef.current) {
        setTitleSaving(false)
        setEditingTitle(false)
      }
    }
  }, [
    activeReview,
    activeWorktree,
    repo,
    pr,
    titleDraft,
    refreshHostedReviewAfterMutation,
    clearTitleInputFocusTimer,
    mountedRef,
    setEditingTitle,
    setTitleSaving
  ])

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void handleSaveTitle()
      } else if (e.key === 'Escape') {
        handleCancelEdit()
      }
    },
    [handleSaveTitle, handleCancelEdit]
  )
  return {
    refreshHostedReviewAfterMutation,
    handleStartEdit,
    handleCancelEdit,
    handleSaveTitle,
    handleTitleKeyDown
  }
}

export type ChecksPanelEntryRefreshAndTitleActionsState = ReturnType<
  typeof useChecksPanelEntryRefreshAndTitleActions
>
