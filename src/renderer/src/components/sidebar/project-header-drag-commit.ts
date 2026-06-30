import {
  applyAllRepoInsertAt,
  bucketKeyToProjectGroupId,
  getProjectGroupOrderForSidebarDrop,
  getProjectHeaderDragBucketKey,
  mapSidebarProjectHeaderDropIndexToSiblingInsertIndex,
  mapSidebarRepoDropIndexToAllRepoInsertAt
} from './project-header-drop'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import type { Repo } from '../../../../shared/types'

export function commitProjectHeaderDragDrop(args: {
  session: ProjectHeaderDragSession
  sidebarDropIndex: number
  targetBucketKey?: string
  sidebarRepoHeaderIdsByBucketAll?: ReadonlyMap<string, readonly string[]>
  orderedRepoIds: readonly string[]
  repoById: ReadonlyMap<string, Repo>
  usesProjectGroupOrdering: boolean
  onCommitRepoOrder: (orderedIds: string[]) => void
  onCommitProjectGroupOrder: (repoId: string, projectGroupId: string | null, order?: number) => void
}): void {
  const draggedRepo = args.repoById.get(args.session.repoId)
  if (!draggedRepo) {
    return
  }

  // Cross-bucket move: when the target bucket differs from the source, place the
  // dragged repo into the new group without touching same-bucket ordering logic.
  const sourceBucketKey = getProjectHeaderDragBucketKey(draggedRepo)

  if (
    args.usesProjectGroupOrdering &&
    args.targetBucketKey &&
    args.targetBucketKey !== sourceBucketKey
  ) {
    const targetGroupId = bucketKeyToProjectGroupId(args.targetBucketKey)
    const targetSiblings = (args.sidebarRepoHeaderIdsByBucketAll?.get(args.targetBucketKey) ?? [])
      .filter((repoId) => repoId !== args.session.repoId)
      .map((repoId) => args.repoById.get(repoId))
      .filter((repo): repo is Repo => repo !== undefined)
    // Why: a collapsed group has no visible sibling rects, so sidebarDropIndex
    // is 0 (front). Pass undefined instead so the store appends, matching the
    // context-menu "move to group" behaviour.
    if (targetSiblings.length === 0) {
      args.onCommitProjectGroupOrder(args.session.repoId, targetGroupId, undefined)
      return
    }
    const repoOrderRankById = new Map(
      args.orderedRepoIds.map((repoId, index) => [repoId, index] as const)
    )
    const insertIndex = Math.max(0, Math.min(targetSiblings.length, args.sidebarDropIndex))
    const order = getProjectGroupOrderForSidebarDrop({
      siblings: targetSiblings,
      dropIndex: insertIndex,
      repoOrderRankById
    })
    args.onCommitProjectGroupOrder(args.session.repoId, targetGroupId, order)
    return
  }

  const sidebarRepoHeaderIds = args.session.sidebarRepoHeaderIds
  const sourceIndex = sidebarRepoHeaderIds.indexOf(args.session.repoId)
  if (args.sidebarDropIndex === sourceIndex) {
    return
  }

  if (args.usesProjectGroupOrdering) {
    const siblings = sidebarRepoHeaderIds
      .filter((repoId) => repoId !== args.session.repoId)
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
    const repoOrderRankById = new Map(
      args.orderedRepoIds.map((repoId, index) => [repoId, index] as const)
    )
    const order = getProjectGroupOrderForSidebarDrop({
      siblings,
      dropIndex: siblingDropIndex,
      repoOrderRankById
    })
    args.onCommitProjectGroupOrder(args.session.repoId, draggedRepo.projectGroupId ?? null, order)
    return
  }

  const insertAt = mapSidebarRepoDropIndexToAllRepoInsertAt(
    args.sidebarDropIndex,
    sidebarRepoHeaderIds,
    args.orderedRepoIds
  )
  const next = applyAllRepoInsertAt(args.orderedRepoIds, args.session.repoId, insertAt)
  if (!next) {
    return
  }
  args.onCommitRepoOrder(next)
}
