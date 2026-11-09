import {
  getRootProjectHeaderDragKeys,
  getRootProjectHeaderSectionKeysForHost,
  measureRootProjectHeaderDragRects
} from './root-project-header-drop'
import type { PointerEvent } from 'react'

import { measureSidebarVirtualContentBottom } from './header-drag-dom-measurement'
import { filterRootProjectHeaderKeysByPinTier } from './header-drag-pin-tier'
import { readHostHeaderRects } from './host-header-drag-dom'
import {
  getProjectGroupHeaderDragBucketKey,
  measureProjectGroupHeaderDragRects,
  type ProjectGroupHeaderDragBucketKey
} from './project-group-header-drop'
import {
  canProjectGroupStartHeaderDrag,
  computeCombinedProjectGroupHeaderDropTarget,
  filterProjectGroupIdsByCatalogHost,
  getReparentableTargetGroupIdsForGroup,
  type ProjectGroupHeaderDropTarget
} from './project-group-header-reparent-drop'
import {
  ROOT_INTERLEAVED_GROUP_BUCKET_KEY,
  isProjectGroupHeaderActionTarget,
  isProjectGroupHeaderDragHandleTarget,
  type ProjectGroupHeaderDragSession,
  type UseProjectGroupHeaderDragArgs
} from './project-group-header-drag-contract'
import { measureProjectHeaderDragRects } from './project-header-drop'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'

export function refreshProjectGroupHeaderDragSessionRects(
  container: HTMLElement | null,
  session: ProjectGroupHeaderDragSession | null
): void {
  if (!container || !session) {
    return
  }
  session.headerRects = measureProjectGroupHeaderDragRects(container)
  session.rootHeaderRects = session.rootProjectHeaderKeys
    ? measureRootProjectHeaderDragRects(
        container,
        session.rootProjectHeaderKeys,
        session.rootProjectHeaderHostId
      ).map((rect) => ({
        ...rect,
        groupId: rect.key,
        bucketKey: ROOT_INTERLEAVED_GROUP_BUCKET_KEY
      }))
    : undefined
  session.repoHeaderRects = measureProjectHeaderDragRects(container)
  session.hostHeaderRects = readHostHeaderRects(container)
}

export function computeSessionProjectGroupHeaderDropTarget(
  pointerY: number,
  session: ProjectGroupHeaderDragSession | null,
  inputs: UseProjectGroupHeaderDragArgs
): ProjectGroupHeaderDropTarget | null {
  const container = inputs.getScrollContainer()
  const draggedGroup = session ? inputs.projectGroupById.get(session.groupId) : undefined
  if (!session || !container || !draggedGroup) {
    return null
  }
  return computeCombinedProjectGroupHeaderDropTarget({
    pointerY,
    containerTop: container.getBoundingClientRect().top,
    scrollTop: container.scrollTop,
    dragHostId: getRepoExecutionHostId(draggedGroup),
    draggedGroup,
    projectGroupById: inputs.projectGroupById,
    reparentableGroupIds: session.reparentableGroupIds,
    hostHeaderRects: session.hostHeaderRects,
    groupHeaderRects: session.headerRects,
    rootProjectHeaderKeys: session.rootProjectHeaderKeys,
    rootHeaderRects: session.rootHeaderRects,
    repoHeaderRects: session.repoHeaderRects,
    allowMixedProjectReorder: inputs.allowMixedProjectReorder,
    sidebarGroupChildItemIdsByGroupId: inputs.sidebarGroupChildItemIdsByGroupId,
    repoById: inputs.repoById,
    liveRepos: inputs.getLiveRepos?.(),
    pinnedRepoHeaderIds: inputs.pinnedRepoHeaderIds,
    sidebarProjectGroupHeaderIdsByBucket: inputs.sidebarProjectGroupHeaderIdsByBucket,
    contentBottom: measureSidebarVirtualContentBottom(container)
  })
}

export function createProjectGroupHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  groupId: string
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
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
      ? filterRootProjectHeaderKeysByPinTier({
          keys: getRootProjectHeaderDragKeys(
            args.rootProjectHeaderKeys,
            `group:${args.groupId}`,
            rootProjectHeaderHostId
          ),
          isPinned: group.isPinned === true,
          projectGroupById: args.projectGroupById,
          pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
          repoById: args.repoById
        })
      : filterRootProjectHeaderKeysByPinTier({
          keys: getRootProjectHeaderSectionKeysForHost(
            args.rootProjectHeaderKeys,
            rootProjectHeaderHostId
          ),
          isPinned: false,
          projectGroupById: args.projectGroupById,
          pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
          repoById: args.repoById
        })
  const rawBucketHeaderIds = args.sidebarProjectGroupHeaderIdsByBucket.get(bucketKey) ?? []
  const sidebarProjectGroupHeaderIds = filterProjectGroupIdsByCatalogHost(
    rawBucketHeaderIds,
    getRepoExecutionHostId(group),
    args.projectGroupById
  ).filter((id) => (args.projectGroupById.get(id)?.isPinned === true) === (group.isPinned === true))
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
    repoHeaderRects: measureProjectHeaderDragRects(container),
    hostHeaderRects: readHostHeaderRects(container),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
