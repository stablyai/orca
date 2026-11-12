import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import { reindexBucketRectsByHeaderIds, resolveRepoOnlyBucketSlot } from './header-drag-pin-tier'
import { filterRepoHeaderIdsByCatalogHost } from './project-group-child-catalog'
import type { ProjectGroupHeaderDragRect } from './project-group-header-drop'
import type { ProjectHeaderDragBucketKey, ProjectHeaderDragRect } from './project-header-drop'
import type { ProjectHeaderDropTarget } from './project-header-group-drop'
import {
  resolveEmptyGroupInteriorSlot,
  resolveEmptyUngroupedRootSlot
} from './project-header-subgroup-exit-drop'

export function resolveNonInterleavedRepoBucketSlot(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  localY: number
  dragHostId?: ExecutionHostId
  currentGroupId: string | null
  targetBucketKey: ProjectHeaderDragBucketKey
  isCrossBucket: boolean
  hasEmptyRootDropZone: boolean
  draggedRepoPinned?: boolean
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  enclosingGroup: ProjectGroupHeaderDragRect | undefined
  joinableGroupIds: ReadonlySet<string>
  hostSectionBounds: { top: number; bottom: number } | null
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects: readonly ProjectHeaderDragRect[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  contentBottom?: number
}): ProjectHeaderDropTarget | null {
  const allBucketHeaderIds = filterRepoHeaderIdsByCatalogHost(
    args.sidebarRepoHeaderIdsByBucket.get(args.targetBucketKey) ?? [],
    args.dragHostId,
    args.liveRepos,
    args.repoById
  )
  const allBucketRects = args.repoHeaderRects.filter(
    (rect) =>
      rect.bucketKey === args.targetBucketKey &&
      (!args.hostSectionBounds ||
        (rect.top >= args.hostSectionBounds.top && rect.top < args.hostSectionBounds.bottom))
  )
  if (
    args.enclosingGroup &&
    (allBucketHeaderIds.length === 0 ||
      (args.hostSectionBounds !== null && allBucketRects.length === 0))
  ) {
    return resolveEmptyGroupInteriorSlot({
      enclosingGroup: args.enclosingGroup,
      currentGroupId: args.currentGroupId,
      scrollTop: args.scrollTop
    })
  }
  if (
    args.targetBucketKey === 'ungrouped' &&
    (allBucketHeaderIds.length === 0 ||
      (args.hostSectionBounds !== null && allBucketRects.length === 0))
  ) {
    return resolveEmptyUngroupedRootSlot({
      localY: args.localY,
      scrollTop: args.scrollTop,
      currentGroupId: args.currentGroupId,
      joinableGroupIds: args.joinableGroupIds,
      groupHeaderRects: args.groupHeaderRects,
      hostSectionBottom: args.hostSectionBounds?.bottom
    })
  }
  const slot = resolveRepoOnlyBucketSlot({
    pointerY: args.pointerY,
    containerTop: args.containerTop,
    scrollTop: args.scrollTop,
    localY: args.localY,
    targetBucketKey: args.targetBucketKey,
    isCrossBucket: args.isCrossBucket,
    draggedRepoPinned: args.draggedRepoPinned,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    repoById: args.repoById,
    enclosingGroupBottom: args.enclosingGroup?.bottom,
    allBucketHeaderIds,
    allBucketRects,
    contentBottom: args.contentBottom
  })
  if (slot || args.targetBucketKey !== 'ungrouped' || !args.hasEmptyRootDropZone) {
    return slot
  }
  const hostBucketRects = reindexBucketRectsByHeaderIds(
    allBucketHeaderIds,
    allBucketRects,
    (rect) => rect.repoId
  )
  const lastPinnedRect = hostBucketRects.at(-1)
  if (
    !lastPinnedRect ||
    lastPinnedRect.headerIndex !== allBucketHeaderIds.length - 1 ||
    args.localY <= Math.max(lastPinnedRect.bottom, lastPinnedRect.sectionBottom ?? 0)
  ) {
    return null
  }
  return resolveEmptyUngroupedRootSlot({
    localY: args.localY,
    scrollTop: args.scrollTop,
    currentGroupId: args.currentGroupId,
    joinableGroupIds: args.joinableGroupIds,
    groupHeaderRects: args.groupHeaderRects,
    hostSectionBottom: args.hostSectionBounds?.bottom
  })
}
