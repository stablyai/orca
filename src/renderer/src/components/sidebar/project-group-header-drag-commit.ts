import {
  getProjectGroupTabOrderForSidebarDrop,
  mapSidebarProjectGroupDropIndexToSiblingInsertIndex
} from './project-group-header-drop'
import type { ProjectGroupHeaderDragSession } from './project-group-header-drag-contract'
import type { ProjectGroup } from '../../../../shared/types'

export function commitProjectGroupHeaderDragDrop(args: {
  session: ProjectGroupHeaderDragSession
  sidebarDropIndex: number
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  onCommitProjectGroupTabOrder: (groupId: string, tabOrder: number) => void
}): void {
  const draggedGroup = args.projectGroupById.get(args.session.groupId)
  if (!draggedGroup) {
    return
  }

  const sidebarProjectGroupHeaderIds = args.session.sidebarProjectGroupHeaderIds
  const sourceIndex = sidebarProjectGroupHeaderIds.indexOf(args.session.groupId)
  if (sourceIndex === -1) {
    return
  }
  if (args.sidebarDropIndex === sourceIndex) {
    return
  }

  const siblings = sidebarProjectGroupHeaderIds
    .filter((groupId) => groupId !== args.session.groupId)
    .map((groupId) => args.projectGroupById.get(groupId))
    .filter((group): group is ProjectGroup => group !== undefined)
  const siblingDropIndex = mapSidebarProjectGroupDropIndexToSiblingInsertIndex({
    sidebarDropIndex: args.sidebarDropIndex,
    sourceIndex,
    siblingCount: siblings.length
  })
  const sourceIndexInSiblings = Math.min(sourceIndex, siblings.length)
  if (siblingDropIndex === sourceIndexInSiblings) {
    return
  }

  const tabOrder = getProjectGroupTabOrderForSidebarDrop({
    siblings,
    dropIndex: siblingDropIndex
  })
  if (!Number.isFinite(tabOrder)) {
    return
  }
  args.onCommitProjectGroupTabOrder(draggedGroup.id, tabOrder)
}
