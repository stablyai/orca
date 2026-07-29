import type { PointerEvent } from 'react'

import {
  getProjectGroupHeaderDragBucketKey,
  measureProjectGroupHeaderDragRects,
  type ProjectGroupHeaderDragBucketKey
} from './project-group-header-drop'
import {
  isProjectGroupHeaderActionTarget,
  isProjectGroupHeaderDragHandleTarget,
  type ProjectGroupHeaderDragSession
} from './project-group-header-drag-contract'
import {
  encodeSidebarRootSlotKey,
  measureSidebarRootSlotDragRects,
  SIDEBAR_ROOT_SLOT_BUCKET,
  type SidebarRootSlot
} from './sidebar-root-slot-order'
import type { ProjectGroup } from '../../../../shared/types'

export function createProjectGroupHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  groupId: string
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  sidebarRootSlots: readonly SidebarRootSlot[]
  getScrollContainer: () => HTMLElement | null
}): ProjectGroupHeaderDragSession | null {
  if (args.event.button !== 0) {
    return null
  }
  if (!isProjectGroupHeaderDragHandleTarget(args.event.target, args.event.currentTarget)) {
    return null
  }
  if (isProjectGroupHeaderActionTarget(args.event.target, args.event.currentTarget)) {
    return null
  }
  const group = args.projectGroupById.get(args.groupId)
  if (!group) {
    return null
  }
  const bucketKey = getProjectGroupHeaderDragBucketKey(group, args.projectGroupById)
  const usesRootSlotOrdering =
    bucketKey === SIDEBAR_ROOT_SLOT_BUCKET && args.sidebarRootSlots.length > 1
  const sidebarProjectGroupHeaderIds =
    args.sidebarProjectGroupHeaderIdsByBucket.get(bucketKey) ?? []
  // Why: root can move against ungrouped projects; nested buckets still need 2+ groups.
  if (usesRootSlotOrdering) {
    // ok
  } else if (sidebarProjectGroupHeaderIds.length <= 1) {
    return null
  }
  if (usesRootSlotOrdering && args.sidebarRootSlots.length <= 1) {
    return null
  }
  const container = args.getScrollContainer()
  if (!container) {
    return null
  }
  const handleEl = args.event.currentTarget
  const orderedRootSlots = usesRootSlotOrdering ? args.sidebarRootSlots : null
  // Why: defer pointer capture until the threshold so ordinary group header
  // clicks still toggle collapse through the row handler.
  return {
    groupId: args.groupId,
    bucketKey,
    sidebarProjectGroupHeaderIds: usesRootSlotOrdering
      ? orderedRootSlots!.map(encodeSidebarRootSlotKey)
      : sidebarProjectGroupHeaderIds,
    orderedRootSlots,
    pointerId: args.event.pointerId,
    headerRects: usesRootSlotOrdering
      ? measureSidebarRootSlotDragRects(container)
      : measureProjectGroupHeaderDragRects(container, bucketKey),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
