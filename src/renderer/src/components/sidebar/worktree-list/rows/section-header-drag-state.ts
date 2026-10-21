import type {
  GroupHeaderRow,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
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
  // A tag header's label is the tag's spelling; Untagged has none and is never a tag header.
  const tagLabel = groupBy === 'tag' && row.icon.kind === 'tag' ? row.label : undefined
  const isTagHeader = tagLabel !== undefined
  const isDraggableTagHeader = headerDrag.canReorderTagHeaders && isTagHeader
  const isDraggingThisTag = isDraggableTagHeader && headerDrag.tagDrag.state.draggingId === tagLabel
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
    tagLabel,
    isDraggableTagHeader,
    isDraggingThisTag,
    isDraggingThis,
    isDraggingThisProjectGroup
  }
}
