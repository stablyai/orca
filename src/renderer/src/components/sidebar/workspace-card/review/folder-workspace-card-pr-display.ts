import { getProviderChecksOutcome } from '../../../../../../shared/source-control/checks/provider-check-summary'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { buildParentPrChecksRows } from '@/components/right-sidebar/hosted-review/folder-checks/parent-pr-checks-rows'
import type { ParentPrChecksRow } from '@/components/right-sidebar/hosted-review/folder-checks/parent-pr-checks-row-types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { getFolderWorkspaceChildWorktrees } from '../../../../../../shared/folder-workspace-child-worktrees'

type FolderWorkspaceCardPrDisplayArgs = {
  /** The folder workspace's host identity (getFolderWorkspaceHostIdentity). */
  folderIdentity: string
  /** selectSidebarChildrenByParentIdentity */
  childrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]>
  repoMap: ReadonlyMap<string, Repo>
  hostedReviewCache: AppState['hostedReviewCache'] | null
  prCache: AppState['prCache'] | null
  settings?: AppState['settings']
}

const REVIEW_STATUS_PRIORITY: Record<string, number> = {
  failure: 0,
  pending: 1,
  cancelled: 2,
  success: 3,
  neutral: 4
}

export function getFolderWorkspaceCardPrDisplay({
  folderIdentity,
  childrenByParentIdentity,
  repoMap,
  hostedReviewCache,
  prCache,
  settings
}: FolderWorkspaceCardPrDisplayArgs): WorktreeCardPrDisplay | null {
  const { childWorktrees, lineageChildrenByParentIdentity } = getFolderWorkspaceChildWorktrees(
    folderIdentity,
    childrenByParentIdentity
  )
  const attachedWorktrees = [
    ...childWorktrees,
    ...[...lineageChildrenByParentIdentity.values()].flat()
  ]

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
    status: row.checkTone === 'cancelled' ? 'failure' : row.checkTone,
    // Review attention tones must not be reinterpreted as check outcomes.
    checksSummary: ['failing', 'pending', 'cancelled', 'success', 'neutral'].includes(row.status)
      ? row.checksSummary
      : undefined
  }
}

function compareReviewDisplays(left: WorktreeCardPrDisplay, right: WorktreeCardPrDisplay): number {
  return getReviewDisplayPriority(left) - getReviewDisplayPriority(right)
}

function getReviewDisplayPriority(review: WorktreeCardPrDisplay): number {
  return review.status
    ? (REVIEW_STATUS_PRIORITY[getProviderChecksOutcome(review.checksSummary, review.status)] ?? 4)
    : 5
}
