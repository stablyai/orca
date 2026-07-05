import type { AppState } from '@/store/types'
import type { Repo, Worktree, WorktreeLineage, WorkspaceLineage } from '../../../../shared/types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  buildParentPrChecksRows,
  type ParentPrChecksRow
} from '@/components/right-sidebar/parent-pr-checks-rows'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

type FolderWorkspaceCardPrDisplayArgs = {
  folderWorkspaceId: string
  workspaceLineageByChildKey: Record<string, WorkspaceLineage> | null | undefined
  worktreeLineageById: Record<string, WorktreeLineage> | null | undefined
  worktreeMap: ReadonlyMap<string, Worktree>
  repoMap: ReadonlyMap<string, Repo>
  hostedReviewCache: AppState['hostedReviewCache'] | null
  prCache: AppState['prCache'] | null
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
  const attachedWorktrees = getAttachedWorktreesForFolderWorkspaceCard({
    folderWorkspaceId,
    workspaceLineageByChildKey,
    worktreeLineageById,
    worktreeMap
  })

  const reviews = buildParentPrChecksRows({
    worktrees: attachedWorktrees,
    repoById: repoMap,
    settings: settings ?? null,
    hostedReviewCache: hostedReviewCache ?? {},
    prCache: prCache ?? {},
    // Folder cards only need the compact status icon; avoid check-detail cache fanout.
    checksCache: {}
  })
    .map(parentPrChecksRowToCardDisplay)
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

function parentPrChecksRowToCardDisplay(row: ParentPrChecksRow): WorktreeCardPrDisplay | null {
  if (!row.provider || row.provider === 'unsupported' || row.reviewNumber === null) {
    return null
  }
  return {
    provider: row.provider,
    number: row.reviewNumber,
    title: row.title,
    ...(row.reviewState ? { state: row.reviewState } : {}),
    ...(row.reviewUrl ? { url: row.reviewUrl } : {}),
    status: row.checkTone
  }
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

function compareReviewDisplays(left: WorktreeCardPrDisplay, right: WorktreeCardPrDisplay): number {
  return getReviewDisplayPriority(left) - getReviewDisplayPriority(right)
}

function getReviewDisplayPriority(review: WorktreeCardPrDisplay): number {
  return review.status ? REVIEW_STATUS_PRIORITY[review.status] : 4
}
