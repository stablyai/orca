import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { useAppStore } from '@/store'
import { getGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import { issueCacheKey as getIssueCacheKey } from '@/store/slices/github'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getWorktreeCardPrDisplay,
  isCachedMergedBranchPRCurrentForWorktree
} from './worktree-card-pr-display'
import type { WorktreeCardProps } from './worktree-card-model'
import type { useWorktreeCardFoundation } from './use-worktree-card-foundation'

type Foundation = ReturnType<typeof useWorktreeCardFoundation>

export function useWorktreeCardReviewDetails({
  worktree,
  repo,
  settings,
  projectGroups,
  cardProps,
  newCardStyle
}: Pick<WorktreeCardProps, 'worktree' | 'repo'> &
  Pick<Foundation, 'settings' | 'projectGroups' | 'cardProps' | 'newCardStyle'>) {
  const gitIdentityDisplay = getWorktreeGitIdentityDisplay(worktree)
  const detachedHeadDisplay = gitIdentityDisplay?.kind === 'detached' ? gitIdentityDisplay : null
  const branch = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  const workspaceScope = parseWorkspaceKey(worktree.id)
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  const isFolder = repo ? isFolderRepo(repo) : folderWorkspaceId !== null
  // Why: project groups gate folder workspaces, so folder paths stay hidden from identity surfaces until that capability exists.
  const hasProjectGroups = projectGroups.length > 0
  const branchIdentityDisplay = !isFolder && branch.length > 0 ? branch : undefined
  const folderPathIdentityDisplay =
    isFolder && hasProjectGroups && worktree.path.trim().length > 0 ? worktree.path : undefined
  const identityDisplay = branchIdentityDisplay ?? folderPathIdentityDisplay
  const hasPathIdentityEnabled = cardProps.includes('branch')
  const showIdentityInNewCard = newCardStyle && hasPathIdentityEnabled && Boolean(identityDisplay)
  const folderMetaRowContent = newCardStyle
    ? hasPathIdentityEnabled && Boolean(folderPathIdentityDisplay)
    : isFolder
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
  const issueCacheKey =
    repo && worktree.linkedIssue
      ? getIssueCacheKey(
          repo.path,
          repo.id,
          worktree.linkedIssue,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  // Why: use 'all' — the issue may belong to a different Linear workspace than the selected one.
  const linearIssueCacheKey = worktree.linkedLinearIssue ? `all::${worktree.linkedLinearIssue}` : ''

  // Subscribe to ONLY the specific cache entry, not entire review/issue caches.
  const hostedReviewEntry = useAppStore((s) =>
    hostedReviewCacheKey ? s.hostedReviewCache[hostedReviewCacheKey] : undefined
  )
  const prCacheEntry = useAppStore((s) => (prCacheKey ? s.prCache?.[prCacheKey] : undefined))
  const issueEntry = useAppStore((s) => (issueCacheKey ? s.issueCache[issueCacheKey] : undefined))
  const linearIssueEntry = useAppStore((s) =>
    linearIssueCacheKey ? s.linearIssueCache[linearIssueCacheKey] : undefined
  )
  const linearIssueFallbackEntry = useAppStore((s) =>
    worktree.linkedLinearIssue ? s.linearIssueCache[worktree.linkedLinearIssue] : undefined
  )

  const hostedReview: HostedReviewInfo | null | undefined =
    hostedReviewEntry !== undefined ? hostedReviewEntry.data : undefined
  const linkedGitHubPR = worktree.linkedPR ?? null
  const linkedGitLabMR = worktree.linkedGitLabMR ?? null
  const linkedBitbucketPR = worktree.linkedBitbucketPR ?? null
  const linkedAzureDevOpsPR = worktree.linkedAzureDevOpsPR ?? null
  const linkedGiteaPR = worktree.linkedGiteaPR ?? null
  const hasNonGitHubLinkedReview =
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  const hasLinkedReview =
    linkedGitHubPR !== null ||
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  // Why: a newer hosted-review miss trusts the merged-PR cache only when the stored head proves it still describes the current commit.
  const cachedBranchPR = prCacheEntry?.data
  const cachedBranchPRFetchedAt = prCacheEntry?.fetchedAt
  const cachedMergedBranchPRMatchesCurrentHead = isCachedMergedBranchPRCurrentForWorktree(
    cachedBranchPR,
    worktree
  )
  const cachedBranchFallbackGitHubPRNumber =
    linkedGitHubPR === null &&
    !hasNonGitHubLinkedReview &&
    cachedBranchPR?.number !== undefined &&
    (cachedBranchPR.state !== 'merged' || cachedMergedBranchPRMatchesCurrentHead)
      ? cachedBranchPR.number
      : null
  const cachedBranchPRCanDriveDisplay =
    cachedBranchPR?.state !== 'merged' || cachedMergedBranchPRMatchesCurrentHead
  const hostedReviewMatchesHeadMatchedCachedMergedPR =
    cachedMergedBranchPRMatchesCurrentHead &&
    cachedBranchPR !== null &&
    cachedBranchPR !== undefined &&
    hostedReview?.provider === 'github' &&
    hostedReview.number === cachedBranchPR.number
  const useCachedBranchReview =
    cachedBranchPR !== undefined &&
    cachedBranchPR !== null &&
    !hasNonGitHubLinkedReview &&
    cachedBranchPRCanDriveDisplay &&
    (hostedReview === undefined ||
      (cachedMergedBranchPRMatchesCurrentHead && !hostedReviewMatchesHeadMatchedCachedMergedPR) ||
      (hostedReview === null &&
        ((cachedBranchPRFetchedAt !== undefined &&
          cachedBranchPRFetchedAt > (hostedReviewEntry?.fetchedAt ?? 0)) ||
          cachedMergedBranchPRMatchesCurrentHead)))
  const cachedBranchReview = useCachedBranchReview
    ? hostedReviewInfoFromGitHubPRInfo(cachedBranchPR)
    : hostedReview
  // Why: branch provenance does not supersede the head-ownership gate for merged PRs.
  const branchLookupGitHubPRNumber =
    hostedReview?.provider === 'github' &&
    hostedReview.state === 'merged' &&
    !isCachedMergedBranchPRCurrentForWorktree(hostedReview, worktree)
      ? null
      : hostedReviewEntry?.branchLookupGitHubPRNumber
  const prDisplay = getWorktreeCardPrDisplay(
    cachedBranchReview,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    {
      reviewHintKey:
        (useCachedBranchReview || cachedMergedBranchPRMatchesCurrentHead) && !hasLinkedReview
          ? ''
          : hostedReviewEntry?.linkedReviewHintKey,
      branchLookupGitHubPRNumber
    }
  )

  return {
    detachedHeadDisplay,
    branch,
    folderWorkspaceId,
    isFolder,
    branchIdentityDisplay,
    folderPathIdentityDisplay,
    identityDisplay,
    showIdentityInNewCard,
    folderMetaRowContent,
    hostedReviewCacheKey,
    issueCacheKey,
    issueEntry,
    linearIssueEntry,
    linearIssueFallbackEntry,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    cachedBranchFallbackGitHubPRNumber,
    prDisplay
  }
}
