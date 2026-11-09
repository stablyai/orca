import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getProjectGroupSubtreeIds } from '../../../../../../shared/project-groups'
import type { HostHeaderRect } from './host-header-drag-dom'
import {
  findInnermostEnclosingGroupRect,
  getCatalogHostIdForExecutionHost,
  isGroupHeaderBandHit,
  resolveHostSectionBounds
} from './group-header-hit-geometry'
import {
  computeProjectGroupMixedChildDropPreview,
  resolveTrailingSubgroupReorderEnclosure,
  type ProjectGroupChildItemId
} from './project-group-child-slot-order'
import {
  computeProjectGroupHeaderDropPreview,
  getProjectGroupHeaderDragBucketKey,
  type ProjectGroupHeaderDragBucketKey,
  type ProjectGroupHeaderDragRect
} from './project-group-header-drop'
import {
  ROOT_INTERLEAVED_GROUP_BUCKET_KEY,
  type ProjectGroupDragState
} from './project-group-header-drag-contract'
import type { ProjectHeaderDragRect } from './project-header-drop'
import {
  filterProjectGroupIdsByCatalogHost,
  resolveGroupOnlyBucketSlot,
  resolveNestedGroupExitToGrandparentSlot
} from './project-group-nested-exit-drop'

export { filterProjectGroupIdsByCatalogHost }

export type ProjectGroupHeaderDropTarget =
  | { kind: 'group-header'; groupId: string }
  | {
      kind: 'slot'
      targetBucketKey: ProjectGroupHeaderDragBucketKey
      dropIndex: number
      dropIndicatorY: number
    }

const ROOT_TAIL_SLOP_PX = 32
const NESTED_EXIT_TAIL_SLOP_PX = 56
const INDICATOR_GAP_PX = 4

export function parseParentGroupIdFromBucketKey(
  bucketKey: ProjectGroupHeaderDragBucketKey
): string | null {
  return bucketKey.startsWith('parent:') ? bucketKey.slice('parent:'.length) : null
}

export function getReparentableTargetGroupIdsForGroup(
  group: ProjectGroup,
  projectGroups: readonly ProjectGroup[]
): Set<string> {
  const ownerHostId = getRepoExecutionHostId(group)
  if (!getCatalogHostIdForExecutionHost(ownerHostId)) {
    return new Set()
  }
  const sameHostGroups = projectGroups.filter(
    (candidate) => getRepoExecutionHostId(candidate) === ownerHostId
  )
  const subtreeIds = getProjectGroupSubtreeIds(sameHostGroups, group.id)
  return new Set(
    sameHostGroups.filter((candidate) => !subtreeIds.has(candidate.id)).map((c) => c.id)
  )
}

export function canProjectGroupStartHeaderDrag(args: {
  group: ProjectGroup
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  sidebarBucketHeaderIds: readonly string[]
  rootProjectHeaderCount?: number
  reparentableGroupIds: ReadonlySet<string>
}): boolean {
  const bucketKey = getProjectGroupHeaderDragBucketKey(args.group, args.projectGroupById)
  if (bucketKey !== 'root') {
    return true
  }
  if ((args.rootProjectHeaderCount ?? 0) > 1) {
    return true
  }
  const sameHostIds = filterProjectGroupIdsByCatalogHost(
    args.sidebarBucketHeaderIds,
    getRepoExecutionHostId(args.group),
    args.projectGroupById
  )
  const draggedPinned = args.group.isPinned === true
  const sameTierSameHostIds = sameHostIds.filter(
    (id) => (args.projectGroupById.get(id)?.isPinned === true) === draggedPinned
  )
  if (sameTierSameHostIds.length > 1) {
    return true
  }
  const currentParentGroupId = parseParentGroupIdFromBucketKey(bucketKey)
  return [...args.reparentableGroupIds].some((id) => id !== currentParentGroupId)
}

