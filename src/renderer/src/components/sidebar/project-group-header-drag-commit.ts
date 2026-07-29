import { getProjectGroupTabOrderUpdatesForSidebarDrop } from './project-group-header-drop'
import type { ProjectGroupHeaderDragSession } from './project-group-header-drag-contract'
import {
  applyRootSlotOrderUpdates,
  getRootSlotOrderUpdatesForSidebarDrop
} from './sidebar-root-slot-order'
import type { ProjectGroup, Repo } from '../../../../shared/types'

export function commitProjectGroupHeaderDragDrop(args: {
  session: ProjectGroupHeaderDragSession
  sidebarDropIndex: number
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repoById: ReadonlyMap<string, Repo>
  onCommitProjectGroupTabOrder: (groupId: string, tabOrder: number) => void
  onCommitProjectGroupOrder: (repoId: string, projectGroupId: string | null, order: number) => void
}): void {
  const orderedRootSlots = args.session.orderedRootSlots
  if (orderedRootSlots && orderedRootSlots.length > 0) {
    const updates = getRootSlotOrderUpdatesForSidebarDrop({
      orderedRootSlots,
      dragged: { kind: 'project-group', id: args.session.groupId },
      sidebarDropIndex: args.sidebarDropIndex,
      projectGroupById: args.projectGroupById,
      repoById: args.repoById
    })
    applyRootSlotOrderUpdates({
      updates,
      onCommitProjectGroupTabOrder: args.onCommitProjectGroupTabOrder,
      onCommitProjectGroupOrder: args.onCommitProjectGroupOrder
    })
    return
  }

  const updates = getProjectGroupTabOrderUpdatesForSidebarDrop({
    sidebarProjectGroupHeaderIds: args.session.sidebarProjectGroupHeaderIds,
    draggedGroupId: args.session.groupId,
    sidebarDropIndex: args.sidebarDropIndex,
    projectGroupById: args.projectGroupById
  })
  for (const update of updates) {
    args.onCommitProjectGroupTabOrder(update.groupId, update.tabOrder)
  }
}
