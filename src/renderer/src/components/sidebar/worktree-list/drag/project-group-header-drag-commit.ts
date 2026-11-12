import { getProjectGroupTabOrderUpdatesForSidebarDrop } from './project-group-header-drop'
import type { ProjectGroupHeaderDragSession } from './project-group-header-drag-contract'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { RootProjectHeaderDrag } from './root-project-header-drop'

export function commitProjectGroupHeaderDragDrop(
  args: RootProjectHeaderDrag & {
    session: ProjectGroupHeaderDragSession
    sidebarDropIndex: number
    projectGroupById: ReadonlyMap<string, ProjectGroup>
    onCommitProjectGroupTabOrder: (groupId: string, tabOrder: number) => void
  }
): void {
  if (args.session.rootProjectHeaderKeys) {
    args.onCommitRootProjectOrder?.(
      args.session.rootProjectHeaderKeys,
      `group:${args.session.groupId}`,
      args.sidebarDropIndex
    )
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
