import {
  getRootProjectHeaderDragKeys,
  measureRootProjectHeaderDragRects
} from './root-project-header-drop'
import type { PointerEvent } from 'react'

import { readHostHeaderRects } from './host-header-drag-dom'
import { measureProjectGroupHeaderDragRects } from './project-group-header-drop'
import {
  getProjectHeaderDragBucketKey,
  measureProjectHeaderDragRects,
  type ProjectHeaderDragBucketKey
} from './project-header-drop'
import { canRepoStartHeaderDrag, getJoinableGroupIdsForRepo } from './project-header-group-drop'
import {
  ROOT_INTERLEAVED_PROJECT_BUCKET_KEY,
  isProjectHeaderDragHandleTarget,
  isRepoHeaderActionTarget,
  type ProjectHeaderDragSession
} from './project-header-drag-contract'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'

export function createProjectHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  repo: Repo
  groupRepo?: Repo | null
  projectGroups: readonly ProjectGroup[]
  allowSlotReorder: boolean
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  rootProjectHeaderKeys?: readonly string[]
  getScrollContainer: () => HTMLElement | null
}): ProjectHeaderDragSession | null {
  if (args.event.button !== 0) {
    return null
  }
  if (!isProjectHeaderDragHandleTarget(args.event.target, args.event.currentTarget)) {
    return null
  }
  if (isRepoHeaderActionTarget(args.event.target, args.event.currentTarget)) {
    return null
  }
  const effectiveGroupRepo = args.groupRepo === undefined ? args.repo : args.groupRepo
  const bucketOwnerRepo = effectiveGroupRepo ?? args.repo
  const bucketKey = getProjectHeaderDragBucketKey(bucketOwnerRepo)
  const rootProjectHeaderHostId =
    bucketKey === 'ungrouped' && args.rootProjectHeaderKeys?.some((key) => key.startsWith('host:'))
      ? args.event.currentTarget.dataset.rootProjectHeaderHost
      : undefined
  const rootProjectHeaderKeys =
    bucketKey === 'ungrouped'
      ? getRootProjectHeaderDragKeys(
          args.rootProjectHeaderKeys,
          `repo:${args.repo.id}`,
          rootProjectHeaderHostId
        )
      : undefined
  const sidebarRepoHeaderIds = args.sidebarRepoHeaderIdsByBucket.get(bucketKey) ?? []
  const effectiveBucketItemCount = rootProjectHeaderKeys
    ? Math.max(sidebarRepoHeaderIds.length, rootProjectHeaderKeys.length)
    : sidebarRepoHeaderIds.length
  const joinableGroupIds = effectiveGroupRepo
    ? getJoinableGroupIdsForRepo(effectiveGroupRepo, args.projectGroups)
    : new Set<string>()
  if (
    !canRepoStartHeaderDrag({
      repo: bucketOwnerRepo,
      allowSlotReorder: args.allowSlotReorder,
      bucketItemCount: effectiveBucketItemCount,
      joinableGroupIds
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
    repo: args.repo,
    groupRepo: effectiveGroupRepo,
    bucketKey,
    sidebarRepoHeaderIds,
    rootProjectHeaderKeys,
    rootProjectHeaderHostId,
    rootHeaderRects: rootProjectHeaderKeys
      ? measureRootProjectHeaderDragRects(
          container,
          rootProjectHeaderKeys,
          rootProjectHeaderHostId
        ).map((rect) => ({
          ...rect,
          repoId: rect.key,
          bucketKey: ROOT_INTERLEAVED_PROJECT_BUCKET_KEY
        }))
      : undefined,
    joinableGroupIds,
    hostHeaderRects: readHostHeaderRects(container),
    pointerId: args.event.pointerId,
    headerRects: measureProjectHeaderDragRects(container),
    groupHeaderRects: measureProjectGroupHeaderDragRects(container),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
