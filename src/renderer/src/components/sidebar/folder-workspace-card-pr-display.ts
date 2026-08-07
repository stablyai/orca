import type { AppState } from '@/store/types'
import type {
  FolderWorkspace,
  Repo,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage
} from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { projectResolvedWorkspaceLineage } from '../../../../shared/workspace-lineage-projection'
import {
  buildParentPrChecksRows,
  type ParentPrChecksRow
} from '@/components/right-sidebar/parent-pr-checks-rows'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { getProjectedWorktreeLineageChildrenByParentId } from './worktree-lineage-projection'

type FolderWorkspaceCardPrDisplayArgs = {
  folderWorkspaceId: string
  folderWorkspaces: readonly FolderWorkspace[]
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
  folderWorkspaces,
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
    folderWorkspaces,
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
  folderWorkspaces,
  workspaceLineageByChildKey,
  worktreeLineageById,
  worktreeMap
}: Pick<
  FolderWorkspaceCardPrDisplayArgs,
  | 'folderWorkspaceId'
  | 'folderWorkspaces'
  | 'workspaceLineageByChildKey'
  | 'worktreeLineageById'
  | 'worktreeMap'
>): Worktree[] {
  const folderKey = folderWorkspaceKey(folderWorkspaceId)
  const directChildren: Worktree[] = projectResolvedWorkspaceLineage(
    [...worktreeMap.values()],
    folderWorkspaces,
    workspaceLineageByChildKey ?? {}
  ).filter(
    (worktree) =>
      !worktree.isArchived && worktree.workspaceLineage?.parentWorkspaceKey === folderKey
  )

  const included = new Map(directChildren.map((worktree) => [worktree.id, worktree]))
  const childrenByParentId = getProjectedWorktreeLineageChildrenByParentId(
    worktreeLineageById ?? {},
    worktreeMap
  )
  const queue = [...directChildren]
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of childrenByParentId.get(queue[index].id) ?? []) {
      if (child.isArchived || included.has(child.id)) {
        continue
      }
      included.set(child.id, child)
      queue.push(child)
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

function compareReviewDisplays(left: WorktreeCardPrDisplay, right: WorktreeCardPrDisplay): number {
  return getReviewDisplayPriority(left) - getReviewDisplayPriority(right)
}

function getReviewDisplayPriority(review: WorktreeCardPrDisplay): number {
  return review.status ? REVIEW_STATUS_PRIORITY[review.status] : 4
}
