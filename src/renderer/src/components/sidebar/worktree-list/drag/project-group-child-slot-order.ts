import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getHeaderDragRepo, type Row } from '../../../../../../shared/sidebar-list/row-types'
import { filterBucketByPinTier, resolveCrossBucketPinnedPrefixSlot } from './header-drag-pin-tier'
import {
  filterGroupChildItemIdsByCatalogHost,
  findChildRepoForCatalogHost,
  isGroupChildItemPinned,
  parseChildItemId
} from './project-group-child-catalog'
import {
  getProjectGroupHeaderDragBucketKey,
  type ProjectGroupHeaderDragRect
} from './project-group-header-drop'
import type { ProjectGroupHeaderUpdatePatch } from './project-group-header-drag-contract'
import type { ProjectHeaderDragRect } from './project-header-drop'
import {
  computeWorktreeSidebarHeaderDropPreview,
  type WorktreeSidebarHeaderDropPreview
} from './worktree-sidebar-header-drop-preview'

export {
  filterGroupChildItemIdsByCatalogHost,
  findChildRepoForCatalogHost,
  isGroupChildItemPinned,
  parseChildItemId
}

export type ProjectGroupChildItemId = `group:${string}` | `repo:${string}`

export type ProjectGroupChildDragRect = {
  itemId: ProjectGroupChildItemId
  headerIndex: number
  top: number
  bottom: number
  sectionBottom?: number
}

export type ProjectGroupChildMutation =
  | { kind: 'group'; groupId: string; updates: ProjectGroupHeaderUpdatePatch }
  | { kind: 'repo'; repo: Repo; projectGroupId: string; order: number }

const TRAILING_SUBGROUP_REORDER_LIP_PX = 12
const NEXT_HEADER_CLEARANCE_PX = 2

export function getSidebarOrderedGroupChildItemIdsByGroupId(
  rows: readonly Row[],
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
): Map<string, ProjectGroupChildItemId[]> {
  const byParentId = new Map<string, ProjectGroupChildItemId[]>()
  const pushUnique = (parentId: string, itemId: ProjectGroupChildItemId): void => {
    const list = byParentId.get(parentId) ?? []
    if (!list.includes(itemId)) {
      list.push(itemId)
      byParentId.set(parentId, list)
    }
  }
  for (const row of rows) {
    if (row.type !== 'header' || row.repeated) {
      continue
    }
    if (!row.repo && row.projectGroup && typeof row.projectGroup.id === 'string') {
      const bucketKey = getProjectGroupHeaderDragBucketKey(row.projectGroup, projectGroupById)
      if (bucketKey.startsWith('parent:')) {
        pushUnique(bucketKey.slice('parent:'.length), `group:${row.projectGroup.id}`)
      }
      continue
    }
    const repo = getHeaderDragRepo(row)
    if (repo?.projectGroupId && (!projectGroupById || projectGroupById.has(repo.projectGroupId))) {
      pushUnique(repo.projectGroupId, `repo:${repo.id}`)
    }
  }
  return byParentId
}

export function resolveTrailingSubgroupReorderEnclosure(args: {
  localY: number
  currentParentGroupId: string | null | undefined
  draggedGroupId?: string
  enclosingGroup: ProjectGroupHeaderDragRect | undefined
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects?: readonly ProjectHeaderDragRect[]
  hostSectionBottom?: number
}): ProjectGroupHeaderDragRect | undefined {
  if (!args.currentParentGroupId) {
    return args.enclosingGroup
  }
  const childBucketKey = `parent:${args.currentParentGroupId}`
  const repoChildBucketKey = `group:${args.currentParentGroupId}`
  let effectiveParentRect = args.groupHeaderRects.find(
    (rect) => rect.groupId === args.currentParentGroupId
  )
  const parentUnmounted = !effectiveParentRect
  if (!effectiveParentRect) {
    let minTop = Number.POSITIVE_INFINITY
    let maxBottom = Number.NEGATIVE_INFINITY
    for (const rect of args.groupHeaderRects) {
      if (rect.bucketKey === childBucketKey) {
        minTop = Math.min(minTop, rect.top)
        maxBottom = Math.max(maxBottom, rect.sectionBottom ?? rect.bottom)
      }
    }
    for (const rect of args.repoHeaderRects ?? []) {
      if (rect.bucketKey === repoChildBucketKey) {
        minTop = Math.min(minTop, rect.top)
        maxBottom = Math.max(maxBottom, rect.sectionBottom ?? rect.bottom)
      }
    }
    if (minTop === Number.POSITIVE_INFINITY || args.localY < minTop) {
      return args.enclosingGroup
    }
    effectiveParentRect = {
      groupId: args.currentParentGroupId,
      bucketKey: 'root',
      headerIndex: -1,
      top: minTop,
      bottom: minTop,
      sectionBottom: maxBottom
    }
  }
  if (args.enclosingGroup && args.enclosingGroup.top >= effectiveParentRect.top) {
    return args.enclosingGroup
  }
  const parentSectionBottom = effectiveParentRect.sectionBottom ?? effectiveParentRect.bottom
  if (parentUnmounted && args.localY <= parentSectionBottom) {
    return effectiveParentRect
  }
  const hasTrailingOtherSubgroup = args.groupHeaderRects.some(
    (rect) =>
      rect.bucketKey === childBucketKey &&
      rect.groupId !== args.draggedGroupId &&
      (rect.sectionBottom ?? rect.bottom) === parentSectionBottom
  )
  if (!hasTrailingOtherSubgroup || args.localY <= parentSectionBottom) {
    return args.enclosingGroup
  }
  let nextHeaderTop = args.hostSectionBottom ?? Number.POSITIVE_INFINITY
  for (const rect of args.groupHeaderRects) {
    if (rect.top > parentSectionBottom) {
      nextHeaderTop = Math.min(nextHeaderTop, rect.top)
    }
  }
  for (const rect of args.repoHeaderRects ?? []) {
    if (rect.top > parentSectionBottom) {
      nextHeaderTop = Math.min(nextHeaderTop, rect.top)
    }
  }
  const maxLipY = Math.min(
    parentSectionBottom + TRAILING_SUBGROUP_REORDER_LIP_PX,
    nextHeaderTop - NEXT_HEADER_CLEARANCE_PX
  )
  return args.localY <= maxLipY ? effectiveParentRect : args.enclosingGroup
}

