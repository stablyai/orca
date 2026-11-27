import { useState } from 'react'
import { getWorkspaceAttachmentSourceContext } from '../review/workspace-attachment-source-result'
import { getWorkspaceReferenceLinearWorkspaceId } from '../review/workspace-reference-details'
import { getWorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/row-display/git-identity-display'
import { useAppStore } from '@/store'
import { issueCacheKey as getIssueCacheKey } from '@/store/github/cache/cache-identity'
import { isFolderRepo } from '../../../../../../shared/repository/repo-kind'
import {
  areTaskSourceContextsEqual,
  getTaskSourceCacheScope
} from '../../../../../../shared/work-items/task-source-context'
import { parseWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { getWorktreeGitHubIssueRepository } from '../../../../../../shared/worktree/github-issue-repository'
import {
  getWorktreeCardReviewCacheKeys,
  resolveWorktreeCardReview
} from '../review/worktree-card-review-resolution'
import type { WorktreeCardProps } from '../controller/worktree-card-model'
import type { useWorktreeCardFoundation } from '../controller/use-worktree-card-foundation'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
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
  const { hostedReviewCacheKey, prCacheKey } = getWorktreeCardReviewCacheKeys(
    worktree,
    repo,
    settings
  )
  const issueCacheKey =
    repo && worktree.linkedIssue
      ? getIssueCacheKey(
          repo.path,
          repo.id,
          worktree.linkedIssue,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true,
          getWorktreeGitHubIssueRepository(worktree)
        )
      : ''
  // Saved workspace bindings keep equal Linear identifiers separate.
  const nextLinearSourceContext = getWorkspaceAttachmentSourceContext('linear', repo, worktree)
  // Preserve equal source-context identity so metadata writes do not retrigger Linear fetches.
  const [linearSourceContext, setLinearSourceContext] = useState(nextLinearSourceContext)
  if (!areTaskSourceContextsEqual(linearSourceContext, nextLinearSourceContext)) {
    setLinearSourceContext(nextLinearSourceContext)
  }
  const linearWorkspaceId = getWorkspaceReferenceLinearWorkspaceId(
    worktree.linkedLinearIssueWorkspaceId,
    linearSourceContext
  )
  const linearCachePrefix = linearSourceContext
    ? getTaskSourceCacheScope(linearSourceContext)
    : null
  const linearIssueCacheKey = worktree.linkedLinearIssue
    ? linearCachePrefix
      ? `${linearCachePrefix}::${linearWorkspaceId}::${worktree.linkedLinearIssue}`
      : `${linearWorkspaceId}::${worktree.linkedLinearIssue}`
    : ''

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
    !linearSourceContext && worktree.linkedLinearIssue
      ? s.linearIssueCache[worktree.linkedLinearIssue]
      : undefined
  )

  const {
    linkedGitHubPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    cachedBranchFallbackGitHubPRNumber,
    prDisplay
  } = resolveWorktreeCardReview(worktree, hostedReviewEntry, prCacheEntry, t)

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
    linearSourceContext,
    linearWorkspaceId,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    cachedBranchFallbackGitHubPRNumber,
    prDisplay
  }
}
