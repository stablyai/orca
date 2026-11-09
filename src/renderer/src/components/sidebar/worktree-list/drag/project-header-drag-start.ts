import {
  getRootProjectHeaderDragKeys,
  getRootProjectHeaderSectionKeysForHost,
  measureRootProjectHeaderDragRects
} from './root-project-header-drop'
import type { PointerEvent } from 'react'

import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { findJoinableParentGroupForRepo } from '../rows/project-group-menu-tree'
import { measureSidebarVirtualContentBottom } from './header-drag-dom-measurement'
import { readHostHeaderRects } from './host-header-drag-dom'
import { filterRootProjectHeaderKeysByPinTier, isRepoHeaderIdPinned } from './header-drag-pin-tier'
import { filterRepoHeaderIdsByCatalogHost } from './project-group-child-catalog'
import { measureProjectGroupHeaderDragRects } from './project-group-header-drop'
import {
  getProjectHeaderDragBucketKey,
  measureProjectHeaderDragRects,
  type ProjectHeaderDragBucketKey
} from './project-header-drop'
import {
  canRepoStartHeaderDrag,
  computeCombinedProjectHeaderDropTarget,
  getJoinableGroupIdsForRepo,
  getSessionGroupRepo,
  type ProjectHeaderDropTarget
} from './project-header-group-drop'
import {
  ROOT_INTERLEAVED_PROJECT_BUCKET_KEY,
  isProjectHeaderDragHandleTarget,
  isRepoHeaderActionTarget,
  type ProjectHeaderDragSession,
  type UseRepoHeaderDragArgs
} from './project-header-drag-contract'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'

export function refreshProjectHeaderDragSessionRects(
  container: HTMLElement | null,
  session: ProjectHeaderDragSession | null
): void {
  if (!container || !session) {
    return
  }
  session.headerRects = measureProjectHeaderDragRects(container)
  session.rootHeaderRects = session.rootProjectHeaderKeys
    ? measureRootProjectHeaderDragRects(
        container,
        session.rootProjectHeaderKeys,
        session.rootProjectHeaderHostId
      ).map((rect) => ({
        ...rect,
        repoId: rect.key,
        bucketKey: ROOT_INTERLEAVED_PROJECT_BUCKET_KEY
      }))
    : undefined
  session.groupHeaderRects = measureProjectGroupHeaderDragRects(container)
  session.hostHeaderRects = readHostHeaderRects(container)
}

export function computeSessionProjectHeaderDropTarget(
  pointerY: number,
  session: ProjectHeaderDragSession | null,
  inputs: UseRepoHeaderDragArgs
): ProjectHeaderDropTarget | null {
  const container = inputs.getScrollContainer()
  if (!session || !container) {
    return null
  }
  const bucketOwnerRepo = getSessionGroupRepo(session) ?? session.repo
  const currentGroupId = bucketOwnerRepo.projectGroupId ?? null
  const currentParentGroupId =
    findJoinableParentGroupForRepo(bucketOwnerRepo, inputs.projectGroups)?.id ?? null
  const draggedRepoPinned =
    isRepoHeaderIdPinned(session.repo.id, inputs.pinnedRepoHeaderIds, inputs.repoById) ||
    bucketOwnerRepo.isPinned === true
  return computeCombinedProjectHeaderDropTarget({
    pointerY,
    containerTop: container.getBoundingClientRect().top,
    scrollTop: container.scrollTop,
    dragHostId: getRepoExecutionHostId(bucketOwnerRepo),
    currentGroupId,
    currentParentGroupId,
    draggedRepoPinned,
    pinnedRepoHeaderIds: inputs.pinnedRepoHeaderIds,
    repoById: inputs.repoById,
    liveRepos: inputs.getLiveRepos(),
    projectGroupById: inputs.projectGroupById,
    sidebarGroupChildItemIdsByGroupId: inputs.sidebarGroupChildItemIdsByGroupId,
    allowSlotReorder: inputs.allowSlotReorder,
    joinableGroupIds: session.joinableGroupIds,
    hostHeaderRects: session.hostHeaderRects,
    groupHeaderRects: session.groupHeaderRects,
    repoHeaderRects: session.headerRects,
    rootProjectHeaderKeys: session.rootProjectHeaderKeys,
    rootHeaderRects: session.rootHeaderRects,
    sidebarRepoHeaderIdsByBucket: inputs.sidebarRepoHeaderIdsByBucket,
    contentBottom: measureSidebarVirtualContentBottom(container)
  })
}

export function createProjectHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  repo: Repo
  groupRepo?: Repo | null
  projectGroups: readonly ProjectGroup[]
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
  allowSlotReorder: boolean
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  rootProjectHeaderKeys?: readonly string[]
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
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
  const rawBucketHeaderIds = filterRepoHeaderIdsByCatalogHost(
    args.sidebarRepoHeaderIdsByBucket.get(bucketKey) ?? [],
    getRepoExecutionHostId(bucketOwnerRepo),
    undefined,
    args.repoById
  )
  const draggedPinned =
    isRepoHeaderIdPinned(args.repo.id, args.pinnedRepoHeaderIds, args.repoById) ||
    bucketOwnerRepo.isPinned === true
  const sidebarRepoHeaderIds = rawBucketHeaderIds.filter(
    (id) => isRepoHeaderIdPinned(id, args.pinnedRepoHeaderIds, args.repoById) === draggedPinned
  )
  const rootProjectHeaderHostId = args.rootProjectHeaderKeys?.some((key) => key.startsWith('host:'))
    ? bucketKey === 'ungrouped'
      ? args.event.currentTarget.dataset.rootProjectHeaderHost
      : (args.event.currentTarget.dataset.rootProjectHeaderHost ??
        getRepoExecutionHostId(bucketOwnerRepo))
    : undefined
  const rootProjectHeaderKeys =
    bucketKey === 'ungrouped'
      ? filterRootProjectHeaderKeysByPinTier({
          keys: getRootProjectHeaderDragKeys(
            args.rootProjectHeaderKeys,
            `repo:${args.repo.id}`,
            rootProjectHeaderHostId
          ),
          isPinned: draggedPinned,
          projectGroupById: args.projectGroupById,
          pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
          repoById: args.repoById
        })
      : args.allowSlotReorder && effectiveGroupRepo
        ? filterRootProjectHeaderKeysByPinTier({
            keys: getRootProjectHeaderSectionKeysForHost(
              args.rootProjectHeaderKeys,
              rootProjectHeaderHostId
            ),
            isPinned: false,
            projectGroupById: args.projectGroupById,
            pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
            repoById: args.repoById
          })
        : undefined
  const effectiveBucketItemCount =
    bucketKey === 'ungrouped' && rootProjectHeaderKeys
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
      bucketHeaderIds:
        bucketKey === 'ungrouped' && rootProjectHeaderKeys ? undefined : rawBucketHeaderIds,
      pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
      repoById: args.repoById,
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
