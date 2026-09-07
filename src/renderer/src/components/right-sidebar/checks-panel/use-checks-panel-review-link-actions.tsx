import { useCallback, useLayoutEffect, useRef } from 'react'
import { openGitHubPRLinkModal } from '../github-pr-link-modal'
import type { ChecksPanelCheckAndReviewActionsInput } from './check-and-review-action-dependencies'
import { useUnlinkGitHubPullRequest } from './use-unlink-github-pull-request'

type RefreshLinkedGitHubPullRequest = (linkedPRNumber: number) => Promise<void>

export function useChecksPanelReviewLinkActions(
  model: ChecksPanelCheckAndReviewActionsInput,
  refreshLinkedGitHubPullRequest: RefreshLinkedGitHubPullRequest
) {
  const {
    activeReview,
    activeWorktree,
    activeWorktreeId,
    branch,
    fetchHostedReviewForBranch,
    linkedGitLabMR,
    linkedPR,
    localExecutionScope,
    openModal,
    repo,
    repoConnectionId,
    runtimeEnvironmentId,
    suppressedGitHubPR,
    updateWorktreeMeta
  } = model
  const reviewLinkScopeKey = JSON.stringify([
    repo?.id ?? null,
    repo?.path ?? null,
    activeWorktree?.id ?? null,
    activeWorktree?.path ?? null,
    branch,
    activeWorktree?.hostId ?? null,
    repo?.executionHostId ?? null,
    repoConnectionId,
    runtimeEnvironmentId,
    localExecutionScope
  ])
  const reviewLinkScopeKeyRef = useRef(reviewLinkScopeKey)
  const reviewLinkActionGenerationRef = useRef(0)
  useLayoutEffect(() => {
    reviewLinkScopeKeyRef.current = reviewLinkScopeKey
  }, [reviewLinkScopeKey])

  const unlinkGitHubPullRequest = useUnlinkGitHubPullRequest({
    activeReview,
    activeWorktree,
    activeWorktreeId,
    linkedPR,
    updateWorktreeMeta
  })

  const handleUnlinkReview = useCallback(() => {
    if (!activeWorktreeId || !activeWorktree || !activeReview) {
      return
    }
    reviewLinkActionGenerationRef.current += 1
    if (activeReview.provider === 'github') {
      void unlinkGitHubPullRequest()
      return
    }
    if (linkedGitLabMR === null) {
      return
    }
    void updateWorktreeMeta(
      activeWorktreeId,
      { linkedGitLabMR: null },
      { executionHostId: activeWorktree.hostId }
    )
  }, [
    activeReview,
    activeWorktree,
    activeWorktreeId,
    linkedGitLabMR,
    unlinkGitHubPullRequest,
    updateWorktreeMeta
  ])

  const openLinkPullRequestModal = useCallback(
    (currentPR: number) => {
      if (!activeWorktreeId || !activeWorktree) {
        return
      }
      const openedScopeKey = reviewLinkScopeKey
      openGitHubPRLinkModal({
        openModal,
        worktree: activeWorktree,
        worktreeId: activeWorktreeId,
        currentPR,
        suppressHostedReviewRefresh: true,
        afterLinked: async (linkedPRNumber) => {
          const actionGeneration = reviewLinkActionGenerationRef.current + 1
          reviewLinkActionGenerationRef.current = actionGeneration
          if (
            reviewLinkScopeKeyRef.current !== openedScopeKey ||
            reviewLinkActionGenerationRef.current !== actionGeneration
          ) {
            return
          }
          await refreshLinkedGitHubPullRequest(linkedPRNumber)
        }
      })
    },
    [
      activeWorktree,
      activeWorktreeId,
      openModal,
      refreshLinkedGitHubPullRequest,
      reviewLinkScopeKey
    ]
  )

  const handleLinkAnotherReview = useCallback(() => {
    if (!activeWorktreeId || !activeWorktree || !activeReview || !repo || !branch) {
      return
    }
    if (activeReview.provider === 'github') {
      openLinkPullRequestModal(activeWorktree.linkedPR ?? activeReview.number)
      return
    }
    const openedScopeKey = reviewLinkScopeKey
    openModal('edit-meta', {
      worktreeId: activeWorktreeId,
      // Why: the same workspace ID can exist under two hosts, so pin the dialog to its owner.
      repoId: activeWorktree.repoId,
      executionHostId: activeWorktree.hostId,
      currentDisplayName: activeWorktree.displayName,
      currentIssue: activeWorktree.linkedIssue,
      reviewProvider: 'gitlab',
      currentReview: activeWorktree.linkedGitLabMR ?? activeReview.number,
      currentComment: activeWorktree.comment,
      focus: 'pr',
      suppressHostedReviewRefresh: true,
      afterSave: async ({
        updates
      }: {
        updates?: { linkedPR?: unknown; linkedGitLabMR?: unknown }
      }) => {
        const actionGeneration = reviewLinkActionGenerationRef.current + 1
        reviewLinkActionGenerationRef.current = actionGeneration
        const isActionCurrent = (): boolean =>
          reviewLinkScopeKeyRef.current === openedScopeKey &&
          reviewLinkActionGenerationRef.current === actionGeneration
        if (!isActionCurrent()) {
          return
        }
        const nextMR = updates?.linkedGitLabMR
        if (typeof nextMR !== 'number') {
          return
        }
        await fetchHostedReviewForBranch(repo.path, branch, {
          repoId: repo.id,
          repoOwnerExecutionHostId: activeWorktree.hostId,
          linkedGitHubPR: null,
          linkedGitLabMR: nextMR,
          linkedBitbucketPR: null,
          linkedAzureDevOpsPR: null,
          linkedGiteaPR: null
        })
      }
    })
  }, [
    activeReview,
    activeWorktree,
    activeWorktreeId,
    branch,
    fetchHostedReviewForBranch,
    openModal,
    openLinkPullRequestModal,
    repo,
    reviewLinkScopeKey
  ])

  const handleLinkSuppressedPullRequest = useCallback(() => {
    if (linkedPR !== null || typeof suppressedGitHubPR !== 'number') {
      return
    }
    openLinkPullRequestModal(suppressedGitHubPR)
  }, [linkedPR, openLinkPullRequestModal, suppressedGitHubPR])

  return { handleUnlinkReview, handleLinkAnotherReview, handleLinkSuppressedPullRequest }
}
