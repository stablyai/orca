import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { isRepoHeaderIdPinned, resolveRepoOnlyBucketSlot } from './header-drag-pin-tier'
import { filterRepoHeaderIdsByCatalogHost } from './project-group-child-catalog'
import {
  computeProjectGroupMixedChildDropPreview,
  filterGroupChildItemIdsByCatalogHost,
  isGroupChildItemPinned,
  type ProjectGroupChildItemId
} from './project-group-child-slot-order'
import type { ProjectGroupHeaderDragRect } from './project-group-header-drop'
import type { ProjectHeaderDragBucketKey, ProjectHeaderDragRect } from './project-header-drop'
import type { ProjectHeaderDropTarget } from './project-header-group-drop'

export { resolveRepoOnlyBucketSlot }

const INDICATOR_GAP_PX = 4
const EMPTY_ROOT_DROP_RANGE_PX = 96
const SUBGROUP_EXIT_TO_PARENT_BAND_PX = 20
const SUBGROUP_EXIT_INTO_NEXT_HEADER_SLOP_PX = 4

function parseParentGroupIdFromGroupBucketKey(bucketKey: string): string | null {
  return bucketKey.startsWith('parent:') ? bucketKey.slice('parent:'.length) : null
}

export function resolveEmptyUngroupedRootSlot(args: {
  localY: number
  scrollTop: number
  currentGroupId: string | null
  joinableGroupIds: ReadonlySet<string>
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  hostSectionBottom?: number
}): ProjectHeaderDropTarget | null {
  if (args.currentGroupId === null) {
    return null
  }
  let maxGroupBottom = 0
  let joinableGroupCount = 0
  for (const groupRect of args.groupHeaderRects) {
    if (!args.joinableGroupIds.has(groupRect.groupId)) {
      continue
    }
    joinableGroupCount++
    maxGroupBottom = Math.max(maxGroupBottom, groupRect.sectionBottom ?? groupRect.bottom)
  }
  if (joinableGroupCount === 0) {
    return null
  }
  const maxEmptyRootY = Math.min(
    maxGroupBottom + EMPTY_ROOT_DROP_RANGE_PX,
    args.hostSectionBottom ?? Number.POSITIVE_INFINITY
  )
  if (args.localY > maxGroupBottom && args.localY <= maxEmptyRootY) {
    return {
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 0,
      dropIndicatorY: Math.max(args.scrollTop, maxGroupBottom + INDICATOR_GAP_PX)
    }
  }
  return null
}

export function resolveEmptyGroupInteriorSlot(args: {
  enclosingGroup: ProjectGroupHeaderDragRect
  currentGroupId: string | null
  scrollTop: number
}): ProjectHeaderDropTarget | null {
  if (args.enclosingGroup.groupId === args.currentGroupId) {
    return null
  }
  return {
    kind: 'slot',
    targetBucketKey: `group:${args.enclosingGroup.groupId}`,
    dropIndex: 0,
    dropIndicatorY: Math.max(args.scrollTop, args.enclosingGroup.bottom + INDICATOR_GAP_PX)
  }
}

