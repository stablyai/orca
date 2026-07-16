import {
  getParentGroupIdForHeaderDragBucketKey,
  getProjectGroupTabOrderUpdatesForSidebarDrop
} from './project-group-header-drop'
import type { ProjectGroupHeaderDropTarget } from './project-group-header-drop-target'
import type { ProjectGroupHeaderDragSession } from './project-group-header-drag-contract'
import type { ProjectGroup } from '../../../../shared/types'

export function commitProjectGroupHeaderDragDrop(args: {
  session: ProjectGroupHeaderDragSession
  dropTarget: ProjectGroupHeaderDropTarget
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  onCommitProjectGroupTabOrder: (groupId: string, tabOrder: number) => void
  onCommitProjectGroupReparent: (
    groupId: string,
    parentGroupId: string | null,
    tabOrder: number
  ) => void
}): void {
  const { session, dropTarget } = args
  if (dropTarget.kind === 'nest') {
    // Append after the target's current children so the drop lands at a
    // predictable position when the target expands.
    let maxChildTabOrder = -1
    for (const group of args.projectGroupById.values()) {
      if ((group.parentGroupId ?? null) === dropTarget.targetGroupId) {
        maxChildTabOrder = Math.max(maxChildTabOrder, group.tabOrder)
      }
    }
    args.onCommitProjectGroupReparent(
      session.groupId,
      dropTarget.targetGroupId,
      maxChildTabOrder + 1
    )
    return
  }
  if (dropTarget.bucketKey === session.bucketKey) {
    const updates = getProjectGroupTabOrderUpdatesForSidebarDrop({
      sidebarProjectGroupHeaderIds: session.sidebarProjectGroupHeaderIds,
      draggedGroupId: session.groupId,
      sidebarDropIndex: dropTarget.dropIndex,
      projectGroupById: args.projectGroupById
    })
    for (const update of updates) {
      args.onCommitProjectGroupTabOrder(update.groupId, update.tabOrder)
    }
    return
  }
  // Cross-bucket insert: the dragged group reparents to the target bucket's
  // parent, and displaced siblings renumber around the insertion point.
  const targetHeaderIds = (
    session.sidebarProjectGroupHeaderIdsByBucket.get(dropTarget.bucketKey) ?? []
  ).filter((groupId) => groupId !== session.groupId)
  const insertIndex = Math.max(0, Math.min(targetHeaderIds.length, dropTarget.dropIndex))
  const orderedIds = targetHeaderIds.slice()
  orderedIds.splice(insertIndex, 0, session.groupId)
  for (const [index, groupId] of orderedIds.entries()) {
    if (groupId === session.groupId) {
      args.onCommitProjectGroupReparent(
        session.groupId,
        getParentGroupIdForHeaderDragBucketKey(dropTarget.bucketKey),
        index
      )
      continue
    }
    const group = args.projectGroupById.get(groupId)
    if (group && group.tabOrder !== index) {
      args.onCommitProjectGroupTabOrder(groupId, index)
    }
  }
}
