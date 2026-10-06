import { useEffect, useMemo } from 'react'

import { isMacAppDataPath } from '@/lib/passive-macos-app-data-access'
import { getWorktreeGitHubIssueRepository } from '../../../../shared/worktree/github-issue-repository'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import { isWebClient, type WorktreeCardProps } from './worktree-card-model'
import type { useWorktreeCardFoundation } from './use-worktree-card-foundation'
import type { useWorktreeCardReviewDetails } from './use-worktree-card-review-details'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>
type ReviewDetails = ReturnType<typeof useWorktreeCardReviewDetails>

export function useWorktreeCardLifecycleEffects({
  worktree,
  repo,
  isFolder,
  hostedReviewCacheKey,
  cachedBranchFallbackGitHubPRNumber,
  linkedGitLabMR,
  linkedBitbucketPR,
  linkedAzureDevOpsPR,
  linkedGiteaPR,
  branch,
  fetchHostedReviewForBranch,
  shouldRefreshHostedReview,
  newCardStyle,
  hoverDetailsOpen,
  showIssue,
  issueCacheKey,
  fetchIssue,
  showLinearIssue,
  fetchLinearIssue
}: Pick<WorktreeCardProps, 'worktree' | 'repo'> &
  Pick<
    ReviewDetails,
    | 'isFolder'
    | 'hostedReviewCacheKey'
    | 'cachedBranchFallbackGitHubPRNumber'
    | 'linkedGitLabMR'
    | 'linkedBitbucketPR'
    | 'linkedAzureDevOpsPR'
    | 'linkedGiteaPR'
    | 'branch'
    | 'issueCacheKey'
  > &
  Pick<
    Foundation,
    'fetchHostedReviewForBranch' | 'newCardStyle' | 'fetchIssue' | 'fetchLinearIssue'
  > & {
    shouldRefreshHostedReview: boolean
    hoverDetailsOpen: boolean
    showIssue: boolean
    showLinearIssue: boolean
  }): void {
  const { linkedIssue, linkedWorkItem } = worktree
  const issueRepository = useMemo(
    () => getWorktreeGitHubIssueRepository({ linkedIssue, linkedWorkItem }),
    [linkedIssue, linkedWorkItem]
  )
  useEffect(() => {
    if (
      !newCardStyle ||
      !hoverDetailsOpen ||
      !isWindowVisible() ||
      shouldRefreshHostedReview ||
      isWebClient() ||
      !repo ||
      isFolder ||
      worktree.isBare ||
      !hostedReviewCacheKey ||
      isMacAppDataPath(repo.path)
    ) {
      return
    }
    // Why: hidden card metadata is revealed on whole-card hover, so fetch lazily instead of always-on polling.
    void fetchHostedReviewForBranch(repo.path, branch, {
      repoId: repo.id,
      linkedGitHubPR: worktree.linkedPR ?? null,
      ...(cachedBranchFallbackGitHubPRNumber !== null
        ? { fallbackGitHubPR: cachedBranchFallbackGitHubPRNumber }
        : {}),
      currentHeadOid: worktree.head ?? null,
      linkedGitLabMR,
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR,
      staleWhileRevalidate: true
    })
  }, [
    hoverDetailsOpen,
    newCardStyle,
    shouldRefreshHostedReview,
    repo,
    isFolder,
    worktree.isBare,
    worktree.linkedPR,
    worktree.head,
    cachedBranchFallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    fetchHostedReviewForBranch,
    branch,
    hostedReviewCacheKey
  ])

  // Why: same as above for issues — hidden-surface polling only burns GitHub calls for invisible data.
  useEffect(() => {
    // Why: per-card decoration lookups from the browser flood the RPC path at paired-web startup; the host is authoritative.
    if (
      isWebClient() ||
      !repo ||
      isFolder ||
      !worktree.linkedIssue ||
      !issueCacheKey ||
      !showIssue
    ) {
      return
    }

    const issueNumber = worktree.linkedIssue
    const ownerRepo = issueRepository

    // Why: fallback poll behind activity triggers; stopped while hidden to avoid waking idle workspaces.
    return installWindowVisibilityInterval({
      run: () =>
        void fetchIssue(repo.path, issueNumber, {
          repoId: repo.id,
          ...(ownerRepo ? { ownerRepo } : {})
        }),
      intervalMs: 5 * 60_000
    })
  }, [repo, isFolder, worktree.linkedIssue, issueRepository, fetchIssue, issueCacheKey, showIssue])

  useEffect(() => {
    if (
      !newCardStyle ||
      !hoverDetailsOpen ||
      showIssue ||
      isWebClient() ||
      !repo ||
      isFolder ||
      !worktree.linkedIssue ||
      !issueCacheKey
    ) {
      return
    }
    const ownerRepo = issueRepository
    void fetchIssue(repo.path, worktree.linkedIssue, {
      repoId: repo.id,
      ...(ownerRepo ? { ownerRepo } : {})
    })
  }, [
    newCardStyle,
    hoverDetailsOpen,
    showIssue,
    repo,
    isFolder,
    worktree.linkedIssue,
    issueRepository,
    fetchIssue,
    issueCacheKey
  ])

  useEffect(() => {
    if (!worktree.linkedLinearIssue || !showLinearIssue) {
      return
    }
    const linearIssueId = worktree.linkedLinearIssue
    const refreshLinearIssueIfVisible = (): void => {
      if (!isWindowVisible()) {
        return
      }
      void fetchLinearIssue(linearIssueId, 'all')
    }
    refreshLinearIssueIfVisible()
    window.addEventListener('focus', refreshLinearIssueIfVisible)
    document.addEventListener('visibilitychange', refreshLinearIssueIfVisible)
    return () => {
      window.removeEventListener('focus', refreshLinearIssueIfVisible)
      document.removeEventListener('visibilitychange', refreshLinearIssueIfVisible)
    }
  }, [worktree.linkedLinearIssue, fetchLinearIssue, showLinearIssue])

  useEffect(() => {
    if (!newCardStyle || !hoverDetailsOpen || showLinearIssue || !worktree.linkedLinearIssue) {
      return
    }
    void fetchLinearIssue(worktree.linkedLinearIssue, 'all')
  }, [
    newCardStyle,
    hoverDetailsOpen,
    showLinearIssue,
    worktree.linkedLinearIssue,
    fetchLinearIssue
  ])
}
