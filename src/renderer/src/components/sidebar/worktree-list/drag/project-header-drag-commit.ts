import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
import {
  applyAllRepoInsertAt,
  getProjectHeaderDragBucketKey,
  getProjectGroupOrderForSidebarDrop,
  mapSidebarProjectHeaderDropIndexToSiblingInsertIndex,
  mapSidebarRepoDropIndexToAllRepoInsertAt
} from './project-header-drop'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import type { Repo } from '../../../../../../shared/repo-types'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import type { RootProjectHeaderDrag } from './root-project-header-drop'

export function commitProjectHeaderDragDrop(
  args: RootProjectHeaderDrag & {
    session: Pick<
      ProjectHeaderDragSession,
      'repo' | 'bucketKey' | 'sidebarRepoHeaderIds' | 'rootProjectHeaderKeys'
    >
    sidebarDropIndex: number
    orderedRepoIds: readonly string[]
    repoById: ReadonlyMap<string, Repo>
    liveRepos: readonly Repo[]
    usesProjectGroupOrdering: boolean
    onCommitRepoOrder: (orderedIds: string[]) => void
    onCommitProjectGroupOrder: (project: Repo, projectGroupId: string | null, order: number) => void
  }
): void {
  if (args.session.rootProjectHeaderKeys) {
    args.onCommitRootProjectOrder?.(
      args.session.rootProjectHeaderKeys,
      `repo:${args.session.repo.id}`,
      args.sidebarDropIndex
    )
    return
  }
  const draggedRepo = args.liveRepos.find((repo) => isSameRepoRow(repo, args.session.repo))
  // Why: a group change mid-drag (another window or client) moved the row out of this bucket.
  if (!draggedRepo || getProjectHeaderDragBucketKey(draggedRepo) !== args.session.bucketKey) {
    return
  }

  const sidebarRepoHeaderIds = args.session.sidebarRepoHeaderIds
  const sourceIndex = sidebarRepoHeaderIds.indexOf(draggedRepo.id)
  // Both slots beside the dragged header are no-ops; do not compact paired-host occurrences.
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
