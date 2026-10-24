import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildParentPrChecksRows } from '@/components/right-sidebar/parent-pr-checks-rows'
import type { ParentPrChecksRow } from '@/components/right-sidebar/parent-pr-checks-row-types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { getWorktreeLineageDescendants } from '../../../../shared/sidebar-list/worktree-lineage-projection'

type FolderWorkspaceCardPrDisplayArgs = {
  folderWorktree: Worktree
  worktreeLineageById: Record<string, WorktreeLineage>
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
  folderWorktree,
  worktreeLineageById,
  worktreeMap,
  repoMap,
  hostedReviewCache,
  prCache,
  settings
}: FolderWorkspaceCardPrDisplayArgs): WorktreeCardPrDisplay | null {
  const attachedWorktrees = getWorktreeLineageDescendants(
    folderWorktree,
    worktreeLineageById,
    worktreeMap
  )

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
