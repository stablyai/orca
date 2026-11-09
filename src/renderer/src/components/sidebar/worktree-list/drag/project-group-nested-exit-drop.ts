import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'
import type {
  ProjectGroupHeaderDragBucketKey,
  ProjectGroupHeaderDragRect
} from './project-group-header-drop'

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
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  hostSectionBottom?: number
}): {
  kind: 'slot'
  targetBucketKey: ProjectGroupHeaderDragBucketKey
  dropIndex: number
  dropIndicatorY: number
} | null {
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
  const grandparentBucketKey: ProjectGroupHeaderDragBucketKey = `parent:${grandparentId}`
  const siblingIds = filterProjectGroupIdsByCatalogHost(
    args.sidebarProjectGroupHeaderIdsByBucket.get(grandparentBucketKey) ?? [],
    args.dragHostId,
    args.projectGroupById
  )
  const parentIndex = siblingIds.indexOf(args.currentParentGroupId)
  const dropIndex = parentIndex === -1 ? siblingIds.length : parentIndex + 1
  return {
    kind: 'slot',
    targetBucketKey: grandparentBucketKey,
    dropIndex,
    dropIndicatorY: Math.max(args.scrollTop, parentSectionBottom + INDICATOR_GAP_PX)
  }
}
