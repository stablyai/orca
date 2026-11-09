import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'
import {
  filterBucketByPinTier,
  isRepoHeaderIdPinned,
  resolveCrossBucketPinnedPrefixSlot
} from './header-drag-pin-tier'
import {
  filterGroupChildItemIdsByCatalogHost,
  isGroupChildItemPinned,
  type ProjectGroupChildItemId
} from './project-group-child-slot-order'
import {
  computeProjectGroupHeaderDropPreview,
  type ProjectGroupHeaderDragBucketKey,
  type ProjectGroupHeaderDragRect
} from './project-group-header-drop'
import type { ProjectGroupHeaderDropTarget } from './project-group-header-reparent-drop'
import type { ProjectHeaderDragRect } from './project-header-drop'

const NESTED_GROUP_EXIT_BAND_PX = 24
const INDICATOR_GAP_PX = 4

export function filterProjectGroupIdsByCatalogHost(
  groupIds: readonly string[],
  ownerHostId: ExecutionHostId | null | undefined,
  projectGroupById: ReadonlyMap<string, ProjectGroup>
): string[] {
  const catalogHostId = getCatalogHostIdForExecutionHost(ownerHostId ?? undefined)
  if (!catalogHostId) {
    return [...groupIds]
  }
  return groupIds.filter((groupId) => {
    const candidate = projectGroupById.get(groupId)
    return (
      !candidate ||
      getCatalogHostIdForExecutionHost(getRepoExecutionHostId(candidate)) === catalogHostId
    )
  })
}

