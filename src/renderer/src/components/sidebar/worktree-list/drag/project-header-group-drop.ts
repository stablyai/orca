import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { HostHeaderRect } from './host-header-drag-dom'
import {
  findInnermostEnclosingGroupRect,
  getCatalogHostIdForExecutionHost,
  isGroupHeaderBandHit,
  resolveHostSectionBounds
} from './group-header-hit-geometry'
import { isRepoHeaderIdPinned } from './header-drag-pin-tier'
import { filterRepoHeaderIdsByCatalogHost } from './project-group-child-catalog'
import {
  resolveTrailingSubgroupReorderEnclosure,
  type ProjectGroupChildItemId
} from './project-group-child-slot-order'
import type { ProjectGroupHeaderDragRect } from './project-group-header-drop'
import {
  ROOT_INTERLEAVED_PROJECT_BUCKET_KEY,
  type ProjectHeaderDragSession,
  type RepoDragState
} from './project-header-drag-contract'
import {
  computeProjectHeaderDropPreview,
  type ProjectHeaderDragBucketKey,
  type ProjectHeaderDragRect
} from './project-header-drop'
import { resolveNonInterleavedRepoBucketSlot } from './project-header-bucket-slot-drop'
import {
  resolveMixedParentGroupRepoSlot,
  resolveSubgroupExitToParentSlot
} from './project-header-subgroup-exit-drop'

export { getCatalogHostIdForExecutionHost }

export type ProjectHeaderDropTarget =
  | { kind: 'group-header'; groupId: string }
  | {
      kind: 'slot'
      targetBucketKey: ProjectHeaderDragBucketKey
      dropIndex: number
      dropIndicatorY: number
    }

const EMPTY_ROOT_TAIL_SLOP_PX = 32
const EMPTY_ROOT_DROP_RANGE_PX = 96

export function parseGroupIdFromBucketKey(bucketKey: ProjectHeaderDragBucketKey): string | null {
  return bucketKey.startsWith('group:') ? bucketKey.slice('group:'.length) : null
}

export function getJoinableGroupIdsForRepo(
  repo: Repo,
  projectGroups: readonly ProjectGroup[]
): Set<string> {
  const catalogHostId = getCatalogHostIdForExecutionHost(getRepoExecutionHostId(repo))
  if (!catalogHostId) {
    return new Set()
  }
  return new Set(
    projectGroups
      .filter((g) => getCatalogHostIdForExecutionHost(getRepoExecutionHostId(g)) === catalogHostId)
      .map((g) => g.id)
  )
}

export function canRepoStartHeaderDrag(args: {
  repo: Repo
  allowSlotReorder: boolean
  bucketItemCount: number
  bucketHeaderIds?: readonly string[]
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  joinableGroupIds: ReadonlySet<string>
}): boolean {
  if ((args.repo.projectGroupId ?? null) !== null || args.joinableGroupIds.size > 0) {
    return true
  }
  const draggedPinned =
    isRepoHeaderIdPinned(args.repo.id, args.pinnedRepoHeaderIds, args.repoById) ||
    args.repo.isPinned === true
  const sameTierCount = args.bucketHeaderIds
    ? args.bucketHeaderIds.filter(
        (id) => isRepoHeaderIdPinned(id, args.pinnedRepoHeaderIds, args.repoById) === draggedPinned
      ).length
    : args.bucketItemCount
  return args.allowSlotReorder && sameTierCount > 1
}

