import { getLogicalRepoOrderRankById } from '../../../../../../shared/sidebar-list/sections/project-section-order'
import {
  applyAllRepoInsertAt,
  getProjectHeaderDragBucketKey,
  getProjectGroupOrderForSidebarDrop,
  mapSidebarProjectHeaderDropIndexToSiblingInsertIndex,
  mapSidebarRepoDropIndexToAllRepoInsertAt
} from './project-header-drop'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import type { RootProjectHeaderDrag } from './root-project-header-drop'
import {
  commitProjectHeaderGroupMove,
  type ProjectHeaderDrop,
  type ProjectHeaderGroupMove
} from './project-header-group-move'

export function commitProjectHeaderDragDrop(
  args: RootProjectHeaderDrag & {
    session: ProjectHeaderDragSession
    drop: ProjectHeaderDrop
    groupMove: ProjectHeaderGroupMove | undefined
    orderedRepoIds: readonly string[]
    repoById: ReadonlyMap<string, Repo>
    liveRepos: readonly Repo[]
    usesProjectGroupOrdering: boolean
    onCommitRepoOrder: (orderedIds: string[]) => void
    onCommitProjectGroupOrder: (
      project: Repo,
      projectGroupId: string | null,
      order?: number
    ) => void
  }
): void {
  const { drop } = args
  if (drop.kind !== 'reorder') {
    if (args.groupMove) {
      commitProjectHeaderGroupMove({ ...args, drop, groupMove: args.groupMove })
    }
    return
  }
  const sidebarDropIndex = drop.dropIndex
  if (args.session.rootProjectHeaderKeys) {
    args.onCommitRootProjectOrder?.(
      args.session.rootProjectHeaderKeys,
      `repo:${args.session.repo.id}`,
      sidebarDropIndex
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
    sidebarDropIndex === sourceIndex ||
    sidebarDropIndex === sourceIndex + 1
  ) {
    return
  }

  if (args.usesProjectGroupOrdering) {
    const siblings = sidebarRepoHeaderIds
      .filter((repoId) => repoId !== draggedRepo.id)
      .map((repoId) => args.repoById.get(repoId))
      .filter((repo): repo is Repo => repo !== undefined)
    const siblingDropIndex = mapSidebarProjectHeaderDropIndexToSiblingInsertIndex({
      sidebarDropIndex,
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
    sidebarDropIndex,
    sidebarRepoHeaderIds,
    args.orderedRepoIds
  )
  const next = applyAllRepoInsertAt(args.orderedRepoIds, draggedRepo.id, insertAt)
  if (!next) {
    return
  }
  args.onCommitRepoOrder(next)
}