export function computeCombinedProjectGroupHeaderDropTarget(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  dragHostId?: ExecutionHostId
  draggedGroup: ProjectGroup
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  reparentableGroupIds: ReadonlySet<string>
  hostHeaderRects?: readonly HostHeaderRect[]
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  rootProjectHeaderKeys?: readonly string[]
  rootHeaderRects?: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects?: readonly ProjectHeaderDragRect[]
  allowMixedProjectReorder?: boolean
  sidebarGroupChildItemIdsByGroupId?: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  pinnedRepoHeaderIds?: ReadonlySet<string>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  contentBottom?: number
}): ProjectGroupHeaderDropTarget | null {
  const localY = args.pointerY - args.containerTop + args.scrollTop
  const currentBucketKey = getProjectGroupHeaderDragBucketKey(
    args.draggedGroup,
    args.projectGroupById
  )
  const currentParentGroupId = parseParentGroupIdFromBucketKey(currentBucketKey)
  const tailAllowancePx = currentBucketKey !== 'root' ? NESTED_EXIT_TAIL_SLOP_PX : ROOT_TAIL_SLOP_PX
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
      groupRect.groupId === args.draggedGroup.id ||
      !args.reparentableGroupIds.has(groupRect.groupId)
    ) {
      return null
    }
    if (isGroupHeaderBandHit(localY, groupRect)) {
      return groupRect.groupId === currentParentGroupId
        ? null
        : { kind: 'group-header', groupId: groupRect.groupId }
    }
  }

  // Exclude same-parent sibling subgroup bodies so dragging a subgroup past an expanded sibling reorders within the parent group instead of nesting.
  const excludedEnclosureIds = new Set<string>()
  for (const rect of args.groupHeaderRects) {
    if (
      !args.reparentableGroupIds.has(rect.groupId) ||
      (currentBucketKey !== 'root' && rect.bucketKey === currentBucketKey)
    ) {
      excludedEnclosureIds.add(rect.groupId)
    }
  }
  const enclosingGroup = resolveTrailingSubgroupReorderEnclosure({
    localY,
    currentParentGroupId,
    draggedGroupId: args.draggedGroup.id,
    enclosingGroup: findInnermostEnclosingGroupRect(
      localY,
      args.groupHeaderRects,
      excludedEnclosureIds
    ),
    groupHeaderRects: args.groupHeaderRects,
    repoHeaderRects: args.repoHeaderRects,
    hostSectionBottom: hostSectionBounds?.bottom
  })
  const effectiveDragHostId = args.dragHostId ?? getRepoExecutionHostId(args.draggedGroup)
  if (!enclosingGroup) {
    const grandparentExitSlot = resolveNestedGroupExitToGrandparentSlot({
      localY,
      scrollTop: args.scrollTop,
      dragHostId: effectiveDragHostId,
      currentParentGroupId,
      projectGroupById: args.projectGroupById,
      reparentableGroupIds: args.reparentableGroupIds,
      groupHeaderRects: args.groupHeaderRects,
      allowMixedProjectReorder: args.allowMixedProjectReorder,
      sidebarGroupChildItemIdsByGroupId: args.sidebarGroupChildItemIdsByGroupId,
      pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
      repoById: args.repoById,
      liveRepos: args.liveRepos,
      sidebarProjectGroupHeaderIdsByBucket: args.sidebarProjectGroupHeaderIdsByBucket,
      hostSectionBottom: hostSectionBounds?.bottom
    })
    if (grandparentExitSlot) {
      return grandparentExitSlot
    }
    if (
      args.rootProjectHeaderKeys &&
      args.rootHeaderRects &&
      (currentBucketKey === 'root' || args.rootProjectHeaderKeys.length > 0)
    ) {
      const rootPreview = computeProjectGroupHeaderDropPreview({
        pointerY: args.pointerY,
        containerTop: args.containerTop,
        scrollTop: args.scrollTop,
        rects: args.rootHeaderRects,
        sidebarProjectGroupHeaderIds: args.rootProjectHeaderKeys,
        contentBottom: currentBucketKey !== 'root' ? maxContentY : args.contentBottom
      })
      return rootPreview
        ? {
            kind: 'slot',
            targetBucketKey: ROOT_INTERLEAVED_GROUP_BUCKET_KEY,
            ...rootPreview
          }
        : null
    }
  }

  const targetBucketKey: ProjectGroupHeaderDragBucketKey = enclosingGroup
    ? `parent:${enclosingGroup.groupId}`
    : 'root'
  const isCrossBucket = targetBucketKey !== currentBucketKey

  if (enclosingGroup && args.allowMixedProjectReorder && args.sidebarGroupChildItemIdsByGroupId) {
    const allChildItemIds = args.sidebarGroupChildItemIdsByGroupId.get(enclosingGroup.groupId) ?? []
    if (allChildItemIds.length === 0) {
      if (enclosingGroup.groupId === currentParentGroupId) {
        return null
      }
      const anchorY = enclosingGroup.sectionBottom ?? enclosingGroup.bottom
      return {
        kind: 'slot',
        targetBucketKey,
        dropIndex: 0,
        dropIndicatorY: Math.max(args.scrollTop, anchorY + INDICATOR_GAP_PX)
      }
    }
    const mixedPreview = computeProjectGroupMixedChildDropPreview({
      parentGroupId: enclosingGroup.groupId,
      pointerY: args.pointerY,
      containerTop: args.containerTop,
      scrollTop: args.scrollTop,
      localY,
      isCrossBucket,
      targetPinned: isCrossBucket ? false : args.draggedGroup.isPinned === true,
      dragHostId: effectiveDragHostId,
      enclosingGroupBottom: enclosingGroup.bottom,
      contentBottom: maxContentY,
      hostSectionBounds,
      allChildItemIds,
      groupHeaderRects: args.groupHeaderRects,
      repoHeaderRects: args.repoHeaderRects ?? [],
      projectGroupById: args.projectGroupById,
      pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
      repoById: args.repoById,
      liveRepos: args.liveRepos
    })
    return mixedPreview ? { kind: 'slot', targetBucketKey, ...mixedPreview } : null
  }

  return resolveGroupOnlyBucketSlot({
    pointerY: args.pointerY,
    containerTop: args.containerTop,
    scrollTop: args.scrollTop,
    localY,
    targetBucketKey,
    currentParentGroupId,
    isCrossBucket,
    draggedPinned: args.draggedGroup.isPinned === true,
    dragHostId: effectiveDragHostId,
    enclosingGroup,
    hostSectionBounds,
    groupHeaderRects: args.groupHeaderRects,
    repoHeaderRects: args.repoHeaderRects,
    projectGroupById: args.projectGroupById,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    repoById: args.repoById,
    sidebarProjectGroupHeaderIdsByBucket: args.sidebarProjectGroupHeaderIdsByBucket,
    contentBottom: args.contentBottom,
    maxContentY
  })
}

export function toProjectGroupDragState(
  groupId: string,
  catalogHostId: ExecutionHostId | null,
  dropTarget: ProjectGroupHeaderDropTarget | null
): ProjectGroupDragState {
  return {
    draggingGroupId: groupId,
    dropIndex: dropTarget?.kind === 'slot' ? dropTarget.dropIndex : null,
    dropIndicatorY: dropTarget?.kind === 'slot' ? dropTarget.dropIndicatorY : null,
    dropTargetGroupId: dropTarget?.kind === 'group-header' ? dropTarget.groupId : null,
    dropTargetCatalogHostId: dropTarget?.kind === 'group-header' ? catalogHostId : null
  }
}
