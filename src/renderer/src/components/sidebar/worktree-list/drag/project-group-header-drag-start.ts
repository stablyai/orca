import {
  getRootProjectHeaderDragKeys,
  getRootProjectHeaderSectionKeysForHost,
  measureRootProjectHeaderDragRects
} from './root-project-header-drop'
import type { PointerEvent } from 'react'

import { readHostHeaderRects } from './host-header-drag-dom'
import {
  getProjectGroupHeaderDragBucketKey,
  measureProjectGroupHeaderDragRects,
  type ProjectGroupHeaderDragBucketKey
} from './project-group-header-drop'
import {
  canProjectGroupStartHeaderDrag,
  filterProjectGroupIdsByCatalogHost,
  getReparentableTargetGroupIdsForGroup
} from './project-group-header-reparent-drop'
import {
  ROOT_INTERLEAVED_GROUP_BUCKET_KEY,
  isProjectGroupHeaderActionTarget,
  isProjectGroupHeaderDragHandleTarget,
  type ProjectGroupHeaderDragSession
} from './project-group-header-drag-contract'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'

export function createProjectGroupHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  groupId: string
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  projectGroupOwnerHostIdByGroupId?: ReadonlyMap<string, ExecutionHostId | null>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  rootProjectHeaderKeys?: readonly string[]
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
  if (args.projectGroupOwnerHostIdByGroupId?.get(args.groupId) === null) {
    return null
  }
  const group = args.projectGroupById.get(args.groupId)
  if (!group) {
    return null
  }
  const bucketKey = getProjectGroupHeaderDragBucketKey(group, args.projectGroupById)
  const hasHostScopedRootKeys = args.rootProjectHeaderKeys?.some((key) => key.startsWith('host:'))
  const rootProjectHeaderHostId = hasHostScopedRootKeys
    ? (args.event.currentTarget.dataset.rootProjectHeaderHost ??
      args.event.currentTarget.dataset.projectGroupHeaderHost ??
      getRepoExecutionHostId(group))
    : undefined
  const rootProjectHeaderKeys =
    bucketKey === 'root'
      ? getRootProjectHeaderDragKeys(
          args.rootProjectHeaderKeys,
          `group:${args.groupId}`,
          rootProjectHeaderHostId
        )
      : getRootProjectHeaderSectionKeysForHost(args.rootProjectHeaderKeys, rootProjectHeaderHostId)
  const rawBucketHeaderIds = args.sidebarProjectGroupHeaderIdsByBucket.get(bucketKey) ?? []
  const sidebarProjectGroupHeaderIds = filterProjectGroupIdsByCatalogHost(
    rawBucketHeaderIds,
    getRepoExecutionHostId(group),
    args.projectGroupById
  )
  const reparentableGroupIds = getReparentableTargetGroupIdsForGroup(group, [
    ...args.projectGroupById.values()
  ])
  if (
    !canProjectGroupStartHeaderDrag({
      group,
      projectGroupById: args.projectGroupById,
      sidebarBucketHeaderIds: rawBucketHeaderIds,
      rootProjectHeaderCount: rootProjectHeaderKeys?.length,
      reparentableGroupIds
    })
  ) {
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
    bucketKey,
    sidebarProjectGroupHeaderIds,
    rootProjectHeaderKeys,
    rootProjectHeaderHostId,
    rootHeaderRects: rootProjectHeaderKeys
      ? measureRootProjectHeaderDragRects(
          container,
          rootProjectHeaderKeys,
          rootProjectHeaderHostId
        ).map((rect) => ({
          ...rect,
          groupId: rect.key,
          bucketKey: ROOT_INTERLEAVED_GROUP_BUCKET_KEY
        }))
      : undefined,
    reparentableGroupIds,
    pointerId: args.event.pointerId,
    headerRects: measureProjectGroupHeaderDragRects(container),
    hostHeaderRects: readHostHeaderRects(container),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