export function computeProjectGroupMixedChildDropPreview(args: {
  parentGroupId: string
  pointerY: number
  containerTop: number
  scrollTop: number
  localY: number
  isCrossBucket: boolean
  targetPinned: boolean
  dragHostId?: ExecutionHostId
  enclosingGroupBottom?: number
  contentBottom?: number
  hostSectionBounds?: { top: number; bottom: number } | null
  allChildItemIds: readonly ProjectGroupChildItemId[]
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects: readonly ProjectHeaderDragRect[]
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
}): WorktreeSidebarHeaderDropPreview | null {
  const allItemIds = filterGroupChildItemIdsByCatalogHost({
    itemIds: args.allChildItemIds,
    ownerHostId: args.dragHostId,
    projectGroupById: args.projectGroupById,
    repoById: args.repoById,
    liveRepos: args.liveRepos
  })
  const allIndexById = new Map(allItemIds.map((id, index) => [id, index]))
  const groupBucketKey = `parent:${args.parentGroupId}`
  const repoBucketKey = `group:${args.parentGroupId}`
  const inHostBounds = (top: number): boolean =>
    !args.hostSectionBounds ||
    (top >= args.hostSectionBounds.top && top < args.hostSectionBounds.bottom)

  const allRects: ProjectGroupChildDragRect[] = []
  for (const rect of args.groupHeaderRects) {
    const itemId: ProjectGroupChildItemId = `group:${rect.groupId}`
    const headerIndex = allIndexById.get(itemId)
    if (rect.bucketKey === groupBucketKey && headerIndex !== undefined && inHostBounds(rect.top)) {
      allRects.push({
        itemId,
        headerIndex,
        top: rect.top,
        bottom: rect.bottom,
        sectionBottom: rect.sectionBottom
      })
    }
  }
  for (const rect of args.repoHeaderRects) {
    const itemId: ProjectGroupChildItemId = `repo:${rect.repoId}`
    const headerIndex = allIndexById.get(itemId)
    if (rect.bucketKey === repoBucketKey && headerIndex !== undefined && inHostBounds(rect.top)) {
      allRects.push({
        itemId,
        headerIndex,
        top: rect.top,
        bottom: rect.bottom,
        sectionBottom: rect.sectionBottom
      })
    }
  }
  allRects.sort((left, right) => left.top - right.top)

  const { tierHeaderIds, tierRects } = filterBucketByPinTier({
    allHeaderIds: allItemIds,
    allRects,
    getId: (rect) => rect.itemId,
    isIdPinned: (id) =>
      isGroupChildItemPinned(
        id,
        args.projectGroupById,
        args.pinnedRepoHeaderIds,
        args.repoById,
        args.dragHostId,
        args.liveRepos
      ),
    targetPinned: args.targetPinned
  })

  if (args.isCrossBucket && tierHeaderIds.length === 0) {
    return resolveCrossBucketPinnedPrefixSlot({
      localY: args.localY,
      scrollTop: args.scrollTop,
      contentBottom: args.contentBottom,
      enclosingGroupBottom: args.enclosingGroupBottom,
      allBucketHeaderCount: allItemIds.length,
      allBucketRects: allRects,
      tierHeaderCount: 0,
      tierRects
    })
  }

  return (
    computeWorktreeSidebarHeaderDropPreview({
      pointerY: args.pointerY,
      containerTop: args.containerTop,
      scrollTop: args.scrollTop,
      rects: tierRects,
      headerCount: tierHeaderIds.length,
      getId: (rect) => rect.itemId,
      contentBottom: args.contentBottom
    }) ??
    (args.isCrossBucket
      ? resolveCrossBucketPinnedPrefixSlot({
          localY: args.localY,
          scrollTop: args.scrollTop,
          contentBottom: args.contentBottom,
          enclosingGroupBottom: args.enclosingGroupBottom,
          allBucketHeaderCount: allItemIds.length,
          allBucketRects: allRects,
          tierHeaderCount: tierHeaderIds.length,
          tierRects
        })
      : null)
  )
}
