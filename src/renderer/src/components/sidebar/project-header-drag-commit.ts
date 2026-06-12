import {
  applyAllRepoInsertAt,
  getProjectGroupOrderForSidebarDrop,
  mapSidebarProjectHeaderDropIndexToSiblingInsertIndex,
  mapSidebarRepoDropIndexToAllRepoInsertAt
} from './project-header-drop'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import type { Repo } from '../../../../shared/types'

export function commitProjectHeaderDragDrop(args: {
  session: ProjectHeaderDragSession
  sidebarDropIndex: number
  orderedRepoIds: readonly string[]
  repoById: ReadonlyMap<string, Repo>
  usesProjectGroupOrdering: boolean
  onCommitRepoOrder: (orderedIds: string[]) => void
  onCommitProjectGroupOrder: (repoId: string, projectGroupId: string | null, order: number) => void
}): void {
  const draggedRepo = args.repoById.get(args.session.repoId)
  if (!draggedRepo) {
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
    if (siblingDropIndex === sourceIndex) {
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
