import {
  getRootProjectHeaderDragKeys,
  measureRootProjectHeaderDragRects
} from './root-project-header-drop'
import type { PointerEvent } from 'react'

import {
  getProjectGroupHeaderDragBucketKey,
  measureProjectGroupHeaderDragRects,
  type ProjectGroupHeaderDragBucketKey,
  type ProjectGroupHeaderDragItem
} from './project-group-header-drop'
import {
  isProjectGroupHeaderActionTarget,
  isProjectGroupHeaderDragHandleTarget,
  type ProjectGroupHeaderDragSession
} from './project-group-header-drag-contract'

export function createProjectGroupHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  groupId: string
  projectGroupById: ReadonlyMap<string, ProjectGroupHeaderDragItem>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  rootProjectHeaderKeys?: readonly string[]
  canNest: boolean
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
  const rootProjectHeaderHostId = args.rootProjectHeaderKeys?.some((key) => key.startsWith('host:'))
    ? args.event.currentTarget.dataset.rootProjectHeaderHost
    : undefined
  const rootProjectHeaderKeys = getRootProjectHeaderDragKeys(
    args.rootProjectHeaderKeys,
    `group:${args.groupId}`,
    rootProjectHeaderHostId
  )
  const sidebarProjectGroupHeaderIds =
    rootProjectHeaderKeys ?? args.sidebarProjectGroupHeaderIdsByBucket.get(bucketKey) ?? []
  // Why: without nesting, a lone group in a parent bucket has nowhere to move.
  if (!args.canNest && sidebarProjectGroupHeaderIds.length <= 1) {
    return null
  }
  const container = args.getScrollContainer()
  if (!container) {
    return null
  }
  const handleEl = args.event.currentTarget
  // Delay pointer capture until promotion so ordinary clicks can still toggle collapse.
  return {
    groupId: args.groupId,
    parentGroupId: group.parentGroupId ?? null,
    bucketKey,
    sidebarProjectGroupHeaderIds,
    pointerId: args.event.pointerId,
    rootProjectHeaderKeys,
    rootProjectHeaderHostId,
    headerRects: measureProjectGroupHeaderSessionRects(container, {
      bucketKey,
      rootProjectHeaderKeys,
      rootProjectHeaderHostId
    }),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}

export function measureProjectGroupHeaderSessionRects(
  container: HTMLElement,
  session: Pick<
    ProjectGroupHeaderDragSession,
    'bucketKey' | 'rootProjectHeaderKeys' | 'rootProjectHeaderHostId'
  >
): ProjectGroupHeaderDragSession['headerRects'] {
  return session.rootProjectHeaderKeys
    ? measureRootProjectHeaderDragRects(
        container,
        session.rootProjectHeaderKeys,
        session.rootProjectHeaderHostId
      ).map((rect) => ({ ...rect, groupId: rect.key }))
    : measureProjectGroupHeaderDragRects(container, session.bucketKey)
}
