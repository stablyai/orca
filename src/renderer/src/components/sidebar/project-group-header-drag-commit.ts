import { getProjectGroupTabOrderUpdatesForSidebarDrop } from './project-group-header-drop'
import type { ProjectGroupHeaderDragSession } from './project-group-header-drag-contract'
import {
  applyRootSlotOrderUpdates,
  getRootSlotOrderUpdatesForSidebarDrop
} from './sidebar-root-slot-order'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'

export function commitProjectGroupHeaderDragDrop(args: {
  session: ProjectGroupHeaderDragSession
  sidebarDropIndex: number
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repoById?: ReadonlyMap<string, Repo>
  onCommitProjectGroupTabOrder: (groupId: string, tabOrder: number) => void
  onCommitProjectGroupOrder?: (project: Repo, projectGroupId: string | null, order: number) => void
}): void {
  const orderedRootSlots = args.session.orderedRootSlots
  if (
    orderedRootSlots &&
    orderedRootSlots.length > 0 &&
    args.repoById &&
    args.onCommitProjectGroupOrder
  ) {
    const updates = getRootSlotOrderUpdatesForSidebarDrop({
      orderedRootSlots,
      dragged: { kind: 'project-group', id: args.session.groupId },
      sidebarDropIndex: args.sidebarDropIndex,
      projectGroupById: args.projectGroupById,
      repoById: args.repoById
    })
    const onCommitProjectGroupOrder = args.onCommitProjectGroupOrder
    applyRootSlotOrderUpdates({
      updates,
      onCommitProjectGroupTabOrder: args.onCommitProjectGroupTabOrder,
      onCommitProjectGroupOrder: (repoId, projectGroupId, order) => {
        const repo = args.repoById?.get(repoId)
        if (!repo) {
          return
        }
        onCommitProjectGroupOrder(repo, projectGroupId, order)
      }
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
