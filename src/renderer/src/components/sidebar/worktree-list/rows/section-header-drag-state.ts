import type { GroupHeaderRow, WorktreeGroupBy } from '../grouping/row-types'
import { UNTAGGED_GROUP_KEY } from '../grouping/tag-groups'
import type { WorktreeSidebarHeaderDrag } from '../drag/use-header-drag'

/** Which header tier this row can be dragged in, and whether it is the one being dragged. */
export function getSectionHeaderDragState(args: {
  headerDrag: WorktreeSidebarHeaderDrag
  groupBy: WorktreeGroupBy
  row: GroupHeaderRow
  isRepoHeader: boolean
  projectIdForHeader: string | undefined
  projectGroupIdForHeader: string | undefined
}) {
  const { headerDrag, groupBy, row, isRepoHeader, projectIdForHeader, projectGroupIdForHeader } =
    args
  const repoHeaderIndex =
    projectIdForHeader !== undefined
      ? headerDrag.repoHeaderIndexByRepoId.get(projectIdForHeader)
      : undefined
  const repoHeaderBucketKey =
    projectIdForHeader !== undefined
      ? headerDrag.repoHeaderBucketByRepoId.get(projectIdForHeader)
      : undefined
  const projectGroupHeaderIndex =
    projectGroupIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderIndexByGroupId.get(projectGroupIdForHeader)
      : undefined
  const projectGroupHeaderBucketKey =
    projectGroupIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderBucketByGroupId.get(projectGroupIdForHeader)
      : undefined
  const isDraggableRepoHeader = Boolean(
    headerDrag.canReorderRepoHeaders &&
    isRepoHeader &&
    projectIdForHeader &&
    repoHeaderBucketKey &&
    (headerDrag.sidebarRepoHeaderIdsByBucket.get(repoHeaderBucketKey)?.length ?? 0) > 1
  )
  const isDraggableProjectGroupHeader = Boolean(
    headerDrag.canReorderProjectGroupHeaders &&
    projectGroupIdForHeader &&
    projectGroupHeaderBucketKey &&
    (headerDrag.sidebarProjectGroupHeaderIdsByBucket.get(projectGroupHeaderBucketKey)?.length ??
      0) > 1
  )
  const isTagHeader = groupBy === 'tag' && row.key !== UNTAGGED_GROUP_KEY
  const isDraggableTagHeader = headerDrag.canReorderTagHeaders && isTagHeader
  const isDraggingThisTag =
    isDraggableTagHeader && headerDrag.tagDrag.state.draggingId === row.label
  const isDraggingThis =
    headerDrag.canReorderRepoHeaders &&
    headerDrag.repoDrag.state.draggingRepoId !== null &&
    headerDrag.repoDrag.state.draggingRepoId === projectIdForHeader
  const isDraggingThisProjectGroup =
    headerDrag.canReorderProjectGroupHeaders &&
    headerDrag.projectGroupDrag.state.draggingGroupId !== null &&
    headerDrag.projectGroupDrag.state.draggingGroupId === projectGroupIdForHeader

  return {
    repoHeaderIndex,
    repoHeaderBucketKey,
    projectGroupHeaderIndex,
    projectGroupHeaderBucketKey,
    isDraggableRepoHeader,
    isDraggableProjectGroupHeader,
    isTagHeader,
    isDraggableTagHeader,
    isDraggingThisTag,
    isDraggingThis,
    isDraggingThisProjectGroup
  }
}
