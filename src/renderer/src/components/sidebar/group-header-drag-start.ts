// group-header-drag-start.ts
import type { PointerEvent } from 'react'

import { measureGroupHeaderDragRects } from './group-header-drop'
import {
  isGroupHeaderActionTarget,
  isGroupHeaderDragHandleTarget,
  type GroupHeaderDragSession
} from './group-header-drag-contract'
import type { ProjectGroup } from '../../../../shared/types'

export function createGroupHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  groupId: string
  groupsById: ReadonlyMap<string, ProjectGroup>
  siblingGroupIdsByParent: ReadonlyMap<string | null, readonly string[]>
  getScrollContainer: () => HTMLElement | null
}): GroupHeaderDragSession | null {
  if (args.event.button !== 0) {
    return null
  }
  if (!isGroupHeaderDragHandleTarget(args.event.target, args.event.currentTarget)) {
    return null
  }
  if (isGroupHeaderActionTarget(args.event.target, args.event.currentTarget)) {
    return null
  }
  const group = args.groupsById.get(args.groupId)
  if (!group) {
    return null
  }
  const parentGroupId = group.parentGroupId ?? null
  const siblingGroupIds = args.siblingGroupIdsByParent.get(parentGroupId) ?? []
  // Why: a lone group has no sibling to reorder against; let the header click
  // toggle collapse instead.
  if (siblingGroupIds.length <= 1) {
    return null
  }
  const container = args.getScrollContainer()
  if (!container) {
    return null
  }
  return {
    groupId: args.groupId,
    parentGroupId,
    siblingGroupIds,
    pointerId: args.event.pointerId,
    headerRects: measureGroupHeaderDragRects(container, parentGroupId),
    handleEl: args.event.currentTarget,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
