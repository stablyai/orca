import type { AppState } from '@/store/types'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import { branchName } from '@/lib/git-utils'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type {
  PRInfo,
  Repo,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage
} from '../../../../shared/types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getWorktreeCardPrDisplay, type WorktreeCardPrDisplay } from './worktree-card-pr-display'

type HostedReviewCacheEntry = {
  data?: HostedReviewInfo | null
  linkedReviewHintKey?: string
}

type PrCacheEntry = {
  data?: PRInfo | null
}

type FolderWorkspaceCardPrDisplayArgs = {
  folderWorkspaceId: string
  workspaceLineageByChildKey: Record<string, WorkspaceLineage> | null | undefined
  worktreeLineageById: Record<string, WorktreeLineage> | null | undefined
  worktreeMap: ReadonlyMap<string, Worktree>
  repoMap: ReadonlyMap<string, Repo>
  hostedReviewCache: Record<string, unknown> | null
  prCache: Record<string, unknown> | null
  settings?: AppState['settings']
}

const REVIEW_STATUS_PRIORITY: Record<NonNullable<WorktreeCardPrDisplay['status']>, number> = {
  failure: 0,
  pending: 1,
  success: 2,
  neutral: 3
}

export function getFolderWorkspaceCardPrDisplay({
  folderWorkspaceId,
  workspaceLineageByChildKey,
  worktreeLineageById,
  worktreeMap,
  repoMap,
  hostedReviewCache,
  prCache,
  settings
}: FolderWorkspaceCardPrDisplayArgs): WorktreeCardPrDisplay | null {
  const reviews = getAttachedWorktreesForFolderWorkspaceCard({
    folderWorkspaceId,
    workspaceLineageByChildKey,
    worktreeLineageById,
    worktreeMap
  })
    .map((worktree) =>
      getAttachedWorktreePrDisplay({
        worktree,
        repo: repoMap.get(worktree.repoId),
        hostedReviewCache,
        prCache,
        settings
      })
    )
    .filter((review): review is WorktreeCardPrDisplay => review !== null)

  if (reviews.length === 0) {
    return null
  }

  return reviews.sort(compareReviewDisplays)[0] ?? null
}

function getAttachedWorktreesForFolderWorkspaceCard({
  folderWorkspaceId,
  workspaceLineageByChildKey,
  worktreeLineageById,
  worktreeMap
}: Pick<
  FolderWorkspaceCardPrDisplayArgs,
  'folderWorkspaceId' | 'workspaceLineageByChildKey' | 'worktreeLineageById' | 'worktreeMap'
>): Worktree[] {
  const folderKey = folderWorkspaceKey(folderWorkspaceId)
  const directChildren = Object.values(workspaceLineageByChildKey ?? {})
    .filter((lineage) => lineage.parentWorkspaceKey === folderKey)
    .map((lineage) => getWorkspaceLineageChild(lineage, worktreeMap))
    .filter((worktree): worktree is Worktree => worktree !== null)

  const included = new Map(directChildren.map((worktree) => [worktree.id, worktree]))
  let added = true

  while (added) {
    added = false
    for (const lineage of Object.values(worktreeLineageById ?? {})) {
      if (included.has(lineage.worktreeId) || !included.has(lineage.parentWorktreeId)) {
        continue
      }
      const parent = worktreeMap.get(lineage.parentWorktreeId)
      const child = worktreeMap.get(lineage.worktreeId)
      if (!isCurrentLineagePair(parent, child, lineage)) {
        continue
      }
      included.set(child.id, child)
      added = true
    }
  }

  return [...included.values()]
}

function getWorkspaceLineageChild(
  lineage: WorkspaceLineage,
  worktreeMap: ReadonlyMap<string, Worktree>
): Worktree | null {
  const childScope = parseWorkspaceKey(lineage.childWorkspaceKey)
  if (childScope?.type !== 'worktree') {
    return null
  }
  const worktree = worktreeMap.get(childScope.worktreeId)
  if (!worktree || worktree.isArchived) {
    return null
  }
  if (lineage.childInstanceId && lineage.childInstanceId !== worktree.instanceId) {
    return null
  }
  return worktree
}

