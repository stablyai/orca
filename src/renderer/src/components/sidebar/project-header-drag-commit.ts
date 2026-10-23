import { getLogicalRepoOrderRankById } from '../../../../shared/project-section-order'
import {
  applyAllRepoInsertAt,
  getProjectHeaderDragBucketKey,
  getProjectGroupOrderForSidebarDrop,
  mapSidebarProjectHeaderDropIndexToSiblingInsertIndex,
  mapSidebarRepoDropIndexToAllRepoInsertAt
} from './project-header-drop'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import type { Repo } from '../../../../shared/repo-types'
import { isSameRepoRow } from '@/store/slices/repo-host-identity'

export function commitProjectHeaderDragDrop(args: {
  session: ProjectHeaderDragSession
  sidebarDropIndex: number
  orderedRepoIds: readonly string[]
  repoById: ReadonlyMap<string, Repo>
  liveRepos: readonly Repo[]
  usesProjectGroupOrdering: boolean
  onCommitRepoOrder: (orderedIds: string[]) => void
  onCommitProjectGroupOrder: (project: Repo, projectGroupId: string | null, order: number) => void
}): void {
  const draggedRepo = args.liveRepos.find((repo) => isSameRepoRow(repo, args.session.repo))
  // Why: a group change mid-drag (another window or client) moved the row out of this bucket.
  if (!draggedRepo || getProjectHeaderDragBucketKey(draggedRepo) !== args.session.bucketKey) {
    return
  }

  const sidebarRepoHeaderIds = args.session.sidebarRepoHeaderIds
  const sourceIndex = sidebarRepoHeaderIds.indexOf(draggedRepo.id)
  // Why: both slots bordering the dragged header are visual no-ops. In
  // particular, do not compact paired-host occurrences on an unchanged drop.
  if (
    sourceIndex === -1 ||
    args.sidebarDropIndex === sourceIndex ||
    args.sidebarDropIndex === sourceIndex + 1
  ) {
    return
  }

  if (args.usesProjectGroupOrdering) {
    const siblings = sidebarRepoHeaderIds
      .filter((repoId) => repoId !== draggedRepo.id)
      .map((repoId) => args.repoById.get(repoId))
      .filter((repo): repo is Repo => repo !== undefined)
    const siblingDropIndex = mapSidebarProjectHeaderDropIndexToSiblingInsertIndex({
      sidebarDropIndex: args.sidebarDropIndex,
      sourceIndex,
      siblingCount: siblings.length
    })
    // Why: sourceIndex is the position in the original array (including the
    // dragged item), but siblingDropIndex is the position in the filtered
    // array. The equivalent position in the filtered array is the sourceIndex
    // capped at siblings.length (since removing an item can only shift indices
    // down by 1 when the removed item was before the insertion point).
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
