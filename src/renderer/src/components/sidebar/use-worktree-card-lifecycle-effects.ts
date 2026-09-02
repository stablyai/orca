import { useEffect } from 'react'

import { isMacAppDataPath } from '@/lib/passive-macos-app-data-access'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import {
  HOSTED_REVIEW_CARD_REFRESH_INTERVAL_MS,
  isWebClient,
  type WorktreeCardProps
} from './worktree-card-model'
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
  // Why: card surfaces are presentational, so skip hosted-review fetches when hidden to save rate-limit budget.
  useEffect(() => {
    // Why: paired web must not fan out per-card decoration RPCs during startup; host session/tab parity is critical.
    if (isWebClient()) {
      return
    }
    if (
      !repo ||
      isFolder ||
      worktree.isBare ||
      !hostedReviewCacheKey ||
      !shouldRefreshHostedReview ||
      isMacAppDataPath(repo.path)
    ) {
      return
    }
    const refreshHostedReview = (): void => {
      // Why: branch lookup is lossy for fork/deleted-head PRs; reuse a known PR number from explicit metadata when we have one.
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
    }
    // Why: PRs created outside Orca (e.g. `gh pr create`) emit no renderer event; poll visible cards to discover them.
    return installWindowVisibilityInterval({
      run: refreshHostedReview,
      jitterOnVisible: true,
      intervalMs: HOSTED_REVIEW_CARD_REFRESH_INTERVAL_MS
    })
  }, [
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
    hostedReviewCacheKey,
    shouldRefreshHostedReview
  ])

  useEffect(() => {
    if (
      !newCardStyle ||
      !hoverDetailsOpen ||
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

    // Why: fallback poll behind activity triggers; stopped while hidden to avoid waking idle workspaces.
    return installWindowVisibilityInterval({
      run: () => void fetchIssue(repo.path, issueNumber, { repoId: repo.id }),
      intervalMs: 5 * 60_000
    })
  }, [repo, isFolder, worktree.linkedIssue, fetchIssue, issueCacheKey, showIssue])

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
    void fetchIssue(repo.path, worktree.linkedIssue, { repoId: repo.id })
  }, [
    newCardStyle,
    hoverDetailsOpen,
    showIssue,
    repo,
    isFolder,
    worktree.linkedIssue,
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
