import type { PointerEvent } from 'react'

import {
  getParentGroupIdForHeaderDragBucketKey,
  getProjectGroupHeaderDragBucketKey,
  measureProjectGroupHeaderDragRects,
  type ProjectGroupHeaderDragBucketKey
} from './project-group-header-drop'
import {
  isProjectGroupHeaderActionTarget,
  isProjectGroupHeaderDragHandleTarget,
  type ProjectGroupHeaderDragSession
} from './project-group-header-drag-contract'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { createProjectGroupReparentValidator } from '../../../../shared/project-group-reparent'
import type { ProjectGroup } from '../../../../shared/types'

export function createProjectGroupHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  groupId: string
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
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
  const sidebarProjectGroupHeaderIds =
    args.sidebarProjectGroupHeaderIdsByBucket.get(bucketKey) ?? []
  // Why: drops can now reparent across buckets, so a drag is meaningful as
  // long as any other group header exists anywhere in the sidebar.
  let totalHeaderCount = 0
  for (const headerIds of args.sidebarProjectGroupHeaderIdsByBucket.values()) {
    totalHeaderCount += headerIds.length
  }
  if (totalHeaderCount <= 1) {
    return null
  }
  const container = args.getScrollContainer()
  if (!container) {
    return null
  }
  const handleEl = args.event.currentTarget
  const projectGroups = [...args.projectGroupById.values()]
  // Why: defer pointer capture until the threshold so ordinary group header
  // clicks still toggle collapse through the row handler.
  return {
    groupId: args.groupId,
    bucketKey,
    sourceParentGroupId: getParentGroupIdForHeaderDragBucketKey(bucketKey),
    sidebarProjectGroupHeaderIds,
    sidebarProjectGroupHeaderIdsByBucket: args.sidebarProjectGroupHeaderIdsByBucket,
    draggedSubtreeGroupIds: getProjectGroupSubtreeIds(projectGroups, args.groupId),
    validateReparent: createProjectGroupReparentValidator(projectGroups, args.groupId),
    pointerId: args.event.pointerId,
    headerRects: measureProjectGroupHeaderDragRects(container),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
