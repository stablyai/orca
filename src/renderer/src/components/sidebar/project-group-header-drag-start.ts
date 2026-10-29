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
import type { ProjectGroup } from '../../../../shared/project-group-types'

export function createProjectGroupHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  groupId: string
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  sidebarRootSlots?: readonly SidebarRootSlot[]
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
  const sidebarRootSlots = args.sidebarRootSlots ?? []
  const usesRootSlotOrdering =
    bucketKey === SIDEBAR_ROOT_SLOT_BUCKET && sidebarRootSlots.length > 1
  const sidebarProjectGroupHeaderIds =
    args.sidebarProjectGroupHeaderIdsByBucket.get(bucketKey) ?? []
  // Why: root can move against ungrouped projects; nested buckets still need 2+ groups.
  if (!usesRootSlotOrdering && sidebarProjectGroupHeaderIds.length <= 1) {
    return null
  }
  const container = args.getScrollContainer()
  if (!container) {
    return null
  }
  const handleEl = args.event.currentTarget
  const orderedRootSlots = usesRootSlotOrdering ? sidebarRootSlots : null
  // Delay pointer capture until promotion so ordinary clicks can still toggle collapse.
  return {
    groupId: args.groupId,
    bucketKey,
    sidebarProjectGroupHeaderIds: orderedRootSlots
      ? orderedRootSlots.map(encodeSidebarRootSlotKey)
      : sidebarProjectGroupHeaderIds,
    orderedRootSlots,
    pointerId: args.event.pointerId,
    headerRects: orderedRootSlots
      ? measureSidebarRootSlotDragRects(container)
      : measureProjectGroupHeaderDragRects(container, bucketKey),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
