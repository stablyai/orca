import type { Repo } from '../../../../../../shared/repository/repo-types'
import type {
  GroupHeaderRow,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import type { WorktreeSidebarHeaderDrag } from '../drag/use-header-drag'
import {
  getRootProjectHeaderKey,
  getRootProjectHeaderOccurrenceKey
} from '../drag/root-project-header-drop'

/** Which header tier this row can be dragged in, and whether it is the one being dragged. */
export function getSectionHeaderDragState(args: {
  headerDrag: WorktreeSidebarHeaderDrag
  groupBy: WorktreeGroupBy
  row: GroupHeaderRow
  headerRepo: Repo | undefined
  projectIdForHeader: string | undefined
  projectGroupDragIdForHeader: string | undefined
  usesRootProjectDrag: boolean
}) {
  const {
    headerDrag,
    groupBy,
    row,
    headerRepo,
    projectIdForHeader,
    projectGroupDragIdForHeader,
    usesRootProjectDrag
  } = args
  const repoHeaderIndex = headerRepo && headerDrag.repoHeaderIndexByRepoId.get(headerRepo.id)
  const repoHeaderBucketKey = headerRepo && headerDrag.repoHeaderBucketByRepoId.get(headerRepo.id)
  const projectGroupHeaderIndex =
    projectGroupDragIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderIndexByGroupId.get(projectGroupDragIdForHeader)
      : undefined
  const projectGroupHeaderBucketKey =
    projectGroupDragIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderBucketByGroupId.get(projectGroupDragIdForHeader)
      : undefined
  const rootProjectHeaderKey = usesRootProjectDrag ? getRootProjectHeaderKey(row) : undefined
  const rootProjectHeaderCount = rootProjectHeaderKey
    ? (headerDrag.rootProjectHeaderCountByOccurrenceKey.get(
        getRootProjectHeaderOccurrenceKey(rootProjectHeaderKey, row.hostId)
      ) ??
      headerDrag.rootProjectHeaderCountByOccurrenceKey.get(
        getRootProjectHeaderOccurrenceKey(rootProjectHeaderKey)
      ))
    : undefined
  const isDraggableRepoHeader = Boolean(
    headerDrag.canReorderRepoHeaders &&
    projectIdForHeader &&
    repoHeaderBucketKey &&
    (rootProjectHeaderCount !== undefined
      ? rootProjectHeaderCount > 1
      : (headerDrag.sidebarRepoHeaderIdsByBucket.get(repoHeaderBucketKey)?.length ?? 0) > 1)
  )
  const isDraggableProjectGroupHeader = Boolean(
    headerDrag.canReorderProjectGroupHeaders &&
    projectGroupDragIdForHeader &&
    projectGroupHeaderBucketKey &&
    (rootProjectHeaderCount !== undefined
      ? rootProjectHeaderCount > 1
      : (headerDrag.sidebarProjectGroupHeaderIdsByBucket.get(projectGroupHeaderBucketKey)?.length ??
          0) > 1)
  )
  // A tag header's label is the tag's spelling; Untagged has none and is never a tag header.
  const tagLabel = groupBy === 'tag' && row.icon.kind === 'tag' ? row.label : undefined
  const isDraggableTagHeader = headerDrag.canReorderTagHeaders && tagLabel !== undefined
  const isDraggingThisTag = isDraggableTagHeader && headerDrag.tagDrag.state.draggingId === tagLabel
  const isDraggingThis =
    headerDrag.canReorderRepoHeaders &&
    headerDrag.repoDrag.state.draggingRepoId === projectIdForHeader
  const isDraggingThisProjectGroup =
    headerDrag.canReorderProjectGroupHeaders &&
    headerDrag.projectGroupDrag.state.draggingGroupId === projectGroupDragIdForHeader

  return {
    repoHeaderIndex,
    repoHeaderBucketKey,
    projectGroupHeaderIndex,
    projectGroupHeaderBucketKey,
    rootProjectHeaderKey,
    isDraggableRepoHeader,
    isDraggableProjectGroupHeader,
    tagLabel,
    isDraggableTagHeader,
    isDraggingThisTag,
    isDraggingThis,
    isDraggingThisProjectGroup
  }
}