export function resolveNestedGroupExitToGrandparentSlot(args: {
  localY: number
  scrollTop: number
  dragHostId?: ExecutionHostId
  currentParentGroupId: string | null
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  reparentableGroupIds: ReadonlySet<string>
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  allowMixedProjectReorder?: boolean
  sidebarGroupChildItemIdsByGroupId?: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  hostSectionBottom?: number
}): ProjectGroupHeaderDropTarget | null {
  if (!args.currentParentGroupId) {
    return null
  }
  const parentGroup = args.projectGroupById.get(args.currentParentGroupId)
  const grandparentId =
    parentGroup?.parentGroupId && args.projectGroupById.has(parentGroup.parentGroupId)
      ? parentGroup.parentGroupId
      : null
  if (!grandparentId || !args.reparentableGroupIds.has(grandparentId)) {
    return null
  }
  const parentRect = args.groupHeaderRects.find(
    (rect) => rect.groupId === args.currentParentGroupId
  )
  if (!parentRect) {
    return null
  }
  const parentSectionBottom = parentRect.sectionBottom ?? parentRect.bottom
  const maxExitY = Math.min(
    parentSectionBottom + NESTED_GROUP_EXIT_BAND_PX,
    args.hostSectionBottom ?? Number.POSITIVE_INFINITY
  )
  if (args.localY <= parentSectionBottom || args.localY > maxExitY) {
    return null
  }
  const parentIsPinned = parentGroup?.isPinned === true
  const grandparentBucketKey: ProjectGroupHeaderDragBucketKey = `parent:${grandparentId}`
  if (args.allowMixedProjectReorder && args.sidebarGroupChildItemIdsByGroupId) {
    const unpinnedChildIds = filterGroupChildItemIdsByCatalogHost({
      itemIds: args.sidebarGroupChildItemIdsByGroupId.get(grandparentId) ?? [],
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
    const parentIndex = unpinnedChildIds.indexOf(`group:${args.currentParentGroupId}`)
    return {
      kind: 'slot',
      targetBucketKey: grandparentBucketKey,
      dropIndex: parentIsPinned
        ? 0
        : parentIndex === -1
          ? unpinnedChildIds.length
          : parentIndex + 1,
      dropIndicatorY: Math.max(args.scrollTop, parentSectionBottom + INDICATOR_GAP_PX)
    }
  }
  const siblingIds = filterProjectGroupIdsByCatalogHost(
    args.sidebarProjectGroupHeaderIdsByBucket.get(grandparentBucketKey) ?? [],
    args.dragHostId,
    args.projectGroupById
  )
  const unpinnedSiblingIds = siblingIds.filter(
    (id) => args.projectGroupById.get(id)?.isPinned !== true
  )
  const parentIndex = unpinnedSiblingIds.indexOf(args.currentParentGroupId)
  const dropIndex = parentIsPinned
    ? 0
    : parentIndex === -1
      ? unpinnedSiblingIds.length
      : parentIndex + 1
  return {
    kind: 'slot',
    targetBucketKey: grandparentBucketKey,
    dropIndex,
    dropIndicatorY: Math.max(args.scrollTop, parentSectionBottom + INDICATOR_GAP_PX)
  }
}

export function resolveGroupOnlyBucketSlot(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  localY: number
  targetBucketKey: ProjectGroupHeaderDragBucketKey
  currentParentGroupId: string | null
  isCrossBucket: boolean
  draggedPinned: boolean
  dragHostId?: ExecutionHostId
  enclosingGroup: ProjectGroupHeaderDragRect | undefined
  hostSectionBounds: { top: number; bottom: number } | null
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects?: readonly ProjectHeaderDragRect[]
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  contentBottom?: number
  maxContentY?: number
}): ProjectGroupHeaderDropTarget | null {
  const allBucketHeaderIds = filterProjectGroupIdsByCatalogHost(
    args.sidebarProjectGroupHeaderIdsByBucket.get(args.targetBucketKey) ?? [],
    args.dragHostId,
    args.projectGroupById
  )
  const allBucketIndexById = new Map(allBucketHeaderIds.map((id, index) => [id, index]))
  const allBucketRects = args.groupHeaderRects.flatMap((rect) => {
    const headerIndex = allBucketIndexById.get(rect.groupId)
    if (
      rect.bucketKey !== args.targetBucketKey ||
      headerIndex === undefined ||
      (args.hostSectionBounds &&
        (rect.top < args.hostSectionBounds.top || rect.top >= args.hostSectionBounds.bottom))
    ) {
      return []
    }
    return [{ ...rect, headerIndex }]
  })

  if (
    args.enclosingGroup &&
    (allBucketHeaderIds.length === 0 ||
      (args.hostSectionBounds !== null && allBucketRects.length === 0))
  ) {
    if (args.enclosingGroup.groupId === args.currentParentGroupId) {
      return null
    }
    const repoBucketKey = `group:${args.enclosingGroup.groupId}`
    let firstUnpinnedRepoTop: number | undefined
    for (const rect of args.repoHeaderRects ?? []) {
      if (
        rect.bucketKey !== repoBucketKey ||
        (args.hostSectionBounds &&
          (rect.top < args.hostSectionBounds.top || rect.top >= args.hostSectionBounds.bottom)) ||
        isRepoHeaderIdPinned(rect.repoId, args.pinnedRepoHeaderIds, args.repoById)
      ) {
        continue
      }
      firstUnpinnedRepoTop =
        firstUnpinnedRepoTop === undefined ? rect.top : Math.min(firstUnpinnedRepoTop, rect.top)
    }
    const anchorY = args.enclosingGroup.sectionBottom ?? args.enclosingGroup.bottom
    const dropIndicatorY =
      firstUnpinnedRepoTop !== undefined
        ? Math.max(args.scrollTop, Math.max(0, firstUnpinnedRepoTop - INDICATOR_GAP_PX))
        : Math.max(args.scrollTop, anchorY + INDICATOR_GAP_PX)
    return {
      kind: 'slot',
      targetBucketKey: args.targetBucketKey,
      dropIndex: 0,
      dropIndicatorY
    }
  }

  const { tierHeaderIds: bucketHeaderIds, tierRects: bucketRects } = filterBucketByPinTier({
    allHeaderIds: allBucketHeaderIds,
    allRects: allBucketRects,
    getId: (rect) => rect.groupId,
    isIdPinned: (id) => args.projectGroupById.get(id)?.isPinned === true,
    targetPinned: args.isCrossBucket ? false : args.draggedPinned
  })

  const previewContentBottom =
    args.isCrossBucket || args.enclosingGroup ? args.maxContentY : args.contentBottom
  if (args.isCrossBucket && bucketHeaderIds.length === 0) {
    const pinnedOnlySlot = resolveCrossBucketPinnedPrefixSlot({
      localY: args.localY,
      scrollTop: args.scrollTop,
      contentBottom: previewContentBottom,
      enclosingGroupBottom: args.enclosingGroup?.bottom,
      allBucketHeaderCount: allBucketHeaderIds.length,
      allBucketRects,
      tierHeaderCount: 0,
      tierRects: bucketRects
    })
    return pinnedOnlySlot
      ? { kind: 'slot', targetBucketKey: args.targetBucketKey, ...pinnedOnlySlot }
      : null
  }

  const preview =
    computeProjectGroupHeaderDropPreview({
      pointerY: args.pointerY,
      containerTop: args.containerTop,
      scrollTop: args.scrollTop,
      rects: bucketRects,
      sidebarProjectGroupHeaderIds: bucketHeaderIds,
      contentBottom: previewContentBottom
    }) ??
    (args.isCrossBucket
      ? resolveCrossBucketPinnedPrefixSlot({
          localY: args.localY,
          scrollTop: args.scrollTop,
          contentBottom: previewContentBottom,
          enclosingGroupBottom: args.enclosingGroup?.bottom,
          allBucketHeaderCount: allBucketHeaderIds.length,
          allBucketRects,
          tierHeaderCount: bucketHeaderIds.length,
          tierRects: bucketRects
        })
      : null)
  return preview ? { kind: 'slot', targetBucketKey: args.targetBucketKey, ...preview } : null
}
