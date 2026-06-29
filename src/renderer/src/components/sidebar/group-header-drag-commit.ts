// group-header-drag-commit.ts
import {
  getTabOrderForGroupDrop,
  mapSidebarGroupDropIndexToSiblingInsertIndex
} from './group-header-drop'
import type { GroupHeaderDragSession } from './group-header-drag-contract'
import type { ProjectGroup } from '../../../../shared/types'

export function commitGroupHeaderDragDrop(args: {
  session: GroupHeaderDragSession
  sidebarDropIndex: number
  groupsById: ReadonlyMap<string, ProjectGroup>
  onCommitGroupOrder: (groupId: string, tabOrder: number) => void
}): void {
  if (!args.groupsById.get(args.session.groupId)) {
    return
  }
  const siblingGroupIds = args.session.siblingGroupIds
  const sourceIndex = siblingGroupIds.indexOf(args.session.groupId)
  if (args.sidebarDropIndex === sourceIndex) {
    return
  }
  const siblings = siblingGroupIds
    .filter((id) => id !== args.session.groupId)
    .map((id) => args.groupsById.get(id))
    .filter((group): group is ProjectGroup => group !== undefined)
  const siblingDropIndex = mapSidebarGroupDropIndexToSiblingInsertIndex({
    sidebarDropIndex: args.sidebarDropIndex,
    sourceIndex,
    siblingCount: siblings.length
  })
  // Why: removing the dragged group can only shift the source position down by
  // one, so its equivalent slot in the filtered list is sourceIndex capped.
  const sourceIndexInSiblings = Math.min(sourceIndex, siblings.length)
  if (siblingDropIndex === sourceIndexInSiblings) {
    return
  }
  const tabOrder = getTabOrderForGroupDrop({ siblings, dropIndex: siblingDropIndex })
  args.onCommitGroupOrder(args.session.groupId, tabOrder)
}
