import type { ProjectGroupHeaderDragRect } from './project-group-header-drop'
import type { ProjectHeaderDragBucketKey, ProjectHeaderDragRect } from './project-header-drop'
import type { ProjectHeaderDropTarget } from './project-header-group-drop'

const INDICATOR_GAP_PX = 4
const SUBGROUP_EXIT_TO_PARENT_BAND_PX = 20
const SUBGROUP_EXIT_INTO_NEXT_HEADER_SLOP_PX = 4

function parseParentGroupIdFromGroupBucketKey(bucketKey: string): string | null {
  return bucketKey.startsWith('parent:') ? bucketKey.slice('parent:'.length) : null
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
  currentGroupId: string | null
  currentParentGroupId?: string | null
  joinableGroupIds: ReadonlySet<string>
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects: readonly ProjectHeaderDragRect[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
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

  const targetBucketKey: ProjectHeaderDragBucketKey = `group:${parentGroupId}`
  const parentRepoIds = args.sidebarRepoHeaderIdsByBucket.get(targetBucketKey) ?? []
  return {
    kind: 'slot',
    targetBucketKey,
    dropIndex: parentRepoIds.length,
    dropIndicatorY: Math.max(args.scrollTop, subBottom + 2)
  }
}