export function computeCombinedProjectHeaderDropTarget(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  dragHostId?: ExecutionHostId
  currentGroupId: string | null
  currentParentGroupId?: string | null
  draggedRepoPinned?: boolean
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
  sidebarGroupChildItemIdsByGroupId?: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
  allowSlotReorder: boolean
  joinableGroupIds: ReadonlySet<string>
  hostHeaderRects?: readonly HostHeaderRect[]
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects: readonly ProjectHeaderDragRect[]
  rootProjectHeaderKeys?: readonly string[]
  rootHeaderRects?: readonly ProjectHeaderDragRect[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  contentBottom?: number
}): ProjectHeaderDropTarget | null {
  const localY = args.pointerY - args.containerTop + args.scrollTop
  const hostUngroupedHeaderIds = filterRepoHeaderIdsByCatalogHost(
    args.sidebarRepoHeaderIdsByBucket.get('ungrouped') ?? [],
    args.dragHostId,
    args.liveRepos,
    args.repoById
  )
  const hasEmptyRootDropZone =
    args.currentGroupId !== null &&
    hostUngroupedHeaderIds.every((repoId) =>
      isRepoHeaderIdPinned(repoId, args.pinnedRepoHeaderIds, args.repoById)
    )
  const tailAllowancePx = hasEmptyRootDropZone ? EMPTY_ROOT_DROP_RANGE_PX : EMPTY_ROOT_TAIL_SLOP_PX
  const maxContentY =
    args.contentBottom !== undefined ? args.contentBottom + tailAllowancePx : undefined
  if (maxContentY !== undefined && localY > maxContentY) {
    return null
  }

  const hostSectionBounds = resolveHostSectionBounds(args.dragHostId, args.hostHeaderRects)
  if (hostSectionBounds && (localY < hostSectionBounds.top || localY >= hostSectionBounds.bottom)) {
    return null
  }

  for (const groupRect of args.groupHeaderRects) {
    if (localY < groupRect.top || localY > groupRect.bottom) {
      continue
    }
    if (
      groupRect.groupId === args.currentGroupId ||
      !args.joinableGroupIds.has(groupRect.groupId)
    ) {
      return null
    }
    if (isGroupHeaderBandHit(localY, groupRect)) {
      return { kind: 'group-header', groupId: groupRect.groupId }
    }
  }

  const innerEnclosingGroup = findInnermostEnclosingGroupRect(localY, args.groupHeaderRects)
  const enclosingGroup = args.allowSlotReorder
    ? resolveTrailingSubgroupReorderEnclosure({
        localY,
        currentParentGroupId: args.currentGroupId,
        enclosingGroup: innerEnclosingGroup,
        groupHeaderRects: args.groupHeaderRects,
        repoHeaderRects: args.repoHeaderRects,
        hostSectionBottom: hostSectionBounds?.bottom
      })
    : innerEnclosingGroup
  if (enclosingGroup && !args.joinableGroupIds.has(enclosingGroup.groupId)) {
    return null
  }

  const currentBucketKey: ProjectHeaderDragBucketKey = args.currentGroupId
    ? `group:${args.currentGroupId}`
    : 'ungrouped'
  const targetBucketKey: ProjectHeaderDragBucketKey = enclosingGroup
    ? `group:${enclosingGroup.groupId}`
    : 'ungrouped'
  const isCrossBucket = targetBucketKey !== currentBucketKey

  if (!enclosingGroup) {
    const parentExitSlot = resolveSubgroupExitToParentSlot({
      localY,
      scrollTop: args.scrollTop,
      dragHostId: args.dragHostId,
      currentGroupId: args.currentGroupId,
      currentParentGroupId: args.currentParentGroupId,
      joinableGroupIds: args.joinableGroupIds,
      groupHeaderRects: args.groupHeaderRects,
      repoHeaderRects: args.repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: args.sidebarRepoHeaderIdsByBucket,
      sidebarGroupChildItemIdsByGroupId: args.sidebarGroupChildItemIdsByGroupId,
      projectGroupById: args.projectGroupById,
      pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
      repoById: args.repoById,
      liveRepos: args.liveRepos,
      hostSectionBottom: hostSectionBounds?.bottom
    })
    if (parentExitSlot) {
      return parentExitSlot
    }
    if (
      args.allowSlotReorder &&
      args.rootProjectHeaderKeys &&
      args.rootHeaderRects &&
      (args.currentGroupId === null || args.rootProjectHeaderKeys.length > 0)
    ) {
      const rootPreview = computeProjectHeaderDropPreview({
        pointerY: args.pointerY,
        containerTop: args.containerTop,
        scrollTop: args.scrollTop,
        rects: args.rootHeaderRects,
        sidebarRepoHeaderIds: args.rootProjectHeaderKeys,
        contentBottom: args.currentGroupId !== null ? maxContentY : args.contentBottom
      })
      return rootPreview
        ? {
            kind: 'slot',
            targetBucketKey: ROOT_INTERLEAVED_PROJECT_BUCKET_KEY,
            ...rootPreview
          }
        : null
    }
  }

  if (!args.allowSlotReorder && !isCrossBucket) {
    return null
  }

  if (enclosingGroup && args.allowSlotReorder && args.sidebarGroupChildItemIdsByGroupId) {
    return resolveMixedParentGroupRepoSlot({
      enclosingGroup,
      targetBucketKey,
      currentGroupId: args.currentGroupId,
      pointerY: args.pointerY,
      containerTop: args.containerTop,
      scrollTop: args.scrollTop,
      localY,
      isCrossBucket,
      draggedRepoPinned: args.draggedRepoPinned,
      dragHostId: args.dragHostId,
      maxContentY,
      hostSectionBounds,
      allChildItemIds: args.sidebarGroupChildItemIdsByGroupId.get(enclosingGroup.groupId) ?? [],
      groupHeaderRects: args.groupHeaderRects,
      repoHeaderRects: args.repoHeaderRects,
      projectGroupById: args.projectGroupById,
      pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
      repoById: args.repoById,
      liveRepos: args.liveRepos
    })
  }

  return resolveNonInterleavedRepoBucketSlot({
    pointerY: args.pointerY,
    containerTop: args.containerTop,
    scrollTop: args.scrollTop,
    localY,
    dragHostId: args.dragHostId,
    currentGroupId: args.currentGroupId,
    targetBucketKey,
    isCrossBucket,
    hasEmptyRootDropZone,
    draggedRepoPinned: args.draggedRepoPinned,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    repoById: args.repoById,
    liveRepos: args.liveRepos,
    enclosingGroup,
    joinableGroupIds: args.joinableGroupIds,
    hostSectionBounds,
    groupHeaderRects: args.groupHeaderRects,
    repoHeaderRects: args.repoHeaderRects,
    sidebarRepoHeaderIdsByBucket: args.sidebarRepoHeaderIdsByBucket,
    contentBottom: args.contentBottom
  })
}

export function getSessionGroupRepo(session: ProjectHeaderDragSession): Repo | null {
  return session.groupRepo === undefined ? session.repo : session.groupRepo
}

export function toRepoDragState(
  session: ProjectHeaderDragSession,
  dropTarget: ProjectHeaderDropTarget | null
): RepoDragState {
  const groupRepo = getSessionGroupRepo(session)
  const catalogHostId =
    dropTarget?.kind === 'group-header' && groupRepo
      ? getCatalogHostIdForExecutionHost(getRepoExecutionHostId(groupRepo))
      : null
  return {
    draggingRepoId: session.repo.id,
    dropIndex: dropTarget?.kind === 'slot' ? dropTarget.dropIndex : null,
    dropIndicatorY: dropTarget?.kind === 'slot' ? dropTarget.dropIndicatorY : null,
    dropTargetGroupId: dropTarget?.kind === 'group-header' ? dropTarget.groupId : null,
    dropTargetCatalogHostId: catalogHostId
  }
}