export function resolveSubgroupExitToParentSlot(args: {
  localY: number
  scrollTop: number
  dragHostId?: ExecutionHostId
  currentGroupId: string | null
  currentParentGroupId?: string | null
  joinableGroupIds: ReadonlySet<string>
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects: readonly ProjectHeaderDragRect[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  sidebarGroupChildItemIdsByGroupId?: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  hostSectionBottom?: number
}): ProjectHeaderDropTarget | null {
  if (!args.currentGroupId) {
    return null
  }
  const currentGroupRect = args.groupHeaderRects.find(
    (rect) => rect.groupId === args.currentGroupId
  )
  const parentGroupId =
    args.currentParentGroupId !== undefined
      ? args.currentParentGroupId
      : currentGroupRect
        ? parseParentGroupIdFromGroupBucketKey(currentGroupRect.bucketKey)
        : null
  if (!parentGroupId || !args.joinableGroupIds.has(parentGroupId) || !currentGroupRect) {
    return null
  }
  const subBottom = currentGroupRect.sectionBottom ?? currentGroupRect.bottom
  if (args.localY <= subBottom) {
    return null
  }

  let nextRootTop = args.hostSectionBottom ?? Number.POSITIVE_INFINITY
  for (const groupRect of args.groupHeaderRects) {
    if (groupRect.bucketKey === 'root' && groupRect.top >= subBottom) {
      nextRootTop = Math.min(nextRootTop, groupRect.top)
    }
  }
  for (const repoRect of args.repoHeaderRects) {
    if (repoRect.bucketKey === 'ungrouped' && repoRect.top >= subBottom) {
      nextRootTop = Math.min(nextRootTop, repoRect.top)
    }
  }

  const maxExitY = Number.isFinite(nextRootTop)
    ? Math.min(
        subBottom + SUBGROUP_EXIT_TO_PARENT_BAND_PX,
        nextRootTop + SUBGROUP_EXIT_INTO_NEXT_HEADER_SLOP_PX
      )
    : subBottom + SUBGROUP_EXIT_TO_PARENT_BAND_PX
  if (args.localY > maxExitY) {
    return null
  }

  const currentGroupIsPinned = args.projectGroupById?.get(args.currentGroupId)?.isPinned === true
  const targetBucketKey: ProjectHeaderDragBucketKey = `group:${parentGroupId}`
  if (args.sidebarGroupChildItemIdsByGroupId) {
    const unpinnedParentChildIds = filterGroupChildItemIdsByCatalogHost({
      itemIds: args.sidebarGroupChildItemIdsByGroupId.get(parentGroupId) ?? [],
      ownerHostId: args.dragHostId,
      projectGroupById: args.projectGroupById,
      repoById: args.repoById,
      liveRepos: args.liveRepos
    }).filter(
      (id) =>
        !isGroupChildItemPinned(
          id,
          args.projectGroupById,
          args.pinnedRepoHeaderIds,
          args.repoById,
          args.dragHostId,
          args.liveRepos
        )
    )
    const subIndex = unpinnedParentChildIds.indexOf(`group:${args.currentGroupId}`)
    return {
      kind: 'slot',
      targetBucketKey,
      dropIndex: currentGroupIsPinned
        ? 0
        : subIndex === -1
          ? unpinnedParentChildIds.length
          : subIndex + 1,
      dropIndicatorY: Math.max(args.scrollTop, subBottom + 2)
    }
  }
  const parentRepoIds = filterRepoHeaderIdsByCatalogHost(
    args.sidebarRepoHeaderIdsByBucket.get(targetBucketKey) ?? [],
    args.dragHostId,
    args.liveRepos,
    args.repoById
  ).filter((repoId) => !isRepoHeaderIdPinned(repoId, args.pinnedRepoHeaderIds, args.repoById))
  return {
    kind: 'slot',
    targetBucketKey,
    dropIndex: currentGroupIsPinned ? 0 : parentRepoIds.length,
    dropIndicatorY: Math.max(args.scrollTop, subBottom + 2)
  }
}

export function resolveMixedParentGroupRepoSlot(args: {
  enclosingGroup: ProjectGroupHeaderDragRect
  targetBucketKey: ProjectHeaderDragBucketKey
  currentGroupId: string | null
  pointerY: number
  containerTop: number
  scrollTop: number
  localY: number
  isCrossBucket: boolean
  draggedRepoPinned?: boolean
  dragHostId?: ExecutionHostId
  maxContentY?: number
  hostSectionBounds: { top: number; bottom: number } | null
  allChildItemIds: readonly ProjectGroupChildItemId[]
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects: readonly ProjectHeaderDragRect[]
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
}): ProjectHeaderDropTarget | null {
  if (args.allChildItemIds.length === 0) {
    return resolveEmptyGroupInteriorSlot({
      enclosingGroup: args.enclosingGroup,
      currentGroupId: args.currentGroupId,
      scrollTop: args.scrollTop
    })
  }
  const mixedPreview = computeProjectGroupMixedChildDropPreview({
    parentGroupId: args.enclosingGroup.groupId,
    pointerY: args.pointerY,
    containerTop: args.containerTop,
    scrollTop: args.scrollTop,
    localY: args.localY,
    isCrossBucket: args.isCrossBucket,
    targetPinned: args.isCrossBucket ? false : Boolean(args.draggedRepoPinned),
    dragHostId: args.dragHostId,
    enclosingGroupBottom: args.enclosingGroup.bottom,
    contentBottom: args.maxContentY,
    hostSectionBounds: args.hostSectionBounds,
    allChildItemIds: args.allChildItemIds,
    groupHeaderRects: args.groupHeaderRects,
    repoHeaderRects: args.repoHeaderRects,
    projectGroupById: args.projectGroupById,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    repoById: args.repoById,
    liveRepos: args.liveRepos
  })
  return mixedPreview
    ? { kind: 'slot', targetBucketKey: args.targetBucketKey, ...mixedPreview }
    : null
}
