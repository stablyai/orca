import { getLogicalRepoOrderRankById } from '../../../../shared/project-section-order'
import {
  applyAllRepoInsertAt,
  getProjectHeaderDragBucketKey,
  getProjectGroupOrderForSidebarDrop,
  mapSidebarProjectHeaderDropIndexToSiblingInsertIndex,
  type RepoHeaderRow,
  mapSidebarRepoDropIndexToAllRepoInsertAt
} from './project-header-drop'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import type { Repo } from '../../../../shared/repo-types'
import { isSameRepoRow } from '@/store/slices/repo-host-identity'

export function commitProjectHeaderDragDrop(args: {
  session: ProjectHeaderDragSession
  sidebarDropIndex: number
  orderedRepoIds: readonly string[]
  liveRepos: readonly Repo[]
  currentBuckets?: ReadonlyMap<string, readonly string[]>
  currentRepoHeaderRowsByBucket?: ReadonlyMap<string, readonly RepoHeaderRow[]>
  usesProjectGroupOrdering: boolean
  onCommitRepoOrder: (orderedIds: string[]) => void
  onCommitProjectGroupOrder: (project: Repo, projectGroupId: string | null, order: number) => void
}): void {
  const draggedRepo = args.liveRepos.find((repo) => isSameRepoRow(repo, args.session.repo))
  // Why: a group change mid-drag (another window or client) moved the row out of this bucket.
  if (
    !draggedRepo ||
    getProjectHeaderDragBucketKey(draggedRepo) !==
      (args.session.membershipBucketKey ?? args.session.bucketKey)
  ) {
    return
  }

  const currentBucket = args.currentBuckets?.get(args.session.bucketKey)
  if (args.currentBuckets && (!currentBucket || !currentBucket.includes(draggedRepo.id))) {
    return
  }
  const sidebarRepoHeaderIds = currentBucket ?? args.session.sidebarRepoHeaderIds
  const currentHeaders = args.currentRepoHeaderRowsByBucket?.get(args.session.bucketKey)
  const sourceIndex = args.usesProjectGroupOrdering
    ? (currentHeaders?.findIndex((row) => isSameRepoRow(row.repo, draggedRepo)) ?? -1)
    : sidebarRepoHeaderIds.indexOf(draggedRepo.id)
  // Both slots beside the dragged header are no-ops; do not compact paired-host occurrences.
  if (
    sourceIndex === -1 ||
    args.sidebarDropIndex === sourceIndex ||
    args.sidebarDropIndex === sourceIndex + 1
  ) {
    return
  }

  if (args.usesProjectGroupOrdering) {
    if (
      !currentHeaders ||
      currentHeaders.length !== sidebarRepoHeaderIds.length ||
      currentHeaders.some((row, index) => row.repo.id !== sidebarRepoHeaderIds[index])
    ) {
      return
    }
    const siblings = currentHeaders
      .filter((_, index) => index !== sourceIndex)
      .map((row) => row.repo)
    const siblingDropIndex = mapSidebarProjectHeaderDropIndexToSiblingInsertIndex({
      sidebarDropIndex: args.sidebarDropIndex,
      sourceIndex,
      siblingCount: siblings.length
    })
    // The original source slot is capped by the shorter sibling list after removing the dragged item.
    const sourceIndexInSiblings = Math.min(sourceIndex, siblings.length)
    if (siblingDropIndex === sourceIndexInSiblings) {
      return
    }
    const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds)
    const order = getProjectGroupOrderForSidebarDrop({
      siblings,
      dropIndex: siblingDropIndex,
      repoOrderRankById
    })
    args.onCommitProjectGroupOrder(draggedRepo, draggedRepo.projectGroupId ?? null, order)
    return
  }

  const insertAt = mapSidebarRepoDropIndexToAllRepoInsertAt(
    args.sidebarDropIndex,
    sidebarRepoHeaderIds,
    args.orderedRepoIds
  )
  const next = applyAllRepoInsertAt(args.orderedRepoIds, draggedRepo.id, insertAt)
  if (!next) {
    return
  }
  args.onCommitRepoOrder(next)
}