function isCurrentLineagePair(
  parent: Worktree | undefined,
  child: Worktree | undefined,
  lineage: WorktreeLineage
): child is Worktree {
  return Boolean(
    parent &&
    child &&
    !parent.isArchived &&
    !child.isArchived &&
    child.instanceId === lineage.worktreeInstanceId &&
    parent.instanceId === lineage.parentWorktreeInstanceId
  )
}

function getAttachedWorktreePrDisplay({
  worktree,
  repo,
  hostedReviewCache,
  prCache,
  settings
}: {
  worktree: Worktree
  repo: Repo | undefined
  hostedReviewCache: Record<string, unknown> | null
  prCache: Record<string, unknown> | null
  settings?: AppState['settings']
}): WorktreeCardPrDisplay | null {
  if (!repo) {
    return null
  }

  const branch = branchName(worktree.branch).trim()
  if (!branch) {
    return getLinkedReviewDisplay(worktree)
  }

  const hostedReviewCacheKey = getHostedReviewCacheKey(
    repo.path,
    branch,
    settings,
    repo.id,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  const hostedReviewEntry = hostedReviewCache?.[hostedReviewCacheKey] as
    | HostedReviewCacheEntry
    | undefined
  const hostedReviewDisplay = hostedReviewEntry
    ? getWorktreeCardPrDisplay(
        hostedReviewEntry.data,
        worktree.linkedPR,
        worktree.linkedGitLabMR ?? null,
        worktree.linkedBitbucketPR ?? null,
        worktree.linkedAzureDevOpsPR ?? null,
        worktree.linkedGiteaPR ?? null,
        { reviewHintKey: hostedReviewEntry.linkedReviewHintKey }
      )
    : null
  if (hostedReviewDisplay) {
    return hostedReviewDisplay
  }

  const cachedGitHubPr = getCachedGitHubPr({ worktree, repo, branch, prCache, settings })
  if (cachedGitHubPr) {
    return {
      provider: 'github',
      number: cachedGitHubPr.number,
      title: cachedGitHubPr.title,
      state: cachedGitHubPr.state,
      url: cachedGitHubPr.url,
      status: cachedGitHubPr.checksStatus
    }
  }

  return getLinkedReviewDisplay(worktree)
}

function getLinkedReviewDisplay(worktree: Worktree): WorktreeCardPrDisplay | null {
  return getWorktreeCardPrDisplay(
    undefined,
    worktree.linkedPR,
    worktree.linkedGitLabMR ?? null,
    worktree.linkedBitbucketPR ?? null,
    worktree.linkedAzureDevOpsPR ?? null,
    worktree.linkedGiteaPR ?? null
  )
}

function getCachedGitHubPr({
  worktree,
  repo,
  branch,
  prCache,
  settings
}: {
  worktree: Worktree
  repo: Repo
  branch: string
  prCache: Record<string, unknown> | null
  settings?: AppState['settings']
}): PRInfo | null {
  if (!prCache || worktree.linkedPR === null) {
    return null
  }

  const cacheKey = getGitHubPRCacheKey(
    repo.path,
    repo.id,
    branch,
    settings,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  const canUseLegacyPRCache = !repo.connectionId && !repo.executionHostId
  const legacyRepoScopedCacheKey = canUseLegacyPRCache
    ? getLegacyGitHubPRCacheKey(repo.path, repo.id, branch)
    : ''
  const legacyPathScopedCacheKey = canUseLegacyPRCache
    ? getLegacyGitHubPRCacheKey(repo.path, undefined, branch)
    : ''
  const entry =
    (prCache[cacheKey] as PrCacheEntry | undefined) ??
    (legacyRepoScopedCacheKey
      ? (prCache[legacyRepoScopedCacheKey] as PrCacheEntry | undefined)
      : undefined) ??
    (legacyPathScopedCacheKey
      ? (prCache[legacyPathScopedCacheKey] as PrCacheEntry | undefined)
      : undefined)
  const pr = entry?.data ?? null
  return pr?.number === worktree.linkedPR ? pr : null
}

function compareReviewDisplays(left: WorktreeCardPrDisplay, right: WorktreeCardPrDisplay): number {
  return getReviewDisplayPriority(left) - getReviewDisplayPriority(right)
}

function getReviewDisplayPriority(review: WorktreeCardPrDisplay): number {
  return review.status ? REVIEW_STATUS_PRIORITY[review.status] : 4
}
